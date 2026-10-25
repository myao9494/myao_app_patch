"""
サーバー設定（Obsidianフォルダー・レポート保存先）の読み書き。
- 保存先は `backend/.visual-diff-settings.json`（環境変数 VISUAL_DIFF_SETTINGS_PATH で変更可）
- ファイルが無い・壊れている場合は空設定として扱う（初回起動や会社環境でもエラーにしない）
- 書き込みは一時ファイル経由の置き換えで行い、途中で壊れた設定ファイルを残さない
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import HTTPException

SERVER_SETTINGS_PATH = Path(os.environ.get("VISUAL_DIFF_SETTINGS_PATH", Path(__file__).resolve().parents[1] / ".visual-diff-settings.json"))


def validated_directory_setting(value: object, label: str, *, required: bool = False) -> str:
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


def load_server_settings() -> dict:
    try:
        value = json.loads(SERVER_SETTINGS_PATH.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}


def save_server_settings(settings: dict) -> None:
    SERVER_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = SERVER_SETTINGS_PATH.with_suffix(f"{SERVER_SETTINGS_PATH.suffix}.tmp")
    temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(SERVER_SETTINGS_PATH)
