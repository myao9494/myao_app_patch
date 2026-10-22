"""図PDFの生成 (pdf_output.py)

仕様:
1. 1図1ページのPDFを組み立てる。ページ内容はRGB画像（ラベル帯込み）で、外部ライブラリを使わず最小限のPDFを直接書き出す。
2. 画像は可能な限り無劣化で埋め込む。PNGの圧縮済みデータ（IDAT）をそのままFlateDecode＋PNGプレディクタで格納するため、
   再エンコードによる劣化がない。会社AI側の自動圧縮を避けるための形式でもある。
3. 1ページが上限に収まらないときだけ、そのページを縮小・JPEG化（DCTDecode）して収める。
4. 複数ページは並び順のまま上限以内になるよう貪欲にまとめ、超える分は次のPDFへ分割する（pack_pages）。
"""

from __future__ import annotations

import io
import struct
from dataclasses import dataclass

from PIL import Image

# PDF全体の固定部分（ヘッダー・カタログ・xref・トレーラー）と1ページあたりの管理情報の見込み。
_BASE_OVERHEAD = 1_000
_PER_PAGE_OVERHEAD = 700
# ビューアが扱えるページ寸法の上限（pt）。これを超える画像はページ寸法だけ縮める（画素は縮めない）。
_MAX_PAGE_POINTS = 14_400
_SCALES = (1.0, 0.85, 0.7, 0.55, 0.45, 0.35, 0.25, 0.18, 0.12)
_QUALITIES = (92, 85, 75, 60, 45)


@dataclass(frozen=True)
class PdfPage:
    """PDFの1ページ分。data は埋め込み画像のストリーム（Flate+PNGプレディクタ または JPEG）。"""

    width: int
    height: int
    filter: str
    decode_parms: str
    data: bytes

    @property
    def cost(self) -> int:
        """このページをPDFへ追加したときの増加バイト数の見込み。"""
        return len(self.data) + _PER_PAGE_OVERHEAD


def _png_idat(png: bytes) -> bytes:
    """PNGから圧縮済み画素データ(IDAT)を連結して取り出す。"""
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("PNGではありません")
    chunks = []
    position = 8
    while position + 8 <= len(png):
        length, kind = struct.unpack(">I4s", png[position : position + 8])
        if kind == b"IDAT":
            chunks.append(png[position + 8 : position + 8 + length])
        position += 12 + length
    return b"".join(chunks)


def encode_lossless(image: Image.Image) -> PdfPage:
    """RGB画像を無劣化で埋め込む（PNGの圧縮データをFlateDecode＋Predictor 15でそのまま使う）。"""
    rgb = image.convert("RGB")
    buffer = io.BytesIO()
    rgb.save(buffer, format="PNG", optimize=True)
    parms = f"<< /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns {rgb.width} >>"
    return PdfPage(rgb.width, rgb.height, "/FlateDecode", parms, _png_idat(buffer.getvalue()))


