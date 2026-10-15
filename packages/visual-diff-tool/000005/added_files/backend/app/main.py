"""
Visual Diff Tool メインAPIサーバー仕様。
画像差分・テキスト差分・Git連携（Obsidian対応）および3D CAD差分（STEP比較・非同期ジョブ）のエンドポイントを提供し、
画像変換・エンコードの並列化、子プロセスでのメッシュ処理、およびGit差分のピンポイント取得により高速化を実現する。
"""

from __future__ import annotations

import concurrent.futures
import difflib
import json
import os
import re
import shutil
import subprocess
import threading
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse
from uuid import uuid4

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .attachments import RETENTION_DAYS, cleanup_expired_attachments, save_attachment
from .alignment import align_to_reference
from .diffing import build_visual_diff, resize_to_match
from .image_io import (
    ConversionError,
    MAX_UPLOAD_BYTES,
    PageRangeError,
    analyze_upload,
    cv_to_pil,
    decode_png,
    encode_png,
    extract_excalidraw_json,
    pil_to_cv,
)
from .mesh_jobs import MeshDiffJobManager, check_3d_availability
from .models import AlignmentInfo, AnalyzeResponse, DiffResponse, ImagePayload, PageInfo, RediffRequest, RediffResponse
from .raster_cache import rasterize_upload_page_cached
from .regions import suggest_anchor_regions
from .result_cache import get_diff_images, store_diff_images


app = FastAPI(title="Visual Diff Tool API", version="0.1.0")
mesh_job_manager = MeshDiffJobManager()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8078",
        "http://127.0.0.1:8078",
        "app://obsidian.md",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DIST_DIR = Path(__file__).resolve().parents[2] / "frontend" / "dist"
ASSETS_DIR = DIST_DIR / "assets"
IMAGE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".bmp",
    ".gif",
    ".tif",
    ".tiff",
    ".svg",
    ".pdf",
    ".excalidraw",
}
STEP_EXTENSIONS = {".step", ".stp"}
EXCALIDRAW_MARKDOWN_SUFFIXES = (".excalidraw.md", "_excalidraw.md")
DEFAULT_TEXT_EXTENSIONS = {".md", ".txt", ".csv", ".json", ".yaml", ".yml"}
MAX_TEXT_BYTES = 5 * 1024 * 1024
MAX_TEXT_DIFF_LINES = 30_000
MAX_INLINE_DIFF_CHARS = 20_000
EXTENSION_RE = re.compile(r"^\.[a-z0-9][a-z0-9._+-]{0,15}$")
EXCALIDRAW_PLUGIN_MARKER_RE = re.compile(r"(?im)^\s*excalidraw-plugin\s*:\s*parsed\s*$")
READ_CHUNK_SIZE = 1024 * 1024
DUBIOUS_OWNERSHIP_RE = re.compile(r"detected dubious ownership in repository at '([^']+)'")
WIKI_LINK_RE = re.compile(r"!?\[\[([^\]]+)\]\]")
MARKDOWN_LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
CAD_CODEBLOCK_RE = re.compile(r"```(?:step|cad|3d|step-viewer|stp)\b([\s\S]*?)```", re.IGNORECASE)
CAD_PATH_PROPERTY_RE = re.compile(r"^\s*(?:path|file|source|model)\s*:\s*([^\r\n#]+)", re.IGNORECASE | re.MULTILINE)
STEP_PROPERTY_RE = re.compile(r"^\s*(?:path|file|source|model|cad|step)\s*:\s*([^\r\n#]+\.(?:step|stp))\b", re.IGNORECASE | re.MULTILINE)
SERVER_SETTINGS_PATH = Path(os.environ.get("VISUAL_DIFF_SETTINGS_PATH", Path(__file__).resolve().parents[1] / ".visual-diff-settings.json"))
MAX_OBSIDIAN_LINKS = 500
MAX_REPORT_BYTES = 50 * 1024 * 1024


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/3d/status")
def get_3d_status() -> dict:
    return check_3d_availability()


@app.post("/api/3d/jobs", status_code=202)
async def create_3d_job(
    file_old: UploadFile = File(...),
    file_new: UploadFile = File(...),
    quality: str = Form("standard"),
    align_mode: str = Form("auto"),
    linear_deflection: float | None = Form(None),
) -> JSONResponse:
    def is_step(fn: str) -> bool:
        ext = Path(fn or "").suffix.lower()
        return ext in (".step", ".stp")

    if not is_step(file_old.filename or "") or not is_step(file_new.filename or ""):
        raise HTTPException(status_code=400, detail="STEPファイル（拡張子 .step または .stp）を指定してください。")

    if quality not in ("coarse", "standard", "fine"):
        raise HTTPException(status_code=400, detail=f"無効な品質設定です: {quality}（coarse / standard / fine）")

    if align_mode not in ("auto", "none", "centroid", "fit"):
        raise HTTPException(status_code=400, detail=f"無効な位置合わせモードです: {align_mode}")

    avail = check_3d_availability()
    if not avail["available"]:
        raise HTTPException(
            status_code=503,
            detail=f"3D差分に必要なライブラリが不足しています: {', '.join(avail['missing'])}。{avail['install_hint']}",
        )

    content_old = await _read_upload_or_413(file_old)
    content_new = await _read_upload_or_413(file_new)
    if not content_old or not content_new:
        raise HTTPException(status_code=400, detail="アップロードされたファイルが空です。")

    job_id = mesh_job_manager.create_job(
        file_old.filename or "old.step",
        content_old,
        file_new.filename or "new.step",
        content_new,
        quality=quality,
        align_mode=align_mode,
        linear_deflection=linear_deflection,
    )
    return JSONResponse(status_code=202, content={"job_id": job_id, "status": "queued"})


@app.get("/api/3d/jobs/{job_id}")
def get_3d_job_status(job_id: str) -> JSONResponse:
    status = mesh_job_manager.get_status(job_id)
    if status is None:
        raise HTTPException(status_code=404, detail="指定された3D差分ジョブが見つかりません。")
    return JSONResponse(status)


@app.get("/api/3d/jobs/{job_id}/mesh/{side}")
def get_3d_job_mesh(job_id: str, side: str):
    if side not in ("old", "new"):
        raise HTTPException(status_code=400, detail="side は 'old' または 'new' を指定してください。")
    status = mesh_job_manager.get_status(job_id)
    if status is None:
        raise HTTPException(status_code=404, detail="指定された3D差分ジョブが見つかりません。")
    if status.get("status") != "done":
        raise HTTPException(status_code=409, detail=f"ジョブが完了していません（現在の状態: {status.get('status')}）。")
    data = mesh_job_manager.get_mesh_binary(job_id, side)
    if data is None:
        raise HTTPException(status_code=404, detail="メッシュデータが存在しません。")
    return Response(content=data, media_type="application/octet-stream")


@app.delete("/api/3d/jobs/{job_id}")
def delete_3d_job(job_id: str) -> JSONResponse:
    deleted = mesh_job_manager.delete_job(job_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="指定された3D差分ジョブが見つかりません。")
    return JSONResponse({"status": "deleted"})


STEP_SAMPLE_DEFINITIONS = [
    {"id": "hole_position", "title": "穴位置の変更 (φ12穴 x=30 → x=60)"},
    {"id": "dimension", "title": "寸法の変更 (ブロック長さ 80 → 90)"},
    {"id": "added_boss", "title": "ボスの追加 (φ20x15 円柱)"},
    {"id": "moved_rotated", "title": "位置・向きズレのみ (同一形状・回転35°/15°補正・差分0%)"},
    {"id": "moved_rotated_diff", "title": "位置ズレ＋形状変更 (回転35°/15°補正＋縦壁に穴追加)"},
    {"id": "unit_inch", "title": "単位不一致 (ミリ vs インチ段付き軸)"},
]
STEP_SAMPLES_DIR = Path(__file__).resolve().parents[2] / "samples" / "step"


@app.get("/api/3d/samples")
def get_3d_samples() -> list[dict]:
    return [
        item for item in STEP_SAMPLE_DEFINITIONS
        if (STEP_SAMPLES_DIR / f"{item['id']}_a.step").exists() and (STEP_SAMPLES_DIR / f"{item['id']}_b.step").exists()
    ]


@app.post("/api/3d/samples/load", status_code=202)
def load_3d_sample(payload: dict) -> JSONResponse:
    sample_id = str(payload.get("sample_id", ""))
    quality = str(payload.get("quality", "standard"))
    align_mode = str(payload.get("align_mode", "auto"))

    path_a = STEP_SAMPLES_DIR / f"{sample_id}_a.step"
    path_b = STEP_SAMPLES_DIR / f"{sample_id}_b.step"
    if not path_a.exists() or not path_b.exists():
        raise HTTPException(status_code=404, detail=f"サンプル '{sample_id}' が見つかりません。")

    avail = check_3d_availability()
    if not avail["available"]:
        raise HTTPException(
            status_code=503,
            detail=f"3D差分に必要なライブラリが不足しています: {', '.join(avail['missing'])}。{avail['install_hint']}",
        )

    content_old = path_a.read_bytes()
    content_new = path_b.read_bytes()
    job_id = mesh_job_manager.create_job(
        f"{sample_id}_a.step",
        content_old,
        f"{sample_id}_b.step",
        content_new,
        quality=quality,
        align_mode=align_mode,
    )
    return JSONResponse(status_code=202, content={"job_id": job_id, "status": "queued"})


@app.post("/api/attachments")
async def upload_attachment(file: UploadFile = File(...)) -> JSONResponse:
    content = await _read_upload_or_413(file)
    if not content:
        raise HTTPException(status_code=400, detail="Attachment is empty")
    deleted_expired = cleanup_expired_attachments()
    path = save_attachment(file.filename or "clipboard.png", content)
    return JSONResponse(
        {
            "filename": file.filename or "clipboard.png",
            "stored_as": path.name,
            "size": len(content),
            "retention_days": RETENTION_DAYS,
            "deleted_expired": deleted_expired,
        }
    )


@app.post("/api/analyze", response_model=AnalyzeResponse)
async def analyze(file: UploadFile = File(...)) -> AnalyzeResponse:
    content = await _read_upload_or_413(file)
    fmt, pages = _analyze_or_400(file.filename or "upload", content)
    warnings = _page_warnings(pages)
    return AnalyzeResponse(
        filename=file.filename or "upload",
        format=fmt,
        page_count=len(pages),
        pages=[PageInfo(index=page.index, width=page.width, height=page.height, warnings=list(page.warnings)) for page in pages],
        warnings=warnings,
    )


