"""
Visual Diff Tool メインAPIサーバー仕様。
画像差分・テキスト差分・Git連携（Obsidian対応）のエンドポイントを提供し、
画像変換・エンコードの並列化およびGit差分のピンポイント取得により高速化を実現する。
"""

from __future__ import annotations

import concurrent.futures
import difflib
import json
import os
import re
import subprocess
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse
from uuid import uuid4

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
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
from .models import AlignmentInfo, AnalyzeResponse, DiffResponse, ImagePayload, PageInfo, RediffRequest, RediffResponse
from .raster_cache import rasterize_upload_page_cached
from .regions import suggest_anchor_regions
from .result_cache import get_diff_images, store_diff_images


app = FastAPI(title="Visual Diff Tool API", version="0.1.0")

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
SERVER_SETTINGS_PATH = Path(os.environ.get("VISUAL_DIFF_SETTINGS_PATH", Path(__file__).resolve().parents[1] / ".visual-diff-settings.json"))
MAX_OBSIDIAN_LINKS = 500
MAX_REPORT_BYTES = 50 * 1024 * 1024


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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
    max_bytes = MAX_UPLOAD_BYTES if kind == "image" else MAX_TEXT_BYTES
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
    else:
        old_text, old_encoding = _decode_git_text(previous) if previous is not None else ("", None)
        new_text, new_encoding = _decode_git_text(current) if current is not None else ("", None)
        response.update({"encoding_head": old_encoding, "encoding_current": new_encoding, "rows": _build_markdown_text_diff_rows(old_text, new_text)})
        if payload.get("include_text", True):
            response.update({"text_head": old_text, "text_current": new_text})
    return JSONResponse(response)


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

    related: set[str] = set()
    pending = [source_rel]
    while pending and len(related) < MAX_OBSIDIAN_LINKS:
        current_rel = pending.pop(0)
        if current_rel in related:
            continue
        related.add(current_rel)
        current_path = repo / current_rel
        contents: list[bytes] = []
        if current_path.is_file():
            contents.append(_read_file_limited(current_path, MAX_TEXT_BYTES, current_rel))
        try:
            contents.append(_git_show(repo, current_rel, max_bytes=MAX_TEXT_BYTES))
        except HTTPException:
            pass
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
                )
                if resolved and resolved not in related and len(related) + len(pending) < MAX_OBSIDIAN_LINKS:
                    pending.append(resolved)
    return related


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
    return targets


def _resolve_obsidian_link(
    repo: Path,
    source_rel: str,
    raw_target: str,
    vault_root: Path | None,
    tracked_files: list[str] | None = None,
) -> str | None:
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
            candidate = (candidate_base.parent / f"{candidate_base.name}{suffix}").resolve()
            if repo == candidate or repo in candidate.parents:
                try:
                    if candidate.is_file():
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

    # 2. Git管理下の追跡ファイル（git ls-files）から探索（高速・作業ツリー削除ファイルも網羅）
    if tracked_files is not None:
        for name in names:
            for tracked in tracked_files:
                if Path(tracked).name == name:
                    return tracked

    # 3. ファイルシステム上を探索（未追跡 untracked や新規ファイルに対応）
    search_roots = []
    if vault_root and vault_root.is_dir():
        search_roots.append(vault_root)
    if repo not in search_roots and repo.is_dir():
        search_roots.append(repo)

    for search_root in search_roots:
        for name in names:
            for root, dirs, files in os.walk(str(search_root)):
                # 重い・不要なディレクトリを除外
                dirs[:] = [d for d in dirs if d not in {".git", "node_modules", ".venv", "__pycache__", ".obsidian"}]
                if name in files:
                    candidate = Path(root) / name
                    try:
                        resolved = candidate.resolve()
                        if repo == resolved or repo in resolved.parents:
                            return resolved.relative_to(repo).as_posix()
                    except OSError:
                        continue
    return None



def _git_repo_root(folder: Path) -> Path:
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


def _git_file_kind(path: str, text_extensions: set[str]) -> str | None:
    if _is_git_image_path(path):
        return "image"
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


def _build_text_diff_rows(old_text: str, new_text: str) -> list[dict]:
    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()
    if len(old_lines) > MAX_TEXT_DIFF_LINES or len(new_lines) > MAX_TEXT_DIFF_LINES:
        raise HTTPException(status_code=413, detail=f"Text diff exceeds {MAX_TEXT_DIFF_LINES:,} lines per side")
    matcher = difflib.SequenceMatcher(_is_trivial_line, old_lines, new_lines, autojunk=max(len(old_lines), len(new_lines)) > 2_000)
    rows: list[dict] = []
    common_line_num = 1
    for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
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
                    "old_segments": _inline_diff_segments(old_line or "", new_line or "", "old") if row_tag == "replace" else None,
                    "new_segments": _inline_diff_segments(old_line or "", new_line or "", "new") if row_tag == "replace" else None,
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

    matcher = difflib.SequenceMatcher(_is_trivial_line, old_clean_text, new_clean_text, autojunk=max(len(old_clean_text), len(new_clean_text)) > 2_000)
    rows: list[dict] = []
    common_line_num = 1
    for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
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

            rows.append(
                {
                    "kind": row_tag,
                    "old_number": old_number,
                    "new_number": new_number,
                    "old_index": orig_old_idx,
                    "new_index": orig_new_idx,
                    "old": old_line,
                    "new": new_line,
                    "old_segments": _inline_diff_segments(old_line or "", new_line or "", "old") if row_tag == "replace" else None,
                    "new_segments": _inline_diff_segments(old_line or "", new_line or "", "new") if row_tag == "replace" else None,
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


def _inline_diff_segments(old_line: str, new_line: str, side: str) -> list[dict]:
    if len(old_line) + len(new_line) > MAX_INLINE_DIFF_CHARS:
        text = old_line if side == "old" else new_line
        return [{"text": text, "changed": True}] if text else []
    old_tokens = _tokenize_line(old_line)
    new_tokens = _tokenize_line(new_line)
    matcher = difflib.SequenceMatcher(None, old_tokens, new_tokens, autojunk=False)
    segments: list[dict] = []
    for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
        tokens = old_tokens[old_start:old_end] if side == "old" else new_tokens[new_start:new_end]
        text = "".join(tokens)
        if text:
            changed = tag != "equal"
            if segments and segments[-1]["changed"] == changed:
                segments[-1]["text"] += text
            else:
                segments.append({"text": text, "changed": changed})
    return segments


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
    if max_bytes is not None:
        size = _git_object_size(repo, rel_path)
        if size > max_bytes:
            raise HTTPException(status_code=413, detail=f"HEAD:{rel_path} exceeds {max_bytes // (1024 * 1024)} MB")
    try:
        completed = _run_git_process(
            repo,
            ["show", f"HEAD:{rel_path}"],
            check=True,
            capture_output=True,
            timeout=20,
            text=False,
            safe_directory=repo,
        )
    except subprocess.CalledProcessError as exc:
        raise HTTPException(status_code=404, detail=f"HEAD側の画像を取得できません: {rel_path}") from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="git show timed out") from exc
    return completed.stdout or b""


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
    command = ["git", "-c", "core.quotepath=false"]
    if safe_directory is not None:
        command.extend(["-c", f"safe.directory={Path(safe_directory).resolve().as_posix()}"])
    command.extend(["-C", str(cwd), *args])
    return subprocess.run(command, **kwargs)


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
