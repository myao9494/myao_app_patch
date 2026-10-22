"""
図面 PDF（app.vector.figure_pdf）のテスト。

仕様:
- 図 1 枚を 1 ページにした PDF を作る。PNG のデータをそのまま埋め込み（FlateDecode + PNG 予測子）、画質を落とさない。
- PDF は pypdf で読め、ページ数は図の数と同じ。ページから取り出した画像は元の画素と一致する。
- 最大サイズ（既定 10MB = 10,000,000 バイト）を超えるときは、図の境目で複数の PDF に分け、各 PDF を最大サイズ以下にする。
  各 PDF は収録した図番号の範囲を持つ。
- 1 枚の図だけで最大サイズを超えるときは、shrink（縮小して PNG を作り直す関数）で収まるまで小さくする。
"""

from __future__ import annotations

import io
import random

import pytest
from PIL import Image
from pypdf import PdfReader

from app.vector.figure_pdf import (
    DEFAULT_FIGURE_PDF_MAX_BYTES,
    FigurePage,
    build_figure_pdf,
    build_figure_pdf_parts,
    pdf_page_images,
)


def _png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def _noise(width: int, height: int, seed: int) -> Image.Image:
    rng = random.Random(seed)
    return Image.frombytes("RGB", (width, height), bytes(rng.getrandbits(8) for _ in range(width * height * 3)))


def test_default_max_size_is_10mb() -> None:
    assert DEFAULT_FIGURE_PDF_MAX_BYTES == 10_000_000


def test_pdf_has_one_page_per_figure_and_keeps_pixels() -> None:
    images = [_noise(120, 80, 1), Image.new("RGB", (60, 200), (10, 200, 30))]
    pdf = build_figure_pdf([_png(image) for image in images])

    reader = PdfReader(io.BytesIO(pdf))
    assert len(reader.pages) == 2
    extracted = pdf_page_images(pdf)
    for original, page_image in zip(images, extracted):
        assert page_image.size == original.size
        assert page_image.convert("RGB").tobytes() == original.tobytes(), "画質を落とさず埋め込む"


def test_page_size_follows_image_aspect_and_stays_within_pdf_limits() -> None:
    pdf = build_figure_pdf([_png(Image.new("RGB", (400, 100), (255, 255, 255))), _png(Image.new("RGB", (100, 40_000), (0, 0, 0)))])
    reader = PdfReader(io.BytesIO(pdf))
    wide, tall = reader.pages
    assert float(wide.mediabox.width) / float(wide.mediabox.height) == pytest.approx(4.0)
    assert max(float(tall.mediabox.width), float(tall.mediabox.height)) <= 14_400


def test_rgba_and_palette_images_are_embedded_as_rgb() -> None:
    rgba = Image.new("RGBA", (30, 30), (255, 0, 0, 128))
    pdf = build_figure_pdf([_png(rgba), _png(Image.new("P", (20, 20)))])
    assert len(PdfReader(io.BytesIO(pdf)).pages) == 2


def test_parts_fit_max_size_and_keep_figure_ranges() -> None:
    pages = [FigurePage(index=i, png=_png(_noise(150, 150, i))) for i in range(1, 7)]
    parts = build_figure_pdf_parts(pages, max_bytes=150_000)

    assert len(parts) > 1
    assert all(len(part.data) <= 150_000 for part in parts)
    ranges = [part.figures for part in parts]
    assert ranges[0][0] == 1 and ranges[-1][1] == 6
    for (_, prev_end), (next_start, _) in zip(ranges, ranges[1:]):
        assert next_start == prev_end + 1
    assert sum(len(PdfReader(io.BytesIO(part.data)).pages) for part in parts) == 6


def test_everything_in_one_pdf_when_within_limit() -> None:
    pages = [FigurePage(index=i, png=_png(Image.new("RGB", (50, 50), (i, i, i)))) for i in range(1, 4)]
    parts = build_figure_pdf_parts(pages)
    assert len(parts) == 1
    assert parts[0].figures == (1, 3)


def test_single_figure_over_limit_is_shrunk_to_fit() -> None:
    big = _noise(300, 300, 9)
    calls = []

    def shrink(page: FigurePage, scale: float) -> bytes:
        calls.append(scale)
        return _png(big.resize((max(1, int(300 * scale)), max(1, int(300 * scale)))))

    parts = build_figure_pdf_parts([FigurePage(index=1, png=_png(big))], max_bytes=100_000, shrink=shrink)

    assert len(parts) == 1
    assert len(parts[0].data) <= 100_000
    assert calls and calls == sorted(calls, reverse=True), "少しずつ小さくする"
