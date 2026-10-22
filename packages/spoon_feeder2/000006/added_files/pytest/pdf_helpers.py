"""テスト用: 図PDFに埋め込まれた各ページの画像を取り出してPILで開く (pdf_helpers.py)

仕様:
1. Flate+PNGプレディクタで埋め込まれたページは、IDATをそのままPNGに包み直して復号する（無劣化の確認用）。
2. DCTDecode（JPEG）のページはそのままJPEGとして開く。
"""

from __future__ import annotations

import io
import re
import struct
import zlib

from PIL import Image

_IMAGE_OBJECT = re.compile(rb"/Width (\d+) /Height (\d+) /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter (/\w+)(?: /DecodeParms << [^>]*? >>)? /Length (\d+) >>\nstream\n")


def _chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))


def pdf_page_images(data: bytes) -> list[Image.Image]:
    images = []
    for match in _IMAGE_OBJECT.finditer(data):
        width, height, kind, length = int(match[1]), int(match[2]), match[3], int(match[4])
        stream = data[match.end() : match.end() + length]
        if kind == b"/FlateDecode":
            png = b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + _chunk(b"IDAT", stream) + _chunk(b"IEND", b"")
            images.append(Image.open(io.BytesIO(png)).convert("RGB"))
        else:
            images.append(Image.open(io.BytesIO(stream)).convert("RGB"))
    return images
