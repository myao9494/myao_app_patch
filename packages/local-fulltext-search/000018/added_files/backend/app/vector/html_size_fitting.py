"""
AI用HTMLを社内AIの上限（テキスト 20 万文字・ファイル 4.5MB）に収める分割・画像圧縮。

仕様:
- HTML は「節」（ノート 1 件の記事、またはメール 1 通の記事）の並びとして受け取り、
  render(節の並び, 番号, 全体数) で 1 つの HTML ファイルに組み立てる（組み立て方は html_exporter が決める）。
- 文字数は埋め込み画像の base64 部分を除いて数える（output_limits.html_text_chars）。容量は UTF-8 のバイト数。
- 収め方（spoon_feeder2 の結合画像と同じ規則）:
  1. 全体が上限以内なら 1 ファイル。
  2. 文字数は上限以内で、容量が分割しきい値（6MB）以下なら、埋め込み画像を縮小・JPEG 化して 1 ファイルに収める。
  3. それ以外は、節の境目で複数ファイルに振り分ける（順序は保つ）。1 節だけで容量の上限を超えるものは先に画像を縮小し、
     組み上がって容量が上限を超えるファイルも画像を縮小する。
  1 つの節が文字数の上限を超える場合の分け方は呼び出し側（html_exporter）が受け持つ。
- 画像の縮小は、一定以上の大きさの埋め込み画像（PNG / JPEG / WebP / GIF / BMP、ラスタライズできる SVG）を
  白背景の JPEG にし、段階的に縮小率と品質を下げて上限に収める。元より大きくなる場合は元の画像を残す。
"""

from __future__ import annotations

import base64
import io
import logging
import re
from dataclasses import dataclass
from typing import Callable, List, Optional, Sequence, Tuple

from PIL import Image

from app.vector.output_limits import html_text_chars

logger = logging.getLogger(__name__)

# 縮小の段階（縮小率, JPEG 品質）
_SHRINK_STEPS: Tuple[Tuple[float, int], ...] = (
    (1.0, 85), (0.85, 75), (0.7, 65), (0.55, 55), (0.45, 45), (0.35, 40), (0.25, 35),
)
# これより小さい埋め込み画像は縮小しない（アイコンなど）
_MIN_SHRINK_PAYLOAD = 30_000
_IMAGE_DATA_URL = re.compile(r"data:(image/[\w.+-]+);base64,([A-Za-z0-9+/=]+)")


@dataclass(frozen=True)
class HtmlSection:
    """HTML の節（ノート 1 件またはメール 1 通の記事）。toc は目次の 1 行、article は本文。"""

    kind: str
    toc: str
    article: str


RenderFn = Callable[[Sequence[HtmlSection], int, int], str]


def html_bytes(html: str) -> int:
    return len(html.encode("utf-8"))


def _decode_image(mime: str, payload: str) -> Optional[Image.Image]:
    """埋め込み画像を PIL 画像にする。読めなければ None。"""
    try:
        raw = base64.b64decode(payload)
    except ValueError:
        return None
    if mime == "image/svg+xml":
        from app.vector.markdown_image_exporter import convert_svg_to_pil_image

        return convert_svg_to_pil_image(raw)
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
        return image
    except (OSError, ValueError):
        return None


