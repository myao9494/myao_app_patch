"""MkDocs統合マークダウン＋図PDFの生成・保存・フォルダ表示API (mkdocs.py)"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException

from ..mkdocs_support import PdfPart, build_mkdocs_bundle, pdf_bytes_to_data_url
from ..output_limits import (
    MAX_ATTEMPTS,
    attachment_warning,
    check_pdf_parts,
    check_text_parts,
    pdf_limit_for_attempt,
    pdf_max_bytes,
    split_text_parts,
    text_limit_for_attempt,
    text_parts_payload,
    verify_saved_files,
    write_pdf_files,
    write_text_files,
)
from ..settings_store import remember_repository, settings_transaction
from .deps import get_export_folder, repository_root, safe_file_base_name
from .schemas import DEFAULT_MKDOCS_EXPORT_FOLDER, MkDocsBundleRequest, MkDocsExportConfigRequest

router = APIRouter(prefix="/mkdocs")


def _open_in_file_manager(folder: Path) -> None:
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(folder)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elif os.name == "nt":
        os.startfile(str(folder))  # type: ignore[attr-defined]
    else:
        subprocess.Popen(["xdg-open", str(folder)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


@router.get("/export_config")
def get_export_config() -> dict:
    return {"export_folder": get_export_folder()}


@router.post("/export_config")
def save_export_config(request: MkDocsExportConfigRequest) -> dict:
    folder = request.export_folder.strip() or DEFAULT_MKDOCS_EXPORT_FOLDER
    with settings_transaction() as settings:
        settings.setdefault("ui", {})["mkdocs_export_folder"] = folder
    return {"status": "success", "export_folder": folder}


def _build_bundle(request: MkDocsBundleRequest, attempt: int = 0):
    """統合マークダウンと図PDFを作り、文字数・容量の上限に収めたパート列と検証結果を返す。"""
    root = repository_root(request.library_path)
    markdown_text, pdf_parts, stats = build_mkdocs_bundle(
        root=root, selected_files=request.selected_files, title=request.title, pdf_max_bytes=pdf_limit_for_attempt(attempt, pdf_max_bytes(request.pdf_max_mb))
    )
    text_parts = split_text_parts(markdown_text, text_limit_for_attempt(attempt))
    problems = check_text_parts(text_parts) + check_pdf_parts([part.data for part in pdf_parts], pdf_max_bytes(request.pdf_max_mb))
    stats["text_part_count"] = len(text_parts)
    stats["text_part_chars"] = [len(part) for part in text_parts]
    stats["attempts"] = attempt + 1
    return root, markdown_text, text_parts, pdf_parts, stats, problems


def _build_within_limits(request: MkDocsBundleRequest):
    problems: list[str] = []
    for attempt in range(MAX_ATTEMPTS):
        result = _build_bundle(request, attempt)
        problems = result[-1]
        if not problems:
            return result
    raise HTTPException(status_code=500, detail=f"上限(テキスト20万文字・図PDF{request.pdf_max_mb:g}MB)に収められませんでした: " + " / ".join(problems))


def _pdf_parts_payload(pdf_parts: list[PdfPart]) -> list[dict]:
    return [
        {
            "index": index,
            "total": len(pdf_parts),
            "size": len(part.data),
            "figures": list(part.figures),
            "data_url": pdf_bytes_to_data_url(part.data),
        }
        for index, part in enumerate(pdf_parts, start=1)
    ]


def _response_body(markdown_text: str, text_parts: list[str], pdf_parts: list[PdfPart], stats: dict) -> dict:
    payload = _pdf_parts_payload(pdf_parts)
    return {
        "context": markdown_text,
        "chars": len(markdown_text),
        "text_parts": text_parts_payload(text_parts),
        "has_images": bool(pdf_parts),
        "pdf_parts": payload,
        "warning": attachment_warning(len(text_parts) + len(pdf_parts)),
        "stats": stats,
    }


@router.post("/context")
def mkdocs_context(request: MkDocsBundleRequest) -> dict:
    root, markdown_text, text_parts, pdf_parts, stats, _ = _build_within_limits(request)
    remember_repository(root, selected_files=request.selected_files or [])
    return _response_body(markdown_text, text_parts, pdf_parts, stats)


@router.post("/save_bundle")
def save_bundle(request: MkDocsBundleRequest) -> dict:
    problems: list[str] = []
    for attempt in range(MAX_ATTEMPTS):
        root, markdown_text, text_parts, pdf_parts, stats, problems = _build_bundle(request, attempt)
        if problems:
            continue
        save_dir = Path(request.target_dir.strip() or get_export_folder()).expanduser().resolve()
        save_dir.mkdir(parents=True, exist_ok=True)
        raw_base = request.file_base_name.strip() or stats.get("site_name") or root.name or "MkDocs_Context"
        base_name = safe_file_base_name(raw_base, ".md")
        md_paths = write_text_files(save_dir, base_name, "context", ".md", text_parts)
        pdf_paths = write_pdf_files(save_dir, base_name, "images", [part.data for part in pdf_parts])
        problems = verify_saved_files(md_paths, pdf_paths, pdf_max_bytes(request.pdf_max_mb))
        if not problems:
            break
    if problems:
        raise HTTPException(status_code=500, detail=f"上限(テキスト20万文字・図PDF{request.pdf_max_mb:g}MB)に収められませんでした: " + " / ".join(problems))

    remember_repository(root, selected_files=request.selected_files or [])
    body = _response_body(markdown_text, text_parts, pdf_parts, stats)
    body.update({
        "status": "success",
        "verified": True,
        "folder_path": str(save_dir),
        "markdown_files": [{"name": path.name, "path": str(path.resolve()), "chars": len(part)} for path, part in zip(md_paths, text_parts)],
        "pdf_files": [{"name": path.name, "path": str(path.resolve()), "size": len(part.data)} for path, part in zip(pdf_paths, pdf_parts)],
        "markdown_path": str(md_paths[0].resolve()),
        "markdown_name": md_paths[0].name,
        "pdf_path": str(pdf_paths[0].resolve()) if pdf_paths else None,
        "pdf_name": pdf_paths[0].name if pdf_paths else None,
    })
    return body


@router.post("/open_folder")
def open_export_folder(request: MkDocsExportConfigRequest) -> dict:
    folder = Path(request.export_folder.strip() or get_export_folder()).expanduser().resolve()
    folder.mkdir(parents=True, exist_ok=True)
    try:
        _open_in_file_manager(folder)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"フォルダを開けませんでした: {exc}") from exc
    return {"status": "success", "opened_path": str(folder)}
