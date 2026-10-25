"""
アップロード内容のラスター化キャッシュ。
- キーは「拡張子・DPI・ページ番号・内容のSHA-256」。同じファイルのプレビューと比較で変換を繰り返さない
- 件数（16件）と推定メモリ量（512MB）の上限を超えたら古いものから破棄する（LRU）
"""

from __future__ import annotations

import hashlib
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from threading import Lock

from .image_io import RasterPage, rasterize_upload_page

MAX_CACHE_ITEMS = 16
MAX_CACHE_BYTES = 512 * 1024 * 1024


@dataclass(frozen=True)
class CachedRaster:
    fmt: str
    page: RasterPage
    size_bytes: int


_cache: OrderedDict[str, CachedRaster] = OrderedDict()
_cache_bytes = 0
_lock = Lock()


def rasterize_upload_page_cached(filename: str, content: bytes, page: int = 0, dpi: int = 180) -> tuple[str, RasterPage]:
    key = _cache_key(filename, content, dpi, page)
    with _lock:
        cached = _cache.get(key)
        if cached:
            _cache.move_to_end(key)
            return cached.fmt, cached.page

    fmt, raster_page = rasterize_upload_page(filename, content, page=page, dpi=dpi)
    size_bytes = _estimate_page_bytes(raster_page)
    if size_bytes > MAX_CACHE_BYTES:
        return fmt, raster_page

    global _cache_bytes
    with _lock:
        replaced = _cache.pop(key, None)
        if replaced:
            _cache_bytes -= replaced.size_bytes
        _cache[key] = CachedRaster(fmt=fmt, page=raster_page, size_bytes=size_bytes)
        _cache_bytes += size_bytes
        _evict_if_needed()
    return fmt, raster_page


def _cache_key(filename: str, content: bytes, dpi: int, page: int) -> str:
    suffix = Path(filename or "upload").suffix.lower()
    digest = hashlib.sha256(content).hexdigest()
    return f"{suffix}:{dpi}:page-{page}:{digest}"


def _estimate_page_bytes(page: RasterPage) -> int:
    return page.image.width * page.image.height * len(page.image.getbands())


def _evict_if_needed() -> None:
    global _cache_bytes
    while len(_cache) > MAX_CACHE_ITEMS or _cache_bytes > MAX_CACHE_BYTES:
        _, removed = _cache.popitem(last=False)
        _cache_bytes -= removed.size_bytes
