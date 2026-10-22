"""
AIインプット「2 ファイルを保存」の図面 PDF。

仕様:
- 社内AIは添付した画像を勝手に圧縮するため、図は PDF で渡す。図 1 枚（上部に図番号・所属ノート・リンク記法のラベル付き）を
  1 ページにする。ページの大きさは画像の縦横比のまま、1 ピクセル = 0.5pt（144dpi）を基本に、PDF の上限（14,400pt）に収める。
- 画質を落とさないよう、PNG の圧縮データ（IDAT）をそのまま FlateDecode + PNG 予測子で埋め込む（再圧縮しない）。
  RGB 8 ビット・インターレースなし以外の PNG は、白背景の RGB に直してから埋め込む。
- 最大サイズ（既定 10MB = 10,000,000 バイト、利用者が変えられる）を超えるときは、図の境目で複数の PDF に分け、
  各 PDF を最大サイズ以下にする。各 PDF は収録した図番号の範囲（最初, 最後）を持つ。
- 1 枚の図だけで最大サイズを超えるときは、呼び出し側から受け取った shrink(図, 縮小率) で PNG を作り直し、
  収まるまで少しずつ小さくする。
- 外部ライブラリは使わず PDF を書き出す（配布先で追加の依存を増やさない）。読み直しの確認と画像の取り出しは pypdf を使う。
"""

from __future__ import annotations

import io
import struct
import zlib
from dataclasses import dataclass
from typing import Callable, List, Optional, Sequence, Tuple

from PIL import Image

DEFAULT_FIGURE_PDF_MAX_BYTES = 10_000_000
# 1 ピクセルあたりのポイント数（144dpi）と、PDF のページの一辺の上限
_POINTS_PER_PIXEL = 0.5
_MAX_PAGE_POINTS = 14_400.0
# PDF の枠（カタログ・相互参照表など）と、1 ページあたりの付帯情報の見込み（容量の予算から差し引く）
_PDF_OVERHEAD_BYTES = 2_000
_PAGE_OVERHEAD_BYTES = 800
# 1 枚で最大サイズを超える図を小さくするときの縮小率
_SHRINK_SCALES = (0.85, 0.7, 0.55, 0.45, 0.35, 0.25, 0.18, 0.12)

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


@dataclass(frozen=True)
class FigurePage:
    """PDF の 1 ページにする図。index は図番号、png はラベル込みの図の PNG。"""

    index: int
    png: bytes


@dataclass(frozen=True)
class FigurePdfPart:
    """図面 PDF 1 つ分。figures は収録した図番号の範囲（最初, 最後）。"""

    data: bytes
    figures: Tuple[int, int]


ShrinkFn = Callable[[FigurePage, float], bytes]


def _rgb_png(png: bytes) -> bytes:
    """PNG を、白背景の RGB 8 ビット・インターレースなしの PNG にする。"""
    with Image.open(io.BytesIO(png)) as image:
        image.load()
        if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
            rgba = image.convert("RGBA")
            background = Image.new("RGB", rgba.size, (255, 255, 255))
            background.paste(rgba, mask=rgba.split()[-1])
            converted = background
        else:
            converted = image.convert("RGB")
    buf = io.BytesIO()
    converted.save(buf, format="PNG")
    return buf.getvalue()


def _png_image_data(png: bytes) -> Tuple[int, int, bytes]:
    """PNG から (幅, 高さ, IDAT の連結データ) を取り出す。RGB 8 ビット・インターレースなしでなければ変換する。"""
    for attempt in range(2):
        if not png.startswith(_PNG_SIGNATURE):
            raise ValueError("PNG ではありません")
        pos = len(_PNG_SIGNATURE)
        width = height = 0
        suitable = False
        idat = bytearray()
        while pos + 8 <= len(png):
            length, kind = struct.unpack(">I4s", png[pos:pos + 8])
            data = png[pos + 8:pos + 8 + length]
            if kind == b"IHDR":
                width, height, bit_depth, color_type, _comp, _filter, interlace = struct.unpack(">IIBBBBB", data)
                suitable = bit_depth == 8 and color_type == 2 and interlace == 0
            elif kind == b"IDAT":
                idat.extend(data)
            elif kind == b"IEND":
                break
            pos += 12 + length
        if suitable:
            return width, height, bytes(idat)
        if attempt == 0:
            png = _rgb_png(png)
    raise ValueError("PNG を RGB に変換できません")