@app.post("/api/convert")
async def convert(file: UploadFile = File(...), page: int = Form(0)) -> JSONResponse:
    content = await _read_upload_or_413(file)
    fmt, selected = _convert_page_or_400(file.filename or "upload", content, page)
    return JSONResponse(
        {
            "filename": file.filename,
            "format": fmt,
            "page": selected.index,
            "width": selected.image.width,
            "height": selected.image.height,
            "image": {"mime_type": "image/png", "data": encode_png(selected.image)},
            "regions": suggest_anchor_regions(pil_to_cv(selected.image)),
            "warnings": list(selected.warnings),
        }
    )


@app.post("/api/diff", response_model=DiffResponse)
async def diff(
    background_tasks: BackgroundTasks,
    request: Request,
    file_a: UploadFile = File(...),
    file_b: UploadFile = File(...),
    page_a: int = Form(0),
    page_b: int = Form(0),
    category: str = Form("汎用"),
    diff_threshold: float = Form(0.1),
    anchor_region: str | None = Form(None),
) -> DiffResponse:
    content_a = await _read_upload_or_413(file_a)
    content_b = await _read_upload_or_413(file_b)
    _, raster_a = _convert_page_or_400(file_a.filename or "a", content_a, page_a)
    _, raster_b = _convert_page_or_400(file_b.filename or "b", content_b, page_b)

    image_a = pil_to_cv(raster_a.image)
    image_b = pil_to_cv(raster_b.image)
    alignment = align_to_reference(image_a, image_b, category=category, anchor_region=_parse_anchor_region(anchor_region))
    comparison_a = alignment.reference_image if alignment.reference_image is not None else image_a
    comparison_a = resize_to_match(alignment.image, comparison_a)
    comparison_b = resize_to_match(comparison_a, alignment.image)
    diff_result = build_visual_diff(comparison_a, comparison_b, threshold=diff_threshold)
    filename_a = file_a.filename or "a"
    filename_b = file_b.filename or "b"
    result_id = store_diff_images(
        comparison_a,
        comparison_b,
        filename_a=filename_a,
        filename_b=filename_b,
        page_a=raster_a.index,
        page_b=raster_b.index,
        category=category,
    )
    _schedule_open_result(background_tasks, request, result_id)

    return DiffResponse(
        result_id=result_id,
        filename_a=filename_a,
        filename_b=filename_b,
        page_a=raster_a.index,
        page_b=raster_b.index,
        category=category,
        width=comparison_a.shape[1],
        height=comparison_a.shape[0],
        alignment=AlignmentInfo(
            success=alignment.success,
            method=alignment.method,
            warning=alignment.warning,
            matches=alignment.matches,
            inliers=alignment.inliers,
            matrix=alignment.matrix,
        ),
        image_a=ImagePayload(data=encode_png(cv_to_pil(comparison_a))),
        image_a_original=ImagePayload(data=encode_png(cv_to_pil(image_a))),
        image_b_original=ImagePayload(data=encode_png(cv_to_pil(image_b))),
        image_b_aligned=ImagePayload(data=encode_png(cv_to_pil(comparison_b))),
        overlay=ImagePayload(data=encode_png(cv_to_pil(diff_result["overlay"]))),
        mask=ImagePayload(data=encode_png(cv_to_pil(diff_result["mask"]))),
        diff_rects=diff_result["rects"],
        diff_pixels=diff_result["diff_pixels"],
        diff_ratio=diff_result["diff_ratio"],
        diff_threshold=diff_result["threshold"],
        conversion_warnings=_page_warnings([raster_a, raster_b]),
    )


@app.post("/api/rediff", response_model=RediffResponse)
async def rediff(payload: RediffRequest) -> RediffResponse:
    result_id = payload.result_id
    if payload.result_id:
        cached = get_diff_images(payload.result_id)
        if cached:
            image_a = cached.image_a
            image_b_aligned = cached.image_b_aligned
        elif payload.image_a is None or payload.image_b_aligned is None:
            raise HTTPException(status_code=404, detail="Diff result cache expired")
        else:
            image_a, image_b_aligned = _decode_rediff_images(payload)
            result_id = store_diff_images(image_a, image_b_aligned)
    else:
        image_a, image_b_aligned = _decode_rediff_images(payload)
        result_id = store_diff_images(image_a, image_b_aligned)
    diff_result = build_visual_diff(image_a, image_b_aligned, threshold=payload.diff_threshold)
    return RediffResponse(
        result_id=result_id,
        overlay=ImagePayload(data=encode_png(cv_to_pil(diff_result["overlay"]))),
        mask=ImagePayload(data=encode_png(cv_to_pil(diff_result["mask"]))),
        diff_rects=diff_result["rects"],
        diff_pixels=diff_result["diff_pixels"],
        diff_ratio=diff_result["diff_ratio"],
        diff_threshold=diff_result["threshold"],
    )


@app.get("/api/diff/{result_id}", response_model=DiffResponse)
async def get_diff_result(result_id: str, diff_threshold: float = 0.1) -> DiffResponse:
    cached = get_diff_images(result_id)
    if not cached:
        raise HTTPException(status_code=404, detail="Diff result cache expired")
    return _build_cached_diff_response(result_id, cached, diff_threshold)


@app.get("/api/settings/obsidian")
def get_obsidian_settings() -> JSONResponse:
    settings = _load_server_settings()
    return JSONResponse(
        {
            "obsidian_folder": settings.get("obsidian_folder", ""),
            "obsidian_report_folder": settings.get("obsidian_report_folder", ""),
        }
    )


@app.put("/api/settings/obsidian")
def update_obsidian_settings(payload: dict) -> JSONResponse:
    settings = _load_server_settings()
    raw_folder = (
        _validated_directory_setting(payload.get("obsidian_folder"), "Obsidianフォルダー")
        if "obsidian_folder" in payload
        else str(settings.get("obsidian_folder") or "")
    )
    raw_report_folder = (
        _validated_directory_setting(payload.get("obsidian_report_folder"), "Obsidianレポート保存先")
        if "obsidian_report_folder" in payload
        else str(settings.get("obsidian_report_folder") or "")
    )
    settings["obsidian_folder"] = raw_folder
    settings["obsidian_report_folder"] = raw_report_folder
    _save_server_settings(settings)
    return JSONResponse({"obsidian_folder": raw_folder, "obsidian_report_folder": raw_report_folder})


@app.post("/api/reports/save")
def save_report(payload: dict) -> JSONResponse:
    html = str(payload.get("html") or "")
    if not html:
        raise HTTPException(status_code=422, detail="html is required")
    if len(html.encode("utf-8")) > MAX_REPORT_BYTES:
        raise HTTPException(status_code=413, detail="HTML report is too large")

    settings = _load_server_settings()
    # The destination is an administrator/user configured server setting. Do not
    # accept a per-request override, otherwise any page able to call the local API
    # could write a report into an arbitrary existing directory.
    raw_folder = str(settings.get("obsidian_report_folder") or "").strip()
    if not raw_folder:
        raise HTTPException(status_code=422, detail="Obsidianレポート保存先が未設定です")
    folder = _validated_directory_setting(raw_folder, "Obsidianレポート保存先", required=True)
    filename = Path(str(payload.get("filename") or "差分レポート.html")).name.strip()
    if not filename:
        filename = "差分レポート.html"
    if not filename.lower().endswith(".html"):
        filename = f"{filename}.html"
    destination = Path(folder) / filename
    temporary = destination.with_name(f".{destination.name}.{uuid4().hex}.tmp")
    try:
        temporary.write_text(html, encoding="utf-8")
        temporary.replace(destination)
    except OSError as exc:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise HTTPException(status_code=500, detail="HTMLレポートを保存できませんでした") from exc
    return JSONResponse({"filename": filename, "path": str(destination), "size": len(html.encode("utf-8"))})


@app.post("/api/git/images")
def git_images(payload: dict) -> JSONResponse:
    folder, source_markdown = _payload_git_scope(payload)
    repo = _git_repo_root(folder)
    if source_markdown:
        related_paths = _related_paths_for_markdown(repo, source_markdown)
        files = _changed_image_files(repo, repo, specific_paths=related_paths)
    else:
        files = _changed_image_files(repo, folder)
    return JSONResponse(
        {
            "folder": str(folder),
            "repo_root": str(repo),
            "source_markdown": source_markdown,
            "files": files,
        }
    )


@app.post("/api/git/files")
def git_files(payload: dict) -> JSONResponse:
    folder, source_markdown = _payload_git_scope(payload)
    repo = _git_repo_root(folder)
    text_extensions = _text_extensions_from_payload(payload)
    if source_markdown:
        related_paths = _related_paths_for_markdown(repo, source_markdown)
        files = _changed_files(repo, repo, text_extensions, specific_paths=related_paths)
    else:
        files = _changed_files(repo, folder, text_extensions)
    return JSONResponse(
        {
            "folder": str(folder),
            "repo_root": str(repo),
            "text_extensions": sorted(text_extensions),
            "source_markdown": source_markdown,
            "files": files,
        }
    )


@app.post("/api/git/markdown")
def git_markdown_diff(payload: dict, request: Request) -> JSONResponse:
    """Create a deep link for an Obsidian Markdown-rooted Git diff.

    Obsidian integrations can call this endpoint with the active note path,
    then open ``diff_url``. The web UI consumes the same path and loads the
    Markdown diff plus all changed files reachable from its links.
    """
    raw_markdown = str(
        payload.get("markdown_path")
        or payload.get("markdown_file")
        or payload.get("path")
        or payload.get("folder")
        or ""
    ).strip()
    if not raw_markdown:
        raise HTTPException(status_code=422, detail="markdown_path is required")
    folder, source_markdown = _payload_git_scope({"folder": raw_markdown})
    if not source_markdown:
        raise HTTPException(status_code=422, detail="markdown_path must point to a Markdown file")
    repo = _git_repo_root(folder)
    text_extensions = _text_extensions_from_payload(payload)
    related_paths = _related_paths_for_markdown(repo, source_markdown)
    files = _changed_files(repo, repo, text_extensions, specific_paths=related_paths)
    return JSONResponse(
        {
            "folder": str(folder),
            "repo_root": str(repo),
            "source_markdown": source_markdown,
            "text_extensions": sorted(text_extensions),
            "files": files,
            "diff_url": f"{str(request.base_url).rstrip('/')}/?markdown_path={quote(source_markdown, safe='')}",
        }
    )


@app.get("/api/git/markdown")
def get_git_markdown_diff(request: Request, path: str | None = None, markdown_path: str | None = None) -> JSONResponse:
    """GET convenience form for integrations that only have a note path."""
    return git_markdown_diff({"markdown_path": markdown_path or path or ""}, request)