def shrink_embedded_images(html: str, target_bytes: int) -> str:
    """
    埋め込み画像を段階的に縮小・JPEG 化し、HTML 全体を target_bytes 以下にする。
    最後の段階でも収まらなければ、最も小さくした HTML を返す。
    """
    if html_bytes(html) <= target_bytes:
        return html
    from app.vector.markdown_image_exporter import flatten_to_rgb

    targets = []
    for match in _IMAGE_DATA_URL.finditer(html):
        if len(match.group(2)) < _MIN_SHRINK_PAYLOAD:
            continue
        image = _decode_image(match.group(1), match.group(2))
        if image is None:
            continue
        targets.append((match, flatten_to_rgb(image)))
    if not targets:
        return html

    candidate = html
    for scale, quality in _SHRINK_STEPS:
        pieces: List[str] = []
        last = 0
        for match, image in targets:
            if scale < 1.0:
                width = max(1, int(image.width * scale))
                height = max(1, int(image.height * scale))
                resized = image.resize((width, height), Image.Resampling.LANCZOS)
            else:
                resized = image
            buf = io.BytesIO()
            resized.save(buf, format="JPEG", quality=quality, optimize=True)
            encoded = base64.b64encode(buf.getvalue()).decode("ascii")
            original = match.group(0)
            replacement = f"data:image/jpeg;base64,{encoded}"
            pieces.append(html[last:match.start()])
            pieces.append(replacement if len(replacement) < len(original) else original)
            last = match.end()
        pieces.append(html[last:])
        candidate = "".join(pieces)
        if html_bytes(candidate) <= target_bytes:
            return candidate
    logger.warning("Embedded images could not be shrunk below %d bytes (now %d).", target_bytes, html_bytes(candidate))
    return candidate


def _pack_sections(
    sections: Sequence[HtmlSection],
    overhead_chars: int,
    overhead_bytes: int,
    text_limit: int,
    size_limit: int,
) -> List[List[HtmlSection]]:
    """
    節を順に詰め、各ファイルが文字数・容量の予算に収まるよう振り分ける。
    1 節だけで容量の予算を超えるものは、先に画像を縮小してから詰める（縮小後は前後の節と同じファイルに入れられる）。
    それでも予算を超える節は単独にする。
    """
    char_budget = text_limit - overhead_chars
    byte_budget = size_limit - overhead_bytes
    fitted: List[HtmlSection] = []
    for section in sections:
        section_bytes = html_bytes(section.toc) + html_bytes(section.article)
        if section_bytes > byte_budget:
            article = shrink_embedded_images(section.article, byte_budget - html_bytes(section.toc))
            section = HtmlSection(section.kind, section.toc, article)
        fitted.append(section)
    groups: List[List[HtmlSection]] = []
    current: List[HtmlSection] = []
    chars = 0
    size = 0
    for section in fitted:
        section_chars = html_text_chars(section.toc) + html_text_chars(section.article)
        section_bytes = html_bytes(section.toc) + html_bytes(section.article)
        if current and (chars + section_chars > char_budget or size + section_bytes > byte_budget):
            groups.append(current)
            current, chars, size = [], 0, 0
        current.append(section)
        chars += section_chars
        size += section_bytes
    if current:
        groups.append(current)
    return groups


def fit_html_parts(
    sections: Sequence[HtmlSection],
    render: RenderFn,
    text_limit: int,
    size_limit: int,
    split_threshold: int,
) -> Tuple[str, List[str]]:
    """
    節の並びを、文字数 text_limit・容量 size_limit 以内の 1 つ以上の HTML にする。
    戻り値: (分割前の HTML 全体, 各ファイルの HTML)。
    """
    whole = render(sections, 1, 1)
    whole_chars = html_text_chars(whole)
    whole_bytes = html_bytes(whole)
    if whole_chars <= text_limit and whole_bytes <= size_limit:
        return whole, [whole]
    if whole_chars <= text_limit and whole_bytes <= split_threshold:
        shrunk = shrink_embedded_images(whole, size_limit)
        if html_bytes(shrunk) <= size_limit:
            return whole, [shrunk]

    # 分割注記・目次の枠の分を見込むため、全体数を大きめにして空の HTML を測る
    frame = render([], 99, 99)
    groups = _pack_sections(sections, html_text_chars(frame), html_bytes(frame), text_limit, size_limit)
    total = len(groups)
    parts = []
    for index, group in enumerate(groups, start=1):
        part = render(group, index, total)
        if html_bytes(part) > size_limit:
            part = shrink_embedded_images(part, size_limit)
        parts.append(part)
    return whole, parts
