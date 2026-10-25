"""
サーバー設定とレポート保存API。
GET/PUT /api/settings/obsidian, POST /api/reports/save
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from ..file_utils import write_bytes_atomically
from ..settings_store import (
    load_server_settings,
    save_server_settings,
    validated_directory_setting,
)

router = APIRouter()


MAX_REPORT_BYTES = 50 * 1024 * 1024


@router.get("/api/settings/obsidian")
def get_obsidian_settings() -> JSONResponse:
    settings = load_server_settings()
    return JSONResponse(
        {
            "obsidian_folder": settings.get("obsidian_folder", ""),
            "obsidian_report_folder": settings.get("obsidian_report_folder", ""),
        }
    )


@router.put("/api/settings/obsidian")
def update_obsidian_settings(payload: dict) -> JSONResponse:
    settings = load_server_settings()
    raw_folder = (
        validated_directory_setting(payload.get("obsidian_folder"), "Obsidianフォルダー")
        if "obsidian_folder" in payload
        else str(settings.get("obsidian_folder") or "")
    )
    raw_report_folder = (
        validated_directory_setting(payload.get("obsidian_report_folder"), "Obsidianレポート保存先")
        if "obsidian_report_folder" in payload
        else str(settings.get("obsidian_report_folder") or "")
    )
    settings["obsidian_folder"] = raw_folder
    settings["obsidian_report_folder"] = raw_report_folder
    save_server_settings(settings)
    return JSONResponse({"obsidian_folder": raw_folder, "obsidian_report_folder": raw_report_folder})


@router.post("/api/reports/save")
def save_report(payload: dict) -> JSONResponse:
    html = str(payload.get("html") or "")
    if not html:
        raise HTTPException(status_code=422, detail="html is required")
    if len(html.encode("utf-8")) > MAX_REPORT_BYTES:
        raise HTTPException(status_code=413, detail="HTML report is too large")

    settings = load_server_settings()
    # The destination is an administrator/user configured server setting. Do not
    # accept a per-request override, otherwise any page able to call the local API
    # could write a report into an arbitrary existing directory.
    raw_folder = str(settings.get("obsidian_report_folder") or "").strip()
    if not raw_folder:
        raise HTTPException(status_code=422, detail="Obsidianレポート保存先が未設定です")
    folder = validated_directory_setting(raw_folder, "Obsidianレポート保存先", required=True)
    filename = Path(str(payload.get("filename") or "差分レポート.html")).name.strip()
    if not filename:
        filename = "差分レポート.html"
    if not filename.lower().endswith(".html"):
        filename = f"{filename}.html"
    destination = Path(folder) / filename
    write_bytes_atomically(destination, html.encode("utf-8"), "HTMLレポートを保存できませんでした")
    return JSONResponse({"filename": filename, "path": str(destination), "size": len(html.encode("utf-8"))})