@app.post("/api/git/item")
def git_item(payload: dict) -> JSONResponse:
    folder = _payload_folder(payload)
    repo = _git_repo_root(folder)
    path = str(payload.get("path") or "")
    if not path:
        raise HTTPException(status_code=422, detail="path is required")
    rel_path = _safe_git_path(repo, path, restrict_to_images=False)
    head_path = str(payload.get("head_path") or path)
    head_rel_path = _safe_git_path(repo, head_path, restrict_to_images=False)
    text_extensions = _text_extensions_from_payload(payload)
    kind = _git_file_kind(rel_path, text_extensions)
    if kind is None:
        raise HTTPException(status_code=422, detail="path extension is not enabled")

    has_head = bool(payload.get("has_head", True))
    has_current = bool(payload.get("has_current", True))
    max_bytes = MAX_UPLOAD_BYTES if kind in ("image", "3d") else MAX_TEXT_BYTES
    previous = _git_show(repo, head_rel_path, max_bytes=max_bytes) if has_head else None
    current_path = repo / rel_path
    current = None
    if has_current:
        if not current_path.exists() or not current_path.is_file():
            raise HTTPException(status_code=404, detail=f"Current file not found: {rel_path}")
        current = _read_file_limited(current_path, max_bytes, rel_path)

    response: dict = {"path": rel_path, "head_path": head_rel_path, "kind": kind}
    if kind == "image":
        response["image_head"] = _git_preview_payload(head_rel_path, previous) if previous is not None else None
        response["image_current"] = _git_preview_payload(rel_path, current) if current is not None else None
    elif kind == "3d":
        response["step_available"] = True
        response["has_head"] = has_head and previous is not None
        response["has_current"] = has_current and current is not None
    else:
        old_text, old_encoding = _decode_git_text(previous) if previous is not None else ("", None)
        new_text, new_encoding = _decode_git_text(current) if current is not None else ("", None)
        response.update({"encoding_head": old_encoding, "encoding_current": new_encoding, "rows": _build_markdown_text_diff_rows(old_text, new_text)})
        if payload.get("include_text", True):
            response.update({"text_head": old_text, "text_current": new_text})
    return JSONResponse(response)


@app.post("/api/git/3d/jobs", status_code=202)
def create_git_3d_job(payload: dict) -> JSONResponse:
    """Git管理下のSTEPファイル（HEAD vs 作業ツリー）から3D差分ジョブを作成する。"""
    folder = _payload_folder(payload)
    repo = _git_repo_root(folder)
    path = str(payload.get("path") or "")
    if not path:
        raise HTTPException(status_code=422, detail="path is required")
    rel_path = _safe_git_path(repo, path, restrict_to_images=False)
    head_path = str(payload.get("head_path") or path)
    head_rel_path = _safe_git_path(repo, head_path, restrict_to_images=False)

    if not _is_git_3d_path(rel_path):
        raise HTTPException(status_code=400, detail="STEPファイル（拡張子 .step または .stp）を指定してください。")

    quality = str(payload.get("quality") or "standard")
    if quality not in ("coarse", "standard", "fine"):
        raise HTTPException(status_code=400, detail=f"無効な品質設定です: {quality}")

    align_mode = str(payload.get("align_mode") or "auto")
    if align_mode not in ("auto", "none", "centroid", "fit"):
        raise HTTPException(status_code=400, detail=f"無効な位置合わせモードです: {align_mode}")

    avail = check_3d_availability()
    if not avail["available"]:
        raise HTTPException(
            status_code=503,
            detail=f"3D差分に必要なライブラリが不足しています: {', '.join(avail['missing'])}。{avail['install_hint']}",
        )

    has_head = bool(payload.get("has_head", True))
    has_current = bool(payload.get("has_current", True))

    content_old = b""
    if has_head:
        try:
            content_old = _git_show(repo, head_rel_path, max_bytes=MAX_UPLOAD_BYTES)
        except HTTPException:
            content_old = b""

    content_new = b""
    if has_current:
        current_path = repo / rel_path
        if current_path.exists() and current_path.is_file():
            content_new = _read_file_limited(current_path, MAX_UPLOAD_BYTES, rel_path)

    if not content_old and not content_new:
        raise HTTPException(status_code=404, detail="HEAD側にも作業ツリー側にもSTEPファイルが見つかりません。")

    job_id = mesh_job_manager.create_job(
        f"HEAD_{Path(head_rel_path).name}" if content_old else "",
        content_old,
        Path(rel_path).name if content_new else "",
        content_new,
        quality=quality,
        align_mode=align_mode,
    )
    return JSONResponse({"job_id": job_id, "status": "pending"}, status_code=202)


@app.post("/api/git/text-diff")
def git_text_diff(payload: dict) -> JSONResponse:
    """Build a preview diff for an edited working-tree text value."""
    folder = _payload_folder(payload)
    repo = _git_repo_root(folder)
    rel_path = _safe_git_path(repo, str(payload.get("path") or ""), restrict_to_images=False)
    head_rel_path = _safe_git_path(repo, str(payload.get("head_path") or rel_path), restrict_to_images=False)
    text_extensions = _text_extensions_from_payload(payload)
    if _git_file_kind(rel_path, text_extensions) != "text":
        raise HTTPException(status_code=422, detail="Only enabled text files can be previewed")
    has_head = bool(payload.get("has_head", True))
    previous = _git_show(repo, head_rel_path, max_bytes=MAX_TEXT_BYTES) if has_head else None
    old_text, _ = _decode_git_text(previous) if previous is not None else ("", "utf-8")
    new_text = str(payload.get("text") or "")
    return JSONResponse({"path": rel_path, "rows": _build_markdown_text_diff_rows(old_text, new_text), "text_current": new_text})


@app.post("/api/git/save-text")
def save_git_text(payload: dict) -> JSONResponse:
    """Save an edited text draft back to the working-tree file."""
    folder = _payload_folder(payload)
    repo = _git_repo_root(folder)
    rel_path = _safe_git_path(repo, str(payload.get("path") or ""), restrict_to_images=False)
    head_rel_path = _safe_git_path(repo, str(payload.get("head_path") or rel_path), restrict_to_images=False)
    text_extensions = _text_extensions_from_payload(payload)
    if _git_file_kind(rel_path, text_extensions) != "text":
        raise HTTPException(status_code=422, detail="Only enabled text files can be saved")
    current_path = repo / rel_path
    if not current_path.is_file():
        raise HTTPException(status_code=404, detail=f"Current file not found: {rel_path}")

    current_bytes = _read_file_limited(current_path, MAX_TEXT_BYTES, rel_path)
    current_text, current_encoding = _decode_git_text(current_bytes)
    normalized_current_text = current_text.replace("\r\n", "\n").replace("\r", "\n")
    base_text = payload.get("base_text")
    if isinstance(base_text, str) and normalized_current_text != base_text:
        raise HTTPException(status_code=409, detail="The file changed outside this editor. Reload the preview before saving")
    edited_text = str(payload.get("text") or "")
    newline = "\r\n" if b"\r\n" in current_bytes else "\n"
    normalized_text = edited_text.replace("\r\n", "\n").replace("\r", "\n")
    serialized_text = normalized_text.replace("\n", newline)
    encoding = "cp932" if current_encoding == "cp932" else "utf-8-sig" if current_encoding == "utf-8-sig" else "utf-8"
    try:
        saved_bytes = serialized_text.encode(encoding)
    except UnicodeEncodeError as exc:
        raise HTTPException(status_code=422, detail=f"Edited text cannot be encoded as {encoding}") from exc

    temporary = current_path.with_name(f".{current_path.name}.visual-diff-{uuid4().hex}.tmp")
    try:
        temporary.write_bytes(saved_bytes)
        temporary.replace(current_path)
    except OSError as exc:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise HTTPException(status_code=500, detail="Could not save the working-tree file") from exc

    old_bytes = _git_show(repo, head_rel_path, max_bytes=MAX_TEXT_BYTES) if bool(payload.get("has_head", True)) else None
    old_text, _ = _decode_git_text(old_bytes) if old_bytes is not None else ("", "utf-8")
    return JSONResponse(
        {
            "path": rel_path,
            "text_current": normalized_text,
            "rows": _build_markdown_text_diff_rows(old_text, normalized_text),
            "encoding_current": current_encoding,
        }
    )


@app.post("/api/git/revert-line")
def git_revert_line(payload: dict) -> JSONResponse:
    """Restore one displayed working-tree diff row to its HEAD value."""
    folder = _payload_folder(payload)
    repo = _git_repo_root(folder)
    rel_path = _safe_git_path(repo, str(payload.get("path") or ""), restrict_to_images=False)
    head_rel_path = _safe_git_path(repo, str(payload.get("head_path") or rel_path), restrict_to_images=False)
    text_extensions = _text_extensions_from_payload(payload)
    if _git_file_kind(rel_path, text_extensions) != "text":
        raise HTTPException(status_code=422, detail="Only enabled text files can be restored by line")
    current_path = repo / rel_path
    if not current_path.is_file():
        raise HTTPException(status_code=404, detail=f"Current file not found: {rel_path}")

    old_text, _ = _decode_git_text(_git_show(repo, head_rel_path, max_bytes=MAX_TEXT_BYTES))
    current_bytes = _read_file_limited(current_path, MAX_TEXT_BYTES, rel_path)
    new_text, current_encoding = _decode_git_text(current_bytes)
    requested = payload.get("row")
    if not isinstance(requested, dict) or requested.get("kind") not in {"replace", "insert", "delete"}:
        raise HTTPException(status_code=422, detail="A changed diff row is required")
    requested_old_index = requested.get("old_index")
    requested_new_index = requested.get("new_index")
    if (
        not isinstance(requested_old_index, int)
        or isinstance(requested_old_index, bool)
        or not isinstance(requested_new_index, int)
        or isinstance(requested_new_index, bool)
    ):
        raise HTTPException(status_code=422, detail="Diff row indexes are required")

    candidates = [
        row for row in _build_markdown_text_diff_rows(old_text, new_text)
        if row.get("kind") == requested.get("kind")
        and row.get("old") == requested.get("old")
        and row.get("new") == requested.get("new")
        and row.get("old_index") == requested_old_index
        and row.get("new_index") == requested_new_index
    ]
    if not candidates:
        raise HTTPException(status_code=409, detail="The file changed after the preview. Reload the preview and try again")
    row = candidates[0]
    lines = new_text.splitlines()
    index = int(row["new_index"])
    if row["kind"] == "insert":
        if index >= len(lines):
            raise HTTPException(status_code=409, detail="The target line no longer exists")
        lines.pop(index)
    elif row["kind"] == "delete":
        lines.insert(min(index, len(lines)), str(row.get("old") or ""))
    else:
        if index >= len(lines):
            raise HTTPException(status_code=409, detail="The target line no longer exists")
        lines[index] = str(row.get("old") or "")

    newline = "\r\n" if b"\r\n" in current_bytes else "\n"
    restored_text = newline.join(lines)
    if new_text.endswith(("\n", "\r")):
        restored_text += newline
    encoding = "cp932" if current_encoding == "cp932" else "utf-8-sig" if current_encoding == "utf-8-sig" else "utf-8"
    try:
        restored_bytes = restored_text.encode(encoding)
    except UnicodeEncodeError as exc:
        raise HTTPException(status_code=422, detail=f"Restored text cannot be encoded as {encoding}") from exc
    temporary = current_path.with_name(f".{current_path.name}.visual-diff-{uuid4().hex}.tmp")
    try:
        temporary.write_bytes(restored_bytes)
        temporary.replace(current_path)
    except OSError as exc:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise HTTPException(status_code=500, detail="Could not update the working-tree file") from exc
    return JSONResponse({"path": rel_path, "rows": _build_markdown_text_diff_rows(old_text, restored_text)})


