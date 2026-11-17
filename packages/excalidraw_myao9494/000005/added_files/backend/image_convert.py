"""
画像の WebP 変換（Obsidian の obsidian-image-converter と同じ方針）

- 設定は obsidian-dagnetz の image-converter に合わせた定数（WebP 品質 75・リサイズなし）
- 変換後の削減量が MIN_SAVINGS_BYTES 未満、または元より大きくなる場合は元の画像のまま保存する
- GIF・SVG・WebP・tif・heic と、*.drawio.* / *.excalidraw.* は変換しない
- 新しい画像のファイル名は {図面名}-{タイムスタンプ}.<拡張子>（同名があれば -1, -2 ...）
"""
import io
import logging
import re
from datetime import datetime
from fnmatch import fnmatch
from pathlib import Path
from typing import Optional

logger = logging.getLogger("excalidraw.image_convert")

WEBP_QUALITY = 75
MIN_SAVINGS_BYTES = 30 * 1024

SKIP_MIME_TYPES = frozenset({
    "image/gif",
    "image/svg+xml",
    "image/webp",
    "image/tiff",
    "image/heic",
    "image/heif",
})
SKIP_FILENAME_PATTERNS = (
    "*.drawio.png", "*.drawio.svg", "*.dio.png", "*.dio.svg",
    "*.excalidraw.png", "*.excalidraw.svg",
)

_INVALID_FILENAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def should_skip_conversion(mime_type: str, filename: Optional[str]) -> bool:
    """WebP 変換の対象外か。filename は元のファイル名が分かるときだけ渡す。"""
    if mime_type.lower() in SKIP_MIME_TYPES:
        return True
    if filename:
        name = Path(filename).name.lower()
        return any(fnmatch(name, pattern) for pattern in SKIP_FILENAME_PATTERNS)
    return False


def convert_to_webp(image_bytes: bytes, mime_type: str, force: bool = False) -> Optional[bytes]:
    """
    画像を WebP（品質 75・リサイズなし）に変換して返す。

    変換しない（または変換できない）場合は None を返し、呼び出し側は元の画像を使う。
    force=True のときは削減量・サイズの比較をせず、変換できれば必ず返す。
    """
    try:
        from PIL import Image, ImageOps
    except ImportError:
        logger.warning("Pillow がないため WebP 変換をスキップします")
        return None

    try:
        with Image.open(io.BytesIO(image_bytes)) as image:
            image = ImageOps.exif_transpose(image)
            if image.mode not in ("RGB", "RGBA"):
                has_alpha = image.mode in ("LA", "PA") or "transparency" in image.info
                image = image.convert("RGBA" if has_alpha else "RGB")
            buffer = io.BytesIO()
            image.save(buffer, format="WEBP", quality=WEBP_QUALITY)
    except Exception as e:
        logger.warning("WebP 変換に失敗しました (%s): %s", mime_type, e)
        return None

    webp_bytes = buffer.getvalue()
    if force:
        return webp_bytes
    if len(webp_bytes) >= len(image_bytes) or len(image_bytes) - len(webp_bytes) < MIN_SAVINGS_BYTES:
        return None
    return webp_bytes


def build_image_filename(directory: Path, note_filename: str, extension: str) -> str:
    """{図面名}-{タイムスタンプ}.<拡張子>。同名が既にあれば -1, -2 ... を付ける。"""
    note_name = note_filename
    if note_name.lower().endswith(".md"):
        note_name = note_name[:-3]
    if note_name.lower().endswith(".excalidraw"):
        note_name = note_name[: -len(".excalidraw")]
    note_name = _INVALID_FILENAME_CHARS.sub("_", note_name).strip() or "image"

    base = f"{note_name}-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    candidate = f"{base}.{extension}"
    counter = 1
    while (directory / candidate).exists():
        candidate = f"{base}-{counter}.{extension}"
        counter += 1
    return candidate
