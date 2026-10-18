"""MkDocs統合マークダウン＋結合画像の生成・保存・フォルダ表示API (mkdocs.py)"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException

from ..mkdocs_support import build_mkdocs_bundle, image_bytes_to_data_url
from ..settings_store import get_settings_file, load_settings, remember_repository, settings_transaction
from .deps import repository_root
from .schemas import DEFAULT_MKDOCS_EXPORT_FOLDER, MkDocsBundleRequest, MkDocsExportConfigRequest

router = APIRouter(prefix="/mkdocs")


def _get_export_folder() -> str:
    ui_config = load_settings(get_settings_file()).get("ui", {})
    if isinstance(ui_config, dict):
        folder = str(ui_config.get("mkdocs_export_folder") or "").strip()
        if folder:
            return folder
    return DEFAULT_MKDOCS_EXPORT_FOLDER


def _open_in_file_manager(folder: Path) -> None:
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(folder)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elif os.name == "nt":
        os.startfile(str(folder))  # type: ignore[attr-defined]
    else:
        subprocess.Popen(["xdg-open", str(folder)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


@router.get("/export_config")
def get_export_config() -> dict:
    return {"export_folder": _get_export_folder()}


@router.post("/export_config")
def save_export_config(request: MkDocsExportConfigRequest) -> dict:
    folder = request.export_folder.strip() or DEFAULT_MKDOCS_EXPORT_FOLDER
    with settings_transaction() as settings:
        settings.setdefault("ui", {})["mkdocs_export_folder"] = folder
    return {"status": "success", "export_folder": folder}


def _build_bundle(request: MkDocsBundleRequest):
    root = repository_root(request.library_path)
    markdown_text, image_bytes, stats = build_mkdocs_bundle(root=root, selected_files=request.selected_files, title=request.title)
    remember_repository(root, selected_files=request.selected_files or [])
    return root, markdown_text, image_bytes or None, stats


@router.post("/context")
def mkdocs_context(request: MkDocsBundleRequest) -> dict:
    _, markdown_text, image_bytes, stats = _build_bundle(request)
    return {
        "context": markdown_text,
        "has_images": image_bytes is not None,
        "image_data_url": image_bytes_to_data_url(image_bytes),
        "stats": stats,
    }


@router.post("/save_bundle")
def save_bundle(request: MkDocsBundleRequest) -> dict:
    root, markdown_text, image_bytes, stats = _build_bundle(request)

    save_dir = Path(request.target_dir.strip() or _get_export_folder()).expanduser().resolve()
    save_dir.mkdir(parents=True, exist_ok=True)

    raw_base = request.file_base_name.strip() or stats.get("site_name") or root.name or "MkDocs_Context"
    base_name = re.sub(r'[\\/:*?"<>|]', "_", raw_base).strip()
    if base_name.lower().endswith(".md"):
        base_name = base_name[:-3]

    md_file = save_dir / f"{base_name}_context.md"
    md_file.write_text(markdown_text, encoding="utf-8")

    image_path = image_name = None
    if image_bytes is not None:
        extension = ".png" if image_bytes.startswith(b"\x89PNG\r\n\x1a\n") else ".jpg"
        image_file = save_dir / f"{base_name}_images{extension}"
        image_file.write_bytes(image_bytes)
        image_path, image_name = str(image_file.resolve()), image_file.name

    return {
        "status": "success",
        "folder_path": str(save_dir),
        "markdown_path": str(md_file.resolve()),
        "markdown_name": md_file.name,
        "image_path": image_path,
        "image_name": image_name,
        "has_images": image_bytes is not None,
        "context": markdown_text,
        "image_data_url": image_bytes_to_data_url(image_bytes),
        "stats": stats,
    }


@router.post("/open_folder")
def open_export_folder(request: MkDocsExportConfigRequest) -> dict:
    folder = Path(request.export_folder.strip() or _get_export_folder()).expanduser().resolve()
    folder.mkdir(parents=True, exist_ok=True)
    try:
        _open_in_file_manager(folder)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"フォルダを開けませんでした: {exc}") from exc
    return {"status": "success", "opened_path": str(folder)}