@app.post("/api/git/diff", response_model=DiffResponse)
def git_diff(payload: dict) -> DiffResponse:
    folder = _payload_folder(payload)
    repo = _git_repo_root(folder)
    path = str(payload.get("path") or "")
    if not path:
        raise HTTPException(status_code=422, detail="path is required")
    subresource = str(payload.get("subresource") or "").strip().lower()
    if subresource == "excalidraw":
        rel_path = _safe_git_path(repo, path, restrict_to_images=False)
        if not rel_path.lower().endswith(".md"):
            raise HTTPException(status_code=422, detail="Excalidraw subresource requires a Markdown file")
        current_path = repo / rel_path
        if not current_path.exists() or not current_path.is_file():
            raise HTTPException(status_code=404, detail=f"Current file not found: {rel_path}")
        head_path = str(payload.get("head_path") or path)
        head_rel_path = _safe_git_path(repo, head_path, restrict_to_images=False)
        previous = _git_show(repo, head_rel_path, max_bytes=MAX_TEXT_BYTES)
        current = _read_file_limited(current_path, MAX_TEXT_BYTES, rel_path)
        return _build_diff_response(
            filename_a=f"HEAD:{head_rel_path}.excalidraw",
            content_a=_embedded_excalidraw_json_bytes(previous),
            filename_b=f"{rel_path}.excalidraw",
            content_b=_embedded_excalidraw_json_bytes(current),
            category=str(payload.get("category") or "図面"),
            diff_threshold=float(payload.get("diff_threshold") or 0.1),
        )

    rel_path = _safe_git_path(repo, path)
    head_path = str(payload.get("head_path") or path)
    head_rel_path = _safe_git_path(repo, head_path)
    current_path = repo / rel_path
    if not current_path.exists() or not current_path.is_file():
        raise HTTPException(status_code=404, detail=f"Current file not found: {rel_path}")
    previous = _git_show(repo, head_rel_path, max_bytes=MAX_UPLOAD_BYTES)
    current = _read_file_limited(current_path, MAX_UPLOAD_BYTES, rel_path)
    return _build_diff_response(
        filename_a=f"HEAD:{head_rel_path}",
        content_a=previous,
        filename_b=rel_path,
        content_b=current,
        category=str(payload.get("category") or "汎用"),
        diff_threshold=float(payload.get("diff_threshold") or 0.1),
    )


def _decode_rediff_images(payload: RediffRequest):
    if payload.image_a is None or payload.image_b_aligned is None:
        raise HTTPException(status_code=422, detail="result_id or both diff images are required")
    try:
        return pil_to_cv(decode_png(payload.image_a.data)), pil_to_cv(decode_png(payload.image_b_aligned.data))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not read diff images: {exc}") from exc


async def _read_upload_or_413(file: UploadFile) -> bytes:
    chunks = []
    total = 0
    while True:
        chunk = await file.read(READ_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            limit_mb = MAX_UPLOAD_BYTES / (1024 * 1024)
            raise HTTPException(status_code=413, detail=f"Upload is too large; limit is {limit_mb:.0f} MB per file")
        chunks.append(chunk)
    return b"".join(chunks)


def _analyze_or_400(filename: str, content: bytes):
    try:
        return analyze_upload(filename, content)
    except PageRangeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ConversionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not read {filename}: {exc}") from exc


def _convert_page_or_400(filename: str, content: bytes, page: int):
    try:
        return rasterize_upload_page_cached(filename, content, page=page)
    except PageRangeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ConversionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not read {filename}: {exc}") from exc


def _page_warnings(pages) -> list[str]:
    warnings = []
    for page in pages:
        for warning in getattr(page, "warnings", ()):
            if warning not in warnings:
                warnings.append(warning)
    return warnings


def _parse_anchor_region(anchor_region: str | None) -> dict | None:
    if not anchor_region:
        return None
    try:
        value = json.loads(anchor_region)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="anchor_region must be JSON") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="anchor_region must be an object")
    return value


def _build_diff_response(
    *,
    filename_a: str,
    content_a: bytes,
    filename_b: str,
    content_b: bytes,
    category: str,
    diff_threshold: float,
) -> DiffResponse:
    # 画像Aと画像Bの変換・ラスタライズを並列実行
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        future_a = executor.submit(_convert_page_or_400, filename_a, content_a, 0)
        future_b = executor.submit(_convert_page_or_400, filename_b, content_b, 0)
        _, raster_a = future_a.result()
        _, raster_b = future_b.result()

    image_a = pil_to_cv(raster_a.image)
    image_b = pil_to_cv(raster_b.image)
    alignment = align_to_reference(image_a, image_b, category=category, anchor_region=None)
    comparison_a = alignment.reference_image if alignment.reference_image is not None else image_a
    comparison_a = resize_to_match(alignment.image, comparison_a)
    comparison_b = resize_to_match(comparison_a, alignment.image)
    diff_result = build_visual_diff(comparison_a, comparison_b, threshold=diff_threshold)
    result_id = store_diff_images(
        comparison_a,
        comparison_b,
        filename_a=filename_a,
        filename_b=filename_b,
        page_a=raster_a.index,
        page_b=raster_b.index,
        category=category,
    )

    # 6枚のPNGエンコード（圧縮）をスレッド並列実行してレスポンス生成を高速化
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        f_comp_a = executor.submit(encode_png, cv_to_pil(comparison_a))
        f_orig_a = executor.submit(encode_png, cv_to_pil(image_a))
        f_orig_b = executor.submit(encode_png, cv_to_pil(image_b))
        f_comp_b = executor.submit(encode_png, cv_to_pil(comparison_b))
        f_overlay = executor.submit(encode_png, cv_to_pil(diff_result["overlay"]))
        f_mask = executor.submit(encode_png, cv_to_pil(diff_result["mask"]))

        encoded_comp_a = f_comp_a.result()
        encoded_orig_a = f_orig_a.result()
        encoded_orig_b = f_orig_b.result()
        encoded_comp_b = f_comp_b.result()
        encoded_overlay = f_overlay.result()
        encoded_mask = f_mask.result()

    return DiffResponse(
        result_id=result_id,
        filename_a=filename_a,
        filename_b=filename_b,
        page_a=raster_a.index,
        page_b=raster_b.index,
        category=category,
        width=comparison_a.shape[1],
        height=comparison_a.shape[0],
        alignment=AlignmentInfo(
            success=alignment.success,
            method=alignment.method,
            warning=alignment.warning,
            matches=alignment.matches,
            inliers=alignment.inliers,
            matrix=alignment.matrix,
        ),
        image_a=ImagePayload(data=encoded_comp_a),
        image_a_original=ImagePayload(data=encoded_orig_a),
        image_b_original=ImagePayload(data=encoded_orig_b),
        image_b_aligned=ImagePayload(data=encoded_comp_b),
        overlay=ImagePayload(data=encoded_overlay),
        mask=ImagePayload(data=encoded_mask),
        diff_rects=diff_result["rects"],
        diff_pixels=diff_result["diff_pixels"],
        diff_ratio=diff_result["diff_ratio"],
        diff_threshold=diff_result["threshold"],
        conversion_warnings=_page_warnings([raster_a, raster_b]),
    )


def _build_cached_diff_response(result_id: str, cached, diff_threshold: float) -> DiffResponse:
    comparison_a = resize_to_match(cached.image_b_aligned, cached.image_a)
    comparison_b = resize_to_match(comparison_a, cached.image_b_aligned)
    diff_result = build_visual_diff(comparison_a, comparison_b, threshold=diff_threshold)
    return DiffResponse(
        result_id=result_id,
        filename_a=cached.filename_a,
        filename_b=cached.filename_b,
        page_a=cached.page_a,
        page_b=cached.page_b,
        category=cached.category,
        width=comparison_a.shape[1],
        height=comparison_a.shape[0],
        alignment=AlignmentInfo(
            success=True,
            method="cached",
            warning=None,
            matches=0,
            inliers=0,
            matrix=None,
        ),
        image_a=ImagePayload(data=encode_png(cv_to_pil(comparison_a))),
        image_a_original=ImagePayload(data=encode_png(cv_to_pil(comparison_a))),
        image_b_original=ImagePayload(data=encode_png(cv_to_pil(comparison_b))),
        image_b_aligned=ImagePayload(data=encode_png(cv_to_pil(comparison_b))),
        overlay=ImagePayload(data=encode_png(cv_to_pil(diff_result["overlay"]))),
        mask=ImagePayload(data=encode_png(cv_to_pil(diff_result["mask"]))),
        diff_rects=diff_result["rects"],
        diff_pixels=diff_result["diff_pixels"],
        diff_ratio=diff_result["diff_ratio"],
        diff_threshold=diff_result["threshold"],
        conversion_warnings=[],
    )


def _schedule_open_result(background_tasks: BackgroundTasks, request: Request, result_id: str | None) -> None:
    if not result_id:
        return
    if os.environ.get("VISUAL_DIFF_OPEN_BROWSER", "1").lower() in {"0", "false", "no"}:
        return
    if request.url.hostname not in {"127.0.0.1", "localhost"}:
        return
    url = str(request.base_url.include_query_params(result_id=result_id))
    background_tasks.add_task(_open_browser, url)


def _open_browser(url: str) -> None:
    try:
        webbrowser.open(url, new=2, autoraise=True)
    except Exception:
        pass


def _payload_folder(payload: dict) -> Path:
    folder, _ = _payload_git_scope(payload)
    return folder


def _payload_git_scope(payload: dict) -> tuple[Path, str | None]:
    raw_folder = str(payload.get("folder") or "").strip()
    if not raw_folder:
        raise HTTPException(status_code=422, detail="folder is required")
    folder = Path(raw_folder).expanduser()
    try:
        folder = folder.resolve(strict=True)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Folder or Markdown file not found") from exc
    if folder.is_dir():
        return folder, None
    if folder.is_file() and folder.suffix.lower() == ".md":
        return folder.parent, str(folder)
    raise HTTPException(status_code=422, detail="folder must be a directory or a Markdown file")


