"""APIルーター共通の入力検証 (deps.py)"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import HTTPException

from ..settings_store import get_settings_file, load_settings
from .schemas import DEFAULT_MKDOCS_EXPORT_FOLDER


def repository_root(value: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise HTTPException(status_code=400, detail=f"フォルダが存在しません: {value}")
    return path


def get_export_folder() -> str:
    """コンテキスト出力の保存先フォルダ設定（MkDocsモードとコードモードで共通）。"""
    ui_config = load_settings(get_settings_file()).get("ui", {})
    if isinstance(ui_config, dict):
        folder = str(ui_config.get("mkdocs_export_folder") or "").strip()
        if folder:
            return folder
    return DEFAULT_MKDOCS_EXPORT_FOLDER


def safe_file_base_name(raw: str, suffix: str = "") -> str:
    """ファイル名に使えない文字を除き、末尾の拡張子（suffix）を落とす。"""
    name = re.sub(r'[\\/:*?"<>|]', "_", raw).strip()
    if suffix and name.lower().endswith(suffix):
        name = name[: -len(suffix)]
    return name
