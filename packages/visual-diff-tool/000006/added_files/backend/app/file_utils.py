"""作業ツリー上のファイルを安全に読み書きする小さなヘルパー群。"""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException


def read_file_limited(path: Path, max_bytes: int, label: str) -> bytes:
    if path.stat().st_size > max_bytes:
        raise HTTPException(status_code=413, detail=f"{label} exceeds {max_bytes // (1024 * 1024)} MB")
    content = path.read_bytes()
    if len(content) > max_bytes:
        raise HTTPException(status_code=413, detail=f"{label} exceeds {max_bytes // (1024 * 1024)} MB")
    return content


def encode_like_original(text: str, original_encoding: str | None, label: str) -> bytes:
    """読み込み時と同じ文字コード（cp932 / BOM付きUTF-8 / UTF-8）で書き戻す。"""
    encoding = original_encoding if original_encoding in {"cp932", "utf-8-sig"} else "utf-8"
    try:
        return text.encode(encoding)
    except UnicodeEncodeError as exc:
        raise HTTPException(status_code=422, detail=f"{label} cannot be encoded as {encoding}") from exc


def write_bytes_atomically(destination: Path, content: bytes, error_detail: str) -> None:
    """同じフォルダーの一時ファイルへ書いてから置き換え、書き込み途中の壊れたファイルを残さない。"""
    temporary = destination.with_name(f".{destination.name}.visual-diff-{uuid4().hex}.tmp")
    try:
        temporary.write_bytes(content)
        temporary.replace(destination)
    except OSError as exc:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise HTTPException(status_code=500, detail=error_detail) from exc