def _validated_directory_setting(value: object, label: str, *, required: bool = False) -> str:
    raw_value = str(value or "").strip()
    if not raw_value:
        if required:
            raise HTTPException(status_code=422, detail=f"{label}が未設定です")
        return ""
    folder = Path(raw_value).expanduser()
    try:
        folder = folder.resolve(strict=True)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=422, detail=f"{label}が見つかりません") from exc
    if not folder.is_dir():
        raise HTTPException(status_code=422, detail=f"{label}はディレクトリを指定してください")
    return str(folder)


def _load_server_settings() -> dict:
    try:
        value = json.loads(SERVER_SETTINGS_PATH.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}


def _save_server_settings(settings: dict) -> None:
    SERVER_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = SERVER_SETTINGS_PATH.with_suffix(f"{SERVER_SETTINGS_PATH.suffix}.tmp")
    temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(SERVER_SETTINGS_PATH)


def _related_paths_for_markdown(repo: Path, source_markdown: str) -> set[str]:
    source_path = Path(source_markdown).resolve()
    try:
        source_rel = source_path.relative_to(repo).as_posix()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Markdown file must be inside the git repository") from exc
    return _related_markdown_paths(repo, source_rel)


def _filter_related_git_files(repo: Path, files: list[dict], source_markdown: str) -> list[dict]:
    related_paths = _related_paths_for_markdown(repo, source_markdown)
    return [item for item in files if item["path"] in related_paths or item["head_path"] in related_paths]


COMMON_IMAGE_SUFFIXES = [
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".svg",
    ".excalidraw",
    ".excalidraw.md",
    ".pdf",
    ".gif",
    ".bmp",
    ".step",
    ".stp",
]


def _find_vault_root(repo: Path, source_rel: str) -> Path:
    """Markdownファイルに対するObsidian Vaultルートを判定する。
    1. 設定の obsidian_folder が有効で、repo と親子または同一であればそれを優先。
    2. なければ、Markdownファイルから親ディレクトリを遡って .obsidian を持つフォルダを探す。
    3. なければ、repo 自体に .obsidian があるか確認。
    4. 見つからない場合は、Gitリポジトリ（repo）自身を Vault ルートとして扱う。
    """
    settings = _load_server_settings()
    configured_vault = str(settings.get("obsidian_folder") or "").strip()
    if configured_vault:
        candidate = Path(configured_vault).expanduser()
        if candidate.is_dir():
            try:
                candidate = candidate.resolve()
                if candidate == repo or candidate in repo.parents or repo in candidate.parents:
                    return candidate
            except OSError:
                pass

    # Markdownファイルの親から遡って .obsidian を探索
    start_dir = (repo / source_rel).resolve().parent
    current = start_dir
    while True:
        if (current / ".obsidian").is_dir():
            return current
        if current == repo or current.parent == current:
            break
        current = current.parent

    if (repo / ".obsidian").is_dir():
        return repo

    return repo


def _related_markdown_paths(repo: Path, source_rel: str) -> set[str]:
    vault_root = _find_vault_root(repo, source_rel)

    # Git追跡ファイル一覧を取得（日本語ファイル名対応・削除ファイルも検出可能）
    tracked_files: list[str] = []
    try:
        raw_tracked = _git(["ls-files"], repo)
        tracked_files = [line.strip() for line in raw_tracked.splitlines() if line.strip()]
    except Exception:
        tracked_files = []
    # ファイル名→パスの索引は1リクエストにつき1回だけ構築し、全リンクで共有する。
    link_index = _LinkIndex(repo, tracked_files)

    related: set[str] = set()
    pending = [source_rel]
    # HEAD側の読み出しは常駐プロセス1つに集約する（ノートごとの git 起動を排除）。
    with _GitBlobBatch(repo) as head_reader:
        while pending and len(related) < MAX_OBSIDIAN_LINKS:
            current_rel = pending.pop(0)
            if current_rel in related:
                continue
            related.add(current_rel)
            current_path = repo / current_rel
            contents: list[bytes] = []
            if current_path.is_file():
                contents.append(_read_file_limited(current_path, MAX_TEXT_BYTES, current_rel))
            head_content = head_reader.read(current_rel, MAX_TEXT_BYTES)
            if head_content is not None:
                contents.append(head_content)
            for content in contents:
                try:
                    text, _ = _decode_git_text(content)
                except HTTPException:
                    continue
                for target in _extract_markdown_links(text):
                    resolved = _resolve_obsidian_link(
                        repo,
                        current_rel,
                        target,
                        vault_root,
                        tracked_files=tracked_files,
                        link_index=link_index,
                    )
                    if resolved and resolved not in related and len(related) + len(pending) < MAX_OBSIDIAN_LINKS:
                        pending.append(resolved)
    return related


class _LinkIndex:
    """リンク解決用のファイル名索引（1リクエスト内で共有）。

    従来は未解決のリンクごと・候補名ごとにVault全体を `os.walk` していたため、
    リンク切れが数件あるだけでWindowsでは数十秒〜数分かかっていた。
    追跡ファイル → 未追跡ファイル(git ls-files --others) → ファイルシステム走査 の順で、
    それぞれ最大1回だけ構築する。優先順位は従来と同じ（候補名の順 → 一覧の順）。
    """

    _SKIP_DIRS = {".git", "node_modules", ".venv", "__pycache__", ".obsidian"}

    def __init__(self, repo: Path, tracked_files: list[str] | None) -> None:
        # resolve() 済みの実パスで包含判定する（symlink・subst ドライブ経由の指定でも一致させる）。
        self.repo = repo.resolve()
        self.tracked: dict[str, str] | None = None
        if tracked_files is not None:
            self.tracked = {}
            for tracked in tracked_files:
                self.tracked.setdefault(tracked.rsplit("/", 1)[-1], tracked)
        self._untracked: dict[str, str] | None = None
        self._walked: dict[Path, dict[str, list[Path]]] = {}

    def find_tracked(self, names: list[str]) -> str | None:
        if self.tracked is None:
            return None
        for name in names:
            found = self.tracked.get(name)
            if found:
                return found
        return None

    def find_untracked(self, names: list[str]) -> str | None:
        if self._untracked is None:
            self._untracked = {}
            try:
                output = _git(["ls-files", "--others", "--exclude-standard"], self.repo)
            except HTTPException:
                output = ""
            for line in output.splitlines():
                line = line.strip()
                if line:
                    self._untracked.setdefault(line.rsplit("/", 1)[-1], line)
        for name in names:
            found = self._untracked.get(name)
            if found:
                return found
        return None

    def find_in_filesystem(self, search_roots: list[Path], names: list[str]) -> str | None:
        """gitignore済みなど、git一覧に出ないファイルのための最終手段（ルートごとに1回だけ走査）。"""
        for search_root in search_roots:
            index = self._walked.get(search_root)
            if index is None:
                index = {}
                for root, dirs, files in os.walk(str(search_root)):
                    dirs[:] = [d for d in dirs if d not in self._SKIP_DIRS]
                    for filename in files:
                        index.setdefault(filename, []).append(Path(root) / filename)
                self._walked[search_root] = index
            for name in names:
                # 同名ファイルがリポジトリ外にもある場合に備え、リポジトリ内のものが見つかるまで試す。
                for candidate in index.get(name, ()):
                    try:
                        resolved = candidate.resolve()
                        if self.repo == resolved or self.repo in resolved.parents:
                            return resolved.relative_to(self.repo).as_posix()
                    except OSError:
                        continue
        return None


def _extract_markdown_links(text: str) -> list[str]:
    targets: list[str] = []
    for match in WIKI_LINK_RE.finditer(text):
        target = match.group(1).split("|", 1)[0].split("#", 1)[0].strip()
        if target:
            targets.append(target)
    for match in MARKDOWN_LINK_RE.finditer(text):
        raw_target = match.group(1).strip().split()[0].strip("<>").split("#", 1)[0].strip()
        if not raw_target:
            continue
        if raw_target.startswith(("http://", "https://")):
            # URL形式のクエリパラメータに含まれるローカルファイルパス（filepath=, path=, file=）を抽出
            try:
                parsed = urlparse(raw_target)
                query_params = parse_qs(parsed.query)
                for param_key in ("filepath", "path", "file"):
                    if param_key in query_params:
                        for val in query_params[param_key]:
                            val_clean = unquote(val).strip()
                            if val_clean:
                                targets.append(val_clean)
            except Exception:
                pass
        elif not raw_target.startswith(("#", "mailto:", "data:")):
            targets.append(raw_target)

    # CADコードブロック（```step, ```cad, ```3d 等）内の path: / file: 指定を抽出
    for block_match in CAD_CODEBLOCK_RE.finditer(text):
        block_content = block_match.group(1)
        for path_match in CAD_PATH_PROPERTY_RE.finditer(block_content):
            val = path_match.group(1).strip().strip("\"'").split("#", 1)[0].strip()
            if val and val not in targets:
                targets.append(val)

    # 汎用YAML/プロパティ内の STEP ファイル指定（path: xxx.step, file: xxx.stp 等）を抽出
    for step_prop_match in STEP_PROPERTY_RE.finditer(text):
        val = step_prop_match.group(1).strip().strip("\"'").split("#", 1)[0].strip()
        if val and val not in targets:
            targets.append(val)

    return targets