def encode_jpeg(image: Image.Image, scale: float, quality: int) -> PdfPage:
    rgb = image.convert("RGB")
    if scale < 1.0:
        rgb = rgb.resize((max(1, int(rgb.width * scale)), max(1, int(rgb.height * scale))), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    rgb.save(buffer, format="JPEG", quality=quality, optimize=True)
    return PdfPage(rgb.width, rgb.height, "/DCTDecode", "", buffer.getvalue())


def encode_page(image: Image.Image, budget: int) -> PdfPage:
    """
    1ページ分の画像を budget バイト以内で埋め込む。無劣化で収まればそれを使い、
    収まらなければ縮小・JPEG化を段階的に強めて最初に収まったものを採用する（最後まで収まらなければ最小のもの）。
    """
    page = encode_lossless(image)
    if len(page.data) <= budget:
        return page
    smallest = page
    for scale in _SCALES:
        for quality in _QUALITIES:
            candidate = encode_jpeg(image, scale, quality)
            if len(candidate.data) <= budget:
                return candidate
            if len(candidate.data) < len(smallest.data):
                smallest = candidate
    return smallest


def page_budget(max_bytes: int) -> int:
    """1ページだけでPDFを作ったとき、ストリームに使える最大バイト数。"""
    return max(1, max_bytes - _BASE_OVERHEAD - _PER_PAGE_OVERHEAD)


def pack_pages(pages: list[PdfPage], max_bytes: int) -> list[list[int]]:
    """ページ番号(0始まり)を並び順のまま、各グループが max_bytes に収まる見込みになるよう分ける。"""
    groups: list[list[int]] = []
    current: list[int] = []
    used = _BASE_OVERHEAD
    for index, page in enumerate(pages):
        if current and used + page.cost > max_bytes:
            groups.append(current)
            current, used = [], _BASE_OVERHEAD
        current.append(index)
        used += page.cost
    if current:
        groups.append(current)
    return groups


def _page_points(width: int, height: int) -> tuple[float, float]:
    shrink = min(1.0, _MAX_PAGE_POINTS / max(width, height))
    return round(width * shrink, 2), round(height * shrink, 2)


def assemble_pdf(pages: list[PdfPage]) -> bytes:
    """ページ列から1つのPDFを組み立てる。オブジェクト番号は 1=Catalog, 2=Pages, ページ k は 3+3k(Page)/4+3k(内容)/5+3k(画像)。"""
    if not pages:
        raise ValueError("ページがありません")
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []

    def add(body: bytes) -> None:
        offsets.append(len(out))
        out.extend(f"{len(offsets)} 0 obj\n".encode("ascii"))
        out.extend(body)
        out.extend(b"\nendobj\n")

    kids = " ".join(f"{3 + 3 * k} 0 R" for k in range(len(pages)))
    add(b"<< /Type /Catalog /Pages 2 0 R >>")
    add(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode("ascii"))
    for k, page in enumerate(pages):
        points_w, points_h = _page_points(page.width, page.height)
        add(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {points_w} {points_h}] "
            f"/Resources << /XObject << /Im0 {5 + 3 * k} 0 R >> >> /Contents {4 + 3 * k} 0 R >>".encode("ascii")
        )
        content = f"q {points_w} 0 0 {points_h} 0 0 cm /Im0 Do Q".encode("ascii")
        add(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
        parms = f" /DecodeParms {page.decode_parms}" if page.decode_parms else ""
        head = (
            f"<< /Type /XObject /Subtype /Image /Width {page.width} /Height {page.height} "
            f"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter {page.filter}{parms} /Length {len(page.data)} >>\nstream\n"
        ).encode("ascii")
        add(head + page.data + b"\nendstream")

    xref_at = len(out)
    out.extend(f"xref\n0 {len(offsets) + 1}\n".encode("ascii"))
    out.extend(b"0000000000 65535 f \n")
    for offset in offsets:
        out.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    out.extend(f"trailer\n<< /Size {len(offsets) + 1} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n".encode("ascii"))
    return bytes(out)


def count_pdf_pages(data: bytes) -> int:
    """assemble_pdf が書いた構造から、ページ数を読み戻す（読み直し検証用）。壊れていれば ValueError。"""
    if not data.startswith(b"%PDF-") or not data.rstrip().endswith(b"%%EOF"):
        raise ValueError("PDFとして完結していません")
    tail = data[data.rfind(b"startxref") :].split()
    if len(tail) < 3:
        raise ValueError("xrefの位置が読めません")
    xref_at = int(tail[1])
    table = data[xref_at:].split(b"\n")
    if not table[0].startswith(b"xref"):
        raise ValueError("xrefが見つかりません")
    count = int(table[1].split()[1])
    for number in range(1, count):
        offset = int(table[2 + number][:10])
        if not data[offset:].startswith(f"{number} 0 obj".encode("ascii")):
            raise ValueError(f"オブジェクト{number}の位置が不正です")
    catalog = data[int(table[3][:10]) :]
    marker = catalog[catalog.find(b"/Count") :].split()
    return int(marker[1])
