"""APIルーター共通の入力検証 (deps.py)"""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException


def repository_root(value: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise HTTPException(status_code=400, detail=f"フォルダが存在しません: {value}")
    return path