def _resolve_obsidian_link(
    repo: Path,
    source_rel: str,
    raw_target: str,
    vault_root: Path | None,
    tracked_files: list[str] | None = None,
    link_index: "_LinkIndex | None" = None,
) -> str | None:
    repo = repo.resolve()
    if vault_root:
        vault_root = vault_root.resolve()
    cleaned = raw_target.strip()
    if not cleaned or cleaned.startswith(("#", "http://", "https://", "mailto:", "data:")):
        return None

    # 絶対パスまたはURLからデコードされたローカル絶対パスのチェック
    if os.path.isabs(cleaned) or (len(cleaned) > 2 and cleaned[1] == ":" and cleaned[2] in ("/", "\\")):
        try:
            abs_candidate = Path(cleaned).resolve()
            if repo == abs_candidate or repo in abs_candidate.parents:
                return abs_candidate.relative_to(repo).as_posix()
        except (ValueError, OSError):
            pass

    target = unquote(cleaned.replace("\\", "/")).strip().lstrip("/")
    if not target or target.startswith(("#", "http://", "https://", "mailto:", "data:")):
        return None
    target_path = Path(target)
    source_parent = (repo / source_rel).parent
    candidates = [source_parent / target_path, repo / target_path]
    if vault_root:
        candidates.insert(1, vault_root / target_path)

    # 拡張子のサフィックス候補
    if target_path.suffix.lower() == ".excalidraw":
        suffixes = ["", ".md"]
    elif target_path.suffix:
        suffixes = [""]
    else:
        suffixes = ["", ".md"] + COMMON_IMAGE_SUFFIXES

    # 1. 直接指定（親ディレクトリ相対、リポジトリルート相対、Vaultルート相対）
    for candidate_base in candidates:
        for suffix in suffixes:
            raw_candidate = candidate_base.parent / f"{candidate_base.name}{suffix}"
            try:
                # 存在しない候補が大半なので、コストの高い resolve() より先に存在確認する。
                if not raw_candidate.is_file():
                    continue
                candidate = raw_candidate.resolve()
                if repo == candidate or repo in candidate.parents:
                    return candidate.relative_to(repo).as_posix()
            except OSError:
                continue

    # 候補となるファイル名のリストを作成
    if target_path.suffix.lower() == ".excalidraw":
        names = [target_path.name, f"{target_path.name}.md"]
    elif target_path.suffix:
        names = [target_path.name]
    else:
        names = [target_path.name, f"{target_path.name}.md"] + [f"{target_path.name}{s}" for s in COMMON_IMAGE_SUFFIXES]

    if link_index is None:
        link_index = _LinkIndex(repo, tracked_files)

    # 2. Git管理下の追跡ファイル（git ls-files）から探索（高速・作業ツリー削除ファイルも網羅）
    found = link_index.find_tracked(names)
    if found:
        return found

    # 3. 未追跡ファイル（git ls-files --others）。ファイルシステム全探索より桁違いに速い。
    found = link_index.find_untracked(names)
    if found:
        return found

    # 4. gitignore済み等、gitの一覧に出ないファイルのみファイルシステムを走査する。
    search_roots = []
    if vault_root and vault_root.is_dir():
        search_roots.append(vault_root)
    if repo not in search_roots and repo.is_dir():
        search_roots.append(repo)
    return link_index.find_in_filesystem(search_roots, names)



def _find_repo_root_from_filesystem(folder: Path) -> Path | None:
    """`.git` を親方向に探してリポジトリルートを求める（git起動なし）。

    すべてのGit系APIは冒頭で `rev-parse --show-toplevel` を起動していたため、
    Windowsでは毎回数百msを失っていた。通常のリポジトリ・worktree・submoduleは
    いずれも作業ツリー直下に `.git`（ディレクトリまたはファイル）を持つ。
    """
    if ".git" in folder.parts:
        return None
    for candidate in (folder, *folder.parents):
        try:
            if (candidate / ".git").exists():
                return candidate
        except OSError:
            return None
    return None


