"""
複数のルーターで共有するリクエスト/レスポンスのスキーマ
"""
from typing import Optional

from pydantic import BaseModel


class FileItem(BaseModel):
    """ファイル/フォルダアイテムのスキーマ"""

    name: str
    type: str  # "file" or "directory"
    path: str
    size: Optional[int] = None
    modified: Optional[str] = None


class OpenRequest(BaseModel):
    path: str
    prefer_embedded: bool = False