def _page_size(width: int, height: int) -> Tuple[float, float]:
    scale = _POINTS_PER_PIXEL
    longest = max(width, height) * scale
    if longest > _MAX_PAGE_POINTS:
        scale = _MAX_PAGE_POINTS / max(width, height)
    return round(width * scale, 2), round(height * scale, 2)


def build_figure_pdf(pngs: Sequence[bytes]) -> bytes:
    """PNG の並びを、1 ページ 1 図の PDF にする（画像は再圧縮せずに埋め込む）。"""
    objects: List[bytes] = []

    def add(obj: bytes) -> int:
        objects.append(obj)
        return len(objects)

    catalog = add(b"")  # 後で埋める
    pages_obj = add(b"")
    page_refs: List[int] = []
    for png in pngs:
        width, height, idat = _png_image_data(png)
        page_width, page_height = _page_size(width, height)
        image_ref = add(
            b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 "
            b"/Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns %d >> "
            b"/Length %d >>\nstream\n" % (width, height, width, len(idat)) + idat + b"\nendstream"
        )
        content = b"q %.2f 0 0 %.2f 0 0 cm /Im0 Do Q" % (page_width, page_height)
        content_ref = add(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
        page_refs.append(add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %.2f %.2f] /Resources << /XObject << /Im0 %d 0 R >> >> "
            b"/Contents %d 0 R >>" % (pages_obj, page_width, page_height, image_ref, content_ref)
        ))
    objects[catalog - 1] = b"<< /Type /Catalog /Pages %d 0 R >>" % pages_obj
    kids = b" ".join(b"%d 0 R" % ref for ref in page_refs)
    objects[pages_obj - 1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, len(page_refs))

    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % number + body + b"\nendobj\n")
    xref_pos = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1))
    for offset in offsets:
        out.write(b"%010d 00000 n \n" % offset)
    out.write(b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, catalog, xref_pos))
    return out.getvalue()


def _fit_single(page: FigurePage, budget: int, shrink: Optional[ShrinkFn]) -> FigurePage:
    """1 枚で予算を超える図を、shrink で予算に収まるまで小さくする（shrink が無ければそのまま）。"""
    if len(page.png) + _PAGE_OVERHEAD_BYTES <= budget or shrink is None:
        return page
    png = page.png
    for scale in _SHRINK_SCALES:
        png = shrink(page, scale)
        if len(png) + _PAGE_OVERHEAD_BYTES <= budget:
            break
    return FigurePage(page.index, png)


def build_figure_pdf_parts(
    pages: Sequence[FigurePage],
    max_bytes: int = DEFAULT_FIGURE_PDF_MAX_BYTES,
    shrink: Optional[ShrinkFn] = None,
) -> List[FigurePdfPart]:
    """
    図を順に PDF へ詰め、各 PDF を max_bytes 以下にする（図の境目で分ける）。図が無ければ空のリスト。
    組み上がった PDF が最大サイズを超えたときは、その PDF の図を 2 つに分けて作り直す。
    """
    if not pages:
        return []
    budget = max_bytes - _PDF_OVERHEAD_BYTES
    fitted = [_fit_single(page, budget, shrink) for page in pages]

    groups: List[List[FigurePage]] = []
    current: List[FigurePage] = []
    size = 0
    for page in fitted:
        page_bytes = len(page.png) + _PAGE_OVERHEAD_BYTES
        if current and size + page_bytes > budget:
            groups.append(current)
            current, size = [], 0
        current.append(page)
        size += page_bytes
    if current:
        groups.append(current)

    parts: List[FigurePdfPart] = []

    def emit(group: List[FigurePage]) -> None:
        data = build_figure_pdf([page.png for page in group])
        if len(data) > max_bytes and len(group) > 1:
            half = len(group) // 2
            emit(group[:half])
            emit(group[half:])
            return
        parts.append(FigurePdfPart(data, (group[0].index, group[-1].index)))

    for group in groups:
        emit(group)
    return parts


def pdf_page_images(pdf: bytes) -> List[Image.Image]:
    """PDF の各ページの画像を取り出す（確認・テスト用）。"""
    from pypdf import PdfReader

    images = []
    for page in PdfReader(io.BytesIO(pdf)).pages:
        for embedded in page.images:
            images.append(embedded.image)
            break
    return images