def _git_repo_root(folder: Path) -> Path:
    fast_root = _find_repo_root_from_filesystem(Path(folder))
    if fast_root is not None:
        return fast_root.resolve()
    try:
        completed = _run_git_process(
            folder,
            ["rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except subprocess.CalledProcessError as exc:
        if _is_dubious_ownership_error(exc):
            safe_directory = _safe_directory_from_error(exc, folder)
            try:
                completed = _run_git_process(
                    folder,
                    ["rev-parse", "--show-toplevel"],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=10,
                    safe_directory=safe_directory,
                )
            except subprocess.CalledProcessError as retry_exc:
                raise HTTPException(status_code=422, detail=retry_exc.stderr.strip() or "指定フォルダはgitリポジトリではありません") from retry_exc
        else:
            raise HTTPException(status_code=422, detail="指定フォルダはgitリポジトリではありません") from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="git repository check timed out") from exc
    output = completed.stdout or ""
    if not output.strip():
        raise HTTPException(status_code=422, detail="git repository root could not be determined")
    return Path(output.strip()).resolve()


def _changed_image_files(repo: Path, folder: Path, specific_paths: set[str] | list[str] | None = None) -> list[dict]:
    images = []
    for item in _changed_files(repo, folder, set(), specific_paths=specific_paths):
        if item["kind"] != "image":
            continue
        comparable = item["diffable"]
        images.append(
            {
                **item,
                "comparable": comparable,
                "reason": None if comparable else "HEAD側または作業フォルダ側の画像がないため比較できません",
            }
        )
    return images


def _changed_files(
    repo: Path,
    folder: Path,
    text_extensions: set[str],
    specific_paths: set[str] | list[str] | None = None,
) -> list[dict]:
    if specific_paths is not None:
        valid_paths = [p for p in specific_paths if p]
        if not valid_paths:
            return []
        args = ["status", "--porcelain=v1", "-z", "--"] + sorted(valid_paths)
    else:
        args = ["status", "--porcelain=v1", "-z", "--", str(folder)]
    output = _git(args, repo)
    entries = [item for item in output.split("\0") if item]
    files = []
    i = 0
    while i < len(entries):
        entry = entries[i]
        status = entry[:2]
        path = entry[3:]
        head_path = path
        if status.startswith("R") or status.startswith("C"):
            i += 1
            if i < len(entries):
                head_path = entries[i]
        i += 1
        kind = _git_file_kind(path, text_extensions)
        if kind is None:
            continue
        has_head = "?" not in status and "A" not in status
        has_current = "D" not in status
        if "?" in status:
            change_type = "untracked"
        elif "R" in status:
            change_type = "renamed"
        elif "C" in status:
            change_type = "copied"
        elif not has_head:
            change_type = "added"
        elif not has_current:
            change_type = "deleted"
        else:
            change_type = "modified"
        files.append(
            {
                "path": path,
                "head_path": head_path,
                "status": status.strip() or "M",
                "kind": kind,
                "change_type": change_type,
                "has_head": has_head,
                "has_current": has_current,
                "diffable": has_head and has_current,
                "comparable": True,
                "reason": None,
                "embedded_excalidraw": _has_embedded_excalidraw(
                    repo,
                    path,
                    head_path,
                    has_head=has_head,
                    has_current=has_current,
                )
                if kind == "text"
                else False,
            }
        )
    return files


def _safe_git_path(repo: Path, path: str, *, restrict_to_images: bool = True) -> str:
    rel = Path(path)
    if rel.is_absolute() or ".." in rel.parts:
        raise HTTPException(status_code=422, detail="path must be a repository-relative path")
    resolved = (repo / rel).resolve()
    if repo != resolved and repo not in resolved.parents:
        raise HTTPException(status_code=422, detail="path is outside repository")
    if restrict_to_images and not _is_git_image_path(rel.as_posix()):
        raise HTTPException(status_code=422, detail="path is not a supported image file")
    return rel.as_posix()


def _is_git_image_path(path: str) -> bool:
    lower_path = path.lower()
    return lower_path.endswith(EXCALIDRAW_MARKDOWN_SUFFIXES) or Path(lower_path).suffix in IMAGE_EXTENSIONS


def _is_git_3d_path(path: str) -> bool:
    return Path(path.lower()).suffix in STEP_EXTENSIONS


def _git_file_kind(path: str, text_extensions: set[str]) -> str | None:
    if _is_git_image_path(path):
        return "image"
    if _is_git_3d_path(path):
        return "3d"
    return "text" if Path(path).suffix.lower() in text_extensions else None


def _has_embedded_excalidraw(
    repo: Path,
    current_rel_path: str,
    head_rel_path: str,
    *,
    has_head: bool,
    has_current: bool,
) -> bool:
    """Return whether either side of a Markdown diff contains an Excalidraw block."""
    lower_path = current_rel_path.lower()
    if not lower_path.endswith(".md"):
        return False
    if lower_path.endswith(EXCALIDRAW_MARKDOWN_SUFFIXES):
        return True

    # 作業コピー（ローカルファイル）が存在する場合、高速にローカル内容を先頭サンプリングして判定
    current_path = repo / current_rel_path
    if has_current and current_path.is_file():
        try:
            with open(current_path, "rb") as f:
                sample = f.read(65536)
            if EXCALIDRAW_PLUGIN_MARKER_RE.search(sample.decode("utf-8", errors="ignore")):
                return True
        except OSError:
            pass
        # ローカルファイルが存在する場合、全件一覧作成時に不要な git show を同期実行しない
        return False

    # 作業コピーがない（削除された）場合のみ、HEAD 側を確認
    if has_head and not has_current:
        try:
            sample = _git_show(repo, head_rel_path, max_bytes=65536)
            return bool(EXCALIDRAW_PLUGIN_MARKER_RE.search(sample.decode("utf-8", errors="ignore")))
        except HTTPException:
            pass
    return False


def _embedded_excalidraw_json_bytes(content: bytes) -> bytes:
    """Extract a note's drawing as standalone JSON for the normal image pipeline."""
    text = content.decode("utf-8", errors="ignore")
    if not EXCALIDRAW_PLUGIN_MARKER_RE.search(text):
        return b'{"type":"excalidraw","elements":[],"appState":{}}'
    try:
        payload = extract_excalidraw_json(content)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not find Excalidraw JSON in Markdown: {exc}") from exc
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def _text_extensions_from_payload(payload: dict) -> set[str]:
    raw = payload.get("text_extensions")
    if raw is None:
        return set(DEFAULT_TEXT_EXTENSIONS)
    if not isinstance(raw, list) or len(raw) > 50:
        raise HTTPException(status_code=422, detail="text_extensions must be a list of at most 50 extensions")
    result = set()
    for item in raw:
        extension = str(item).strip().lower()
        if extension and not extension.startswith("."):
            extension = f".{extension}"
        if not EXTENSION_RE.fullmatch(extension):
            raise HTTPException(status_code=422, detail=f"invalid text extension: {item}")
        if extension not in IMAGE_EXTENSIONS:
            result.add(extension)
    return result


def _decode_git_text(content: bytes) -> tuple[str, str]:
    if len(content) > MAX_TEXT_BYTES:
        raise HTTPException(status_code=413, detail=f"Text file exceeds {MAX_TEXT_BYTES // (1024 * 1024)} MB")
    if b"\x00" in content:
        raise HTTPException(status_code=422, detail="Binary content cannot be shown as text")
    control_bytes = sum(byte < 32 and byte not in {9, 10, 12, 13} for byte in content)
    if content and control_bytes / len(content) > 0.01:
        raise HTTPException(status_code=422, detail="Binary content cannot be shown as text")
    if content.startswith(b"\xef\xbb\xbf"):
        return content.decode("utf-8-sig"), "utf-8-sig"
    for encoding in ("utf-8", "cp932"):
        try:
            return content.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace"), "utf-8 (replacement characters)"


def _is_trivial_line(line: str) -> bool:
    stripped = line.strip()
    return not stripped or stripped in {":", "{", "}", "pass", "---"}


def _line_opcodes(old_lines: list[str], new_lines: list[str]) -> list[tuple[str, int, int, int, int]]:
    """行単位のopcodesを返す。先頭・末尾の共通行はSequenceMatcherに渡さない。

    difflib.SequenceMatcher は純Pythonで、行数が多いほど急激に遅くなる。実際の編集は
    ファイルの一部だけなので、共通の先頭・末尾を先に除くだけで古いPCでも大幅に速くなる。
    """
    limit = min(len(old_lines), len(new_lines))
    prefix = 0
    while prefix < limit and old_lines[prefix] == new_lines[prefix]:
        prefix += 1
    suffix = 0
    while suffix < limit - prefix and old_lines[-1 - suffix] == new_lines[-1 - suffix]:
        suffix += 1

    old_end = len(old_lines) - suffix
    new_end = len(new_lines) - suffix
    opcodes: list[tuple[str, int, int, int, int]] = []
    if prefix:
        opcodes.append(("equal", 0, prefix, 0, prefix))
    middle_old = old_lines[prefix:old_end]
    middle_new = new_lines[prefix:new_end]
    if middle_old or middle_new:
        matcher = difflib.SequenceMatcher(
            _is_trivial_line,
            middle_old,
            middle_new,
            autojunk=max(len(middle_old), len(middle_new)) > 2_000,
        )
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            opcodes.append((tag, i1 + prefix, i2 + prefix, j1 + prefix, j2 + prefix))
    if suffix:
        opcodes.append(("equal", old_end, len(old_lines), new_end, len(new_lines)))
    return opcodes


def _build_text_diff_rows(old_text: str, new_text: str) -> list[dict]:
    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()
    if len(old_lines) > MAX_TEXT_DIFF_LINES or len(new_lines) > MAX_TEXT_DIFF_LINES:
        raise HTTPException(status_code=413, detail=f"Text diff exceeds {MAX_TEXT_DIFF_LINES:,} lines per side")
    rows: list[dict] = []
    common_line_num = 1
    for tag, old_start, old_end, new_start, new_end in _line_opcodes(old_lines, new_lines):
        old_group = old_lines[old_start:old_end]
        new_group = new_lines[new_start:new_end]
        count = max(len(old_group), len(new_group))
        for offset in range(count):
            old_line = old_group[offset] if offset < len(old_group) else None
            new_line = new_group[offset] if offset < len(new_group) else None
            row_tag = tag
            if tag == "replace" and old_line is None:
                row_tag = "insert"
            elif tag == "replace" and new_line is None:
                row_tag = "delete"

            if row_tag == "insert":
                old_number = None
                new_number = "A"
            elif row_tag == "delete":
                old_number = "D"
                new_number = None
            else:
                old_number = common_line_num
                new_number = common_line_num
                common_line_num += 1

            # 左右のハイライトは同じ比較結果から作れるため、行ごとに1回だけ計算する。
            inline_segments = (
                _inline_diff_pair(old_line or "", new_line or "") if row_tag == "replace" else (None, None)
            )
            rows.append(
                {
                    "kind": row_tag,
                    "old_number": old_number,
                    "new_number": new_number,
                    "old_index": old_start + offset if old_line is not None else old_start,
                    # Deleted rows all belong at the same current-file insertion
                    # point. Advancing by the old-side offset would restore later
                    # deleted lines after unrelated following content.
                    "new_index": new_start + offset if new_line is not None else new_start,
                    "old": old_line,
                    "new": new_line,
                    "old_segments": inline_segments[0],
                    "new_segments": inline_segments[1],
                }
            )
    old_terminal_newline = old_text.endswith(("\n", "\r"))
    new_terminal_newline = new_text.endswith(("\n", "\r"))
    if old_terminal_newline != new_terminal_newline:
        old_marker = "ファイル末尾: 改行あり" if old_terminal_newline else "ファイル末尾: 改行なし"
        new_marker = "ファイル末尾: 改行あり" if new_terminal_newline else "ファイル末尾: 改行なし"
        rows.append(
            {
                "kind": "replace",
                "old_number": None,
                "new_number": None,
                "old": old_marker,
                "new": new_marker,
                "old_segments": [{"text": old_marker, "changed": True}],
                "new_segments": [{"text": new_marker, "changed": True}],
            }
        )
    return rows


EXCALIDRAW_DATA_HEADING_RE = re.compile(r"(?i)^\s{0,3}#{1,6}\s+excalidraw\s+data\s*$")
EXCALIDRAW_FENCE_RE = re.compile(r"(?i)^\s*```(?:compressed-json|json)\s*$")


def _build_markdown_text_diff_rows(old_text: str, new_text: str) -> list[dict]:
    """Build text rows while hiding embedded Excalidraw source lines.

    The rows keep their original line indexes. This lets the existing editor
    and safe one-line restore operation continue to edit the real Markdown
    file even though the large drawing payload is omitted from the display.
    """
    old_hidden = _embedded_excalidraw_line_indexes(old_text)
    new_hidden = _embedded_excalidraw_line_indexes(new_text)
    if not old_hidden and not new_hidden:
        return _build_text_diff_rows(old_text, new_text)

    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()

    # Excalidrawデータ行を除外したクリーンな行リストと元インデックスのペアを作成
    old_clean = [(i, line) for i, line in enumerate(old_lines) if i not in old_hidden]
    new_clean = [(i, line) for i, line in enumerate(new_lines) if i not in new_hidden]

    old_clean_text = [item[1] for item in old_clean]
    new_clean_text = [item[1] for item in new_clean]

    rows: list[dict] = []
    common_line_num = 1
    for tag, old_start, old_end, new_start, new_end in _line_opcodes(old_clean_text, new_clean_text):
        old_group = old_clean_text[old_start:old_end]
        new_group = new_clean_text[new_start:new_end]
        count = max(len(old_group), len(new_group))
        for offset in range(count):
            has_old = offset < len(old_group)
            has_new = offset < len(new_group)
            old_line = old_group[offset] if has_old else None
            new_line = new_group[offset] if has_new else None
            row_tag = tag
            if tag == "replace" and old_line is None:
                row_tag = "insert"
            elif tag == "replace" and new_line is None:
                row_tag = "delete"

            if row_tag == "insert":
                old_number = None
                new_number = "A"
            elif row_tag == "delete":
                old_number = "D"
                new_number = None
            else:
                old_number = common_line_num
                new_number = common_line_num
                common_line_num += 1

            orig_old_idx = old_clean[old_start + offset][0] if has_old else (old_clean[old_start][0] if old_start < len(old_clean) else len(old_lines))
            orig_new_idx = new_clean[new_start + offset][0] if has_new else (new_clean[new_start][0] if new_start < len(new_clean) else len(new_lines))

            # 左右のハイライトは同じ比較結果から作れるため、行ごとに1回だけ計算する。
            inline_segments = (
                _inline_diff_pair(old_line or "", new_line or "") if row_tag == "replace" else (None, None)
            )
            rows.append(
                {
                    "kind": row_tag,
                    "old_number": old_number,
                    "new_number": new_number,
                    "old_index": orig_old_idx,
                    "new_index": orig_new_idx,
                    "old": old_line,
                    "new": new_line,
                    "old_segments": inline_segments[0],
                    "new_segments": inline_segments[1],
                }
            )

    old_terminal_newline = old_text.endswith(("\n", "\r"))
    new_terminal_newline = new_text.endswith(("\n", "\r"))
    if old_terminal_newline != new_terminal_newline:
        old_marker = "ファイル末尾: 改行あり" if old_terminal_newline else "ファイル末尾: 改行なし"
        new_marker = "ファイル末尾: 改行あり" if new_terminal_newline else "ファイル末尾: 改行なし"
        rows.append(
            {
                "kind": "replace",
                "old_number": None,
                "new_number": None,
                "old": old_marker,
                "new": new_marker,
                "old_segments": [{"text": old_marker, "changed": True}],
                "new_segments": [{"text": new_marker, "changed": True}],
            }
        )
    return rows


def _embedded_excalidraw_line_indexes(text: str) -> set[int]:
    lines = text.splitlines()
    if not lines:
        return set()
    if not EXCALIDRAW_PLUGIN_MARKER_RE.search(text):
        return set()

    for index, line in enumerate(lines):
        if EXCALIDRAW_DATA_HEADING_RE.match(line):
            # Keep the heading visible; only the embedded drawing source
            # below it is omitted from the text diff.
            return set(range(index + 1, len(lines)))

    # Support notes that use the plugin marker and a drawing fence without the
    # standard ``# Excalidraw Data`` heading. Do not hide arbitrary JSON blocks
    # in ordinary Markdown: only treat a fence as drawing data when the note
    # contains the plugin's parsed marker.
    hidden: set[int] = set()
    index = 0
    while index < len(lines):
        if not EXCALIDRAW_FENCE_RE.match(lines[index]):
            index += 1
            continue
        end = index + 1
        while end < len(lines) and not lines[end].strip().startswith("```"):
            end += 1
        if end < len(lines):
            hidden.update(range(index, end + 1))
            index = end + 1
        else:
            hidden.update(range(index, len(lines)))
            break
    return hidden


TOKEN_SPLIT_RE = re.compile(
    r"[a-zA-Z0-9_]+"               # 英数字・アンダースコア（Python識別子、英単語）
    r"|[\u4e00-\u9faf]+"          # 漢字の連続
    r"|[\u3040-\u309f]+"          # ひらがなの連続
    r"|[\u30a0-\u30ff]+"          # カタカナの連続
    r"|[ \t]+"                     # 空白・インデント
    r"|[^\w\s]"                    # 記号（括弧、句読点、演算子等）
    r"|."                          # その他フォールバック
)


def _tokenize_line(text: str) -> list[str]:
    return TOKEN_SPLIT_RE.findall(text)


def _inline_diff_pair(old_line: str, new_line: str) -> tuple[list[dict], list[dict]]:
    """旧・新の行内差分セグメントを1回の比較でまとめて返す。"""
    if len(old_line) + len(new_line) > MAX_INLINE_DIFF_CHARS:
        return (
            [{"text": old_line, "changed": True}] if old_line else [],
            [{"text": new_line, "changed": True}] if new_line else [],
        )
    old_tokens = _tokenize_line(old_line)
    new_tokens = _tokenize_line(new_line)
    matcher = difflib.SequenceMatcher(None, old_tokens, new_tokens, autojunk=False)
    old_segments: list[dict] = []
    new_segments: list[dict] = []

    def append(segments: list[dict], tokens: list[str], changed: bool) -> None:
        text = "".join(tokens)
        if not text:
            return
        if segments and segments[-1]["changed"] == changed:
            segments[-1]["text"] += text
        else:
            segments.append({"text": text, "changed": changed})

    for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
        changed = tag != "equal"
        append(old_segments, old_tokens[old_start:old_end], changed)
        append(new_segments, new_tokens[new_start:new_end], changed)
    return old_segments, new_segments


def _inline_diff_segments(old_line: str, new_line: str, side: str) -> list[dict]:
    old_segments, new_segments = _inline_diff_pair(old_line, new_line)
    return old_segments if side == "old" else new_segments


def _git_preview_payload(filename: str, content: bytes) -> dict:
    _, page = _convert_page_or_400(filename, content, 0)
    return {"mime_type": "image/png", "data": encode_png(page.image)}


def _read_file_limited(path: Path, max_bytes: int, label: str) -> bytes:
    if path.stat().st_size > max_bytes:
        raise HTTPException(status_code=413, detail=f"{label} exceeds {max_bytes // (1024 * 1024)} MB")
    content = path.read_bytes()
    if len(content) > max_bytes:
        raise HTTPException(status_code=413, detail=f"{label} exceeds {max_bytes // (1024 * 1024)} MB")
    return content


def _git_show(repo: Path, rel_path: str, *, max_bytes: int | None = None) -> bytes:
    """HEAD側のBlobを1回のgit起動で読み出す。

    以前はサイズ確認の `cat-file -s` と `show` で2プロセス起動していた。Windowsは
    プロセス起動が重いため、1プロセスで読みつつ上限超過時点で打ち切る。
    """
    command = _git_command(repo, ["cat-file", "blob", f"HEAD:{rel_path}"], safe_directory=repo)
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError as exc:
        raise HTTPException(status_code=404, detail=f"HEAD側の画像を取得できません: {rel_path}") from exc

    # 読み出しが滞った場合に備え、既存の timeout=20 と同じ時間で強制終了する。
    timed_out = threading.Event()

    def _kill_on_timeout() -> None:
        timed_out.set()
        process.kill()

    timer = threading.Timer(20, _kill_on_timeout)
    timer.start()
    oversized = False
    try:
        if max_bytes is None:
            content = process.stdout.read()
        else:
            content = process.stdout.read(max_bytes + 1)
            oversized = len(content) > max_bytes
            if oversized:
                process.kill()
    finally:
        timer.cancel()
        process.stdout.close()
        returncode = process.wait()
    if oversized:
        raise HTTPException(status_code=413, detail=f"HEAD:{rel_path} exceeds {max_bytes // (1024 * 1024)} MB")
    if timed_out.is_set():
        raise HTTPException(status_code=504, detail="git show timed out")
    if returncode != 0:
        raise HTTPException(status_code=404, detail=f"HEAD側の画像を取得できません: {rel_path}")
    return content


class _GitBlobBatch:
    """`git cat-file --batch` を1プロセスだけ起動し、複数のHEAD Blobを連続で読む。

    Markdownのリンクを辿るときはノート数だけ `git show` を起動していたが、
    Windowsでは1起動あたり数十〜数百msかかるため、常駐1プロセスに集約する。
    起動できない環境では従来どおり `_git_show` へフォールバックする。
    """

    def __init__(self, repo: Path) -> None:
        self.repo = repo
        self._process: subprocess.Popen | None = None

    def __enter__(self) -> "_GitBlobBatch":
        try:
            self._process = subprocess.Popen(
                _git_command(self.repo, ["cat-file", "--batch"], safe_directory=self.repo),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except OSError:
            self._process = None
        return self

    def __exit__(self, *exc_info) -> None:
        process, self._process = self._process, None
        if process is not None:
            self._close(process)

    @staticmethod
    def _close(process: subprocess.Popen, *, kill: bool = False) -> None:
        if kill:
            try:
                process.kill()
            except OSError:
                pass
        for stream in (process.stdin, process.stdout):
            try:
                if stream is not None:
                    stream.close()
            except OSError:
                pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()

    def read(self, rel_path: str, max_bytes: int) -> bytes | None:
        """HEADにBlobがあれば内容を返す。無い・上限超過なら None。"""
        process = self._process
        if process is None:
            try:
                return _git_show(self.repo, rel_path, max_bytes=max_bytes)
            except HTTPException:
                return None
        if "\n" in rel_path:
            return None
        try:
            process.stdin.write(f"HEAD:{rel_path}\n".encode("utf-8"))
            process.stdin.flush()
            header = process.stdout.readline().decode("utf-8", errors="replace").split()
            if len(header) != 3 or header[1] != "blob":
                if len(header) == 3:
                    # tree/commit 等: 本文を読み捨てて同期を保つ
                    self._discard(process, int(header[2]) + 1)
                return None
            size = int(header[2])
            if size > max_bytes:
                self._discard(process, size + 1)
                return None
            data = self._read_exact(process, size + 1)
            return data[:-1]
        except (OSError, ValueError):
            # パイプが壊れた場合は以降を単発起動へ切り替える。
            self._process = None
            self._close(process, kill=True)
            try:
                return _git_show(self.repo, rel_path, max_bytes=max_bytes)
            except HTTPException:
                return None

    @staticmethod
    def _read_exact(process: subprocess.Popen, count: int) -> bytes:
        chunks = []
        remaining = count
        while remaining > 0:
            chunk = process.stdout.read(min(remaining, 1024 * 1024))
            if not chunk:
                raise OSError("git cat-file --batch closed unexpectedly")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _discard(self, process: subprocess.Popen, count: int) -> None:
        remaining = count
        while remaining > 0:
            chunk = process.stdout.read(min(remaining, 1024 * 1024))
            if not chunk:
                raise OSError("git cat-file --batch closed unexpectedly")
            remaining -= len(chunk)


def _git_object_size(repo: Path, rel_path: str) -> int:
    try:
        completed = _run_git_process(
            repo,
            ["cat-file", "-s", f"HEAD:{rel_path}"],
            check=True,
            capture_output=True,
            timeout=20,
            text=True,
            safe_directory=repo,
        )
    except subprocess.CalledProcessError as exc:
        raise HTTPException(status_code=404, detail=f"HEAD側のファイルを取得できません: {rel_path}") from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="git object size check timed out") from exc
    try:
        return int((completed.stdout or "0").strip())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Could not determine HEAD file size: {rel_path}") from exc


def _git(args: list[str], repo: Path) -> str:
    try:
        completed = _run_git_process(
            repo,
            args,
            check=True,
            capture_output=True,
            text=True,
            timeout=20,
            safe_directory=repo,
        )
    except subprocess.CalledProcessError as exc:
        raise HTTPException(status_code=422, detail=exc.stderr.strip() or "git command failed") from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="git command timed out") from exc
    # A subprocess reader can leave stdout as None after an interrupted/failed
    # read. Keep callers such as _changed_image_files safe from a secondary
    # AttributeError while still treating the command as having no output.
    return completed.stdout or ""


def _run_git_process(
    cwd: Path,
    args: list[str],
    *,
    safe_directory: Path | str | None = None,
    **kwargs,
) -> subprocess.CompletedProcess:
    # Git emits machine-readable text (including -z status output) as UTF-8.
    # Do not let subprocess choose the Windows locale encoding (often CP932).
    if kwargs.get("text") or kwargs.get("universal_newlines"):
        kwargs.setdefault("encoding", "utf-8")
    return subprocess.run(_git_command(cwd, args, safe_directory=safe_directory), **kwargs)


_GIT_EXECUTABLE: str | None = None


def _resolve_git_executable() -> str:
    """起動するgit実行ファイルを決める（結果はプロセス内でキャッシュ）。

    Git for Windows の PATH 上の `cmd\\git.exe` は `mingw64\\bin\\git.exe` を再度起動する
    ランチャーで、1回のgit呼び出しごとにプロセスが2つ生成される。実体を直接指定して
    起動コストを半減させる。見つからない・動作確認できない場合は "git" を使う。
    `VISUAL_DIFF_GIT_EXE` で明示指定も可能。
    """
    global _GIT_EXECUTABLE
    if _GIT_EXECUTABLE is not None:
        return _GIT_EXECUTABLE
    candidate = os.environ.get("VISUAL_DIFF_GIT_EXE", "").strip()
    if not candidate and os.name == "nt":
        found = shutil.which("git")
        if found:
            launcher = Path(found)
            if launcher.parent.name.lower() == "cmd":
                real = launcher.parent.parent / "mingw64" / "bin" / "git.exe"
                if real.is_file():
                    candidate = str(real)
    if candidate:
        try:
            probe = subprocess.run([candidate, "--version"], capture_output=True, timeout=10)
            if probe.returncode == 0:
                _GIT_EXECUTABLE = candidate
                return candidate
        except (OSError, subprocess.SubprocessError):
            pass
    _GIT_EXECUTABLE = "git"
    return _GIT_EXECUTABLE


def _git_command(cwd: Path | str, args: list[str], *, safe_directory: Path | str | None = None) -> list[str]:
    # --no-optional-locks: 読み取り専用の操作でindexを書き換えず、他のgit/エディタ連携と競合しない。
    # core.preloadindex / core.fscache: Windowsでのindex・ファイル状態の読み込みを並列化・キャッシュする。
    command = [
        _resolve_git_executable(),
        "--no-optional-locks",
        "-c", "core.quotepath=false",
        "-c", "core.preloadindex=true",
        "-c", "core.fscache=true",
    ]
    if safe_directory is not None:
        command.extend(["-c", f"safe.directory={Path(safe_directory).resolve().as_posix()}"])
    command.extend(["-C", str(cwd), *args])
    return command


def _is_dubious_ownership_error(exc: subprocess.CalledProcessError) -> bool:
    return "dubious ownership" in (exc.stderr or "")


def _safe_directory_from_error(exc: subprocess.CalledProcessError, fallback: Path) -> Path:
    match = DUBIOUS_OWNERSHIP_RE.search(exc.stderr or "")
    if match:
        return Path(match.group(1)).resolve()
    return fallback.resolve()


if ASSETS_DIR.exists():
    app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")


@app.get("/")
def serve_frontend() -> FileResponse:
    index = DIST_DIR / "index.html"
    if not index.exists():
        raise HTTPException(status_code=404, detail="frontend/dist/index.html not found. Run npm run build in frontend.")
    return FileResponse(index)


@app.get("/api-guide", include_in_schema=False)
def serve_api_guide() -> FileResponse:
    return serve_frontend()


@app.get("/{filename}", include_in_schema=False)
def serve_frontend_file(filename: str) -> FileResponse:
    path = DIST_DIR / filename
    if path.exists() and path.is_file():
        return FileResponse(path)
    raise HTTPException(status_code=404, detail="Not found")


@app.get("/{path:path}", include_in_schema=False)
def serve_spa(path: str) -> FileResponse:
    if path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found")
    index = DIST_DIR / "index.html"
    if not index.exists():
        raise HTTPException(status_code=404, detail="frontend/dist/index.html not found. Run npm run build in frontend.")
    return FileResponse(index)
