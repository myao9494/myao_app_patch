"""
AIインプット出力の上限（テキスト 20 万文字・ファイル 4.5MB）に収めるための分割・命名・検証。

仕様（社内AIの添付制限に合わせる。spoon_feeder2 の output_limits と同じ規則）:
1. テキストは MAX_TEXT_CHARS 文字以内、ファイル（画像・HTML）は MAX_IMAGE_BYTES バイト以内に収める。
2. テキストが上限を超えるときは、ノートの境界（なければ空行・改行）で分割し、各パートの先頭と末尾に
   「何番目/全何個か」「続きがあるか」を書く。上限以内なら本文をそのまま返す。
   予算の 1/4 未満しか使えない切り位置は、ほぼ空のパートになるため採らない。
3. HTML の文字数は、埋め込み画像（data URL の base64 部分）を除いて数える（html_text_chars）。
   画像は容量（バイト）で別に制限する。
4. 保存後はディスクから読み直して上限を確かめる（verify_saved_files）。NG なら呼び出し側が条件を厳しくして
   最大 MAX_ATTEMPTS 回までやり直す。
5. 図面PDFの分割は app.vector.figure_pdf、HTML の分割・画像圧縮は app.vector.html_size_fitting が行う。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from PIL import Image

MAX_TEXT_CHARS = 200_000
MAX_IMAGE_BYTES = 4_500_000
# 連結した無圧縮の画像（または HTML 全体）がこのサイズ以下なら、圧縮して 1 つに収める。超えたら分割する。
IMAGE_SPLIT_THRESHOLD_BYTES = 6_000_000
MAX_ATTEMPTS = 3
# 分割ファイルの先頭・末尾の注記に使う文字数の見込み（本文の予算から差し引く）
PART_MARKER_RESERVE = 800
# やり直しのたびに文字数上限を下げる量
RETRY_TEXT_STEP = 10_000
# やり直しのたびに容量上限へ掛ける係数
RETRY_IMAGE_FACTOR = 0.9

_MIN_FILL_RATIO = 0.25
# Markdown+画像の書き出しで、ノート・メール付録の区切りとみなす行
_FILE_BOUNDARY = re.compile(r"(?m)^# ===== \[ファイル|^# ✉️ 付録|^### ✉️ \[メール")
# 埋め込み画像の base64 部分（data:...;base64, の後ろ）
_DATA_URL_PAYLOAD = re.compile(r"(data:[\w.+/-]+;base64,)[A-Za-z0-9+/=]+")


def text_limit_for_attempt(attempt: int, limit: int = MAX_TEXT_CHARS) -> int:
    """やり直し回数（0 始まり）に応じた文字数上限。回を重ねるほど余裕を持たせる。"""
    return limit - RETRY_TEXT_STEP * attempt


def image_limit_for_attempt(attempt: int, limit: int = MAX_IMAGE_BYTES) -> int:
    """やり直し回数（0 始まり）に応じた容量上限。"""
    return int(limit * (RETRY_IMAGE_FACTOR ** attempt))


def html_text_chars(html: str) -> int:
    """HTML の文字数。埋め込み画像の base64 部分は数えない。"""
    removed = sum(len(match.group(0)) - len(match.group(1)) for match in _DATA_URL_PAYLOAD.finditer(html))
    return len(html) - removed


def find_cut(text: str, start: int, budget: int, boundary: "re.Pattern[str]" = _FILE_BOUNDARY) -> int:
    """
    text[start:] の先頭から budget 文字以内で、分割に最適な終端位置を返す。
    境界 → 空行 → 改行 の順に優先するが、予算の 1/4 未満しか使えない候補は採らない
    （どれも満たさなければ最も後ろの改行、なければ予算いっぱいで切る）。
    """
    end = start + budget
    if end >= len(text):
        return len(text)
    last_boundary = None
    for match in boundary.finditer(text, start + 1, end):
        last_boundary = match.start()
    blank = text.rfind("\n\n", start + 1, end)
    newline = text.rfind("\n", start + 1, end)
    candidates = [
        last_boundary,
        blank + 2 if blank != -1 else None,
        newline + 1 if newline != -1 else None,
    ]
    for cut in candidates:
        if cut is not None and cut - start >= budget * _MIN_FILL_RATIO:
            return cut
    return newline + 1 if newline != -1 else end


def split_text_chunks(text: str, budget: int, boundary: "re.Pattern[str]" = _FILE_BOUNDARY) -> List[str]:
    """text を budget 文字以内の塊に、境界・空行・改行で切り分ける（注記は付けない）。"""
    if budget < 1:
        raise ValueError(f"分割の予算が小さすぎます: {budget}")
    chunks: List[str] = []
    start = 0
    while start < len(text):
        cut = find_cut(text, start, budget, boundary)
        chunks.append(text[start:cut])
        start = cut
    return chunks


def part_header(index: int, total: int) -> str:
    """分割ファイルの先頭に書く注記。"""
    lines = [
        f"【分割ファイル {index}/{total}】このファイルは全{total}個に分割された内容の{index}番目です。"
        f"全{total}個を順番にすべて読み込んでから回答してください。"
    ]
    if index > 1:
        lines.append("指示文などの前提は1番目のファイルに記載されています。")
    return "\n".join(lines)


def part_footer(index: int, total: int) -> str:
    """分割ファイルの末尾に書く注記。"""
    if index < total:
        return (
            f"【続きあり】このファイルは途中までです。続きは {index + 1}/{total} 番目のファイルにあります。"
            "（ファイルの途中で切れている場合は、次のファイルの先頭からそのまま続きます）"
        )
    return f"【分割ファイルはここまでです】{index}/{total} 番目が最後のファイルです。"


def split_text_parts(text: str, limit: int = MAX_TEXT_CHARS) -> List[str]:
    """text を limit 文字以内（注記込み）のパートへ分割する。収まる場合は [text] をそのまま返す。"""
    if len(text) <= limit:
        return [text]
    budget = limit - PART_MARKER_RESERVE
    if budget < 1000:
        raise ValueError(f"分割の上限が小さすぎます: {limit}")
    bodies = split_text_chunks(text, budget)
    total = len(bodies)
    return [
        f"{part_header(index, total)}\n\n{body.strip(chr(10))}\n\n{part_footer(index, total)}\n"
        for index, body in enumerate(bodies, start=1)
    ]


def part_file_name(base: str, kind: str, index: int, total: int, extension: str) -> str:
    """出力ファイル名。分割なしは `{base}_{kind}{ext}`、分割ありは `{base}_{kind}_part{n}of{m}{ext}`。"""
    if total <= 1:
        return f"{base}_{kind}{extension}"
    return f"{base}_{kind}_part{index}of{total}{extension}"


def image_extension(data: bytes) -> str:
    """画像バイト列の拡張子（PNG でなければ JPEG）。"""
    return ".png" if data.startswith(b"\x89PNG\r\n\x1a\n") else ".jpg"


def write_text_files(folder: Path, base: str, kind: str, extension: str, parts: List[str]) -> List[Path]:
    """テキストパートを UTF-8・LF で書き出す（文字数を OS 間で一致させるため改行は変換しない）。"""
    paths = []
    for index, part in enumerate(parts, start=1):
        path = folder / part_file_name(base, kind, index, len(parts), extension)
        with path.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(part)
        paths.append(path)
    return paths


def write_binary_files(folder: Path, base: str, kind: str, extension: str, parts: List[bytes]) -> List[Path]:
    """バイナリのパート（図面 PDF など）を書き出す。"""
    paths = []
    for index, data in enumerate(parts, start=1):
        path = folder / part_file_name(base, kind, index, len(parts), extension)
        path.write_bytes(data)
        paths.append(path)
    return paths


def write_image_files(folder: Path, base: str, kind: str, parts: List[bytes]) -> List[Path]:
    """画像パートを書き出す。"""
    paths = []
    for index, data in enumerate(parts, start=1):
        path = folder / part_file_name(base, kind, index, len(parts), image_extension(data))
        path.write_bytes(data)
        paths.append(path)
    return paths


def verify_saved_files(
    text_paths: List[Path],
    image_paths: List[Path],
    max_chars: int = MAX_TEXT_CHARS,
    max_bytes: int = MAX_IMAGE_BYTES,
    pdf_paths: Optional[List[Path]] = None,
    pdf_max_bytes: int = MAX_IMAGE_BYTES,
) -> List[str]:
    """
    書き出した実ファイルを読み直して上限を確かめ、問題点の一覧を返す（空なら合格）。
    テキストは文字数（HTML は埋め込み画像を除く）と容量、画像は容量と画像として読めるか、
    PDF は容量（pdf_max_bytes）と PDF として読めて 1 ページ以上あるかを確かめる。
    """
    problems: List[str] = []
    for path in text_paths:
        try:
            raw = path.read_bytes()
            text = raw.decode("utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            problems.append(f"{path.name} を読み直せません: {exc}")
            continue
        chars = html_text_chars(text) if path.suffix.lower() == ".html" else len(text)
        if chars > max_chars:
            problems.append(f"{path.name} が {chars:,} 文字で上限 {max_chars:,} 文字を超えています")
        if len(raw) > max_bytes:
            problems.append(f"{path.name} が {len(raw):,} バイトで上限 {max_bytes:,} バイトを超えています")
    for path in image_paths:
        try:
            size = path.stat().st_size
            with Image.open(path) as image:
                image.verify()
        except (OSError, SyntaxError) as exc:
            problems.append(f"{path.name} を画像として読み直せません: {exc}")
            continue
        if size > max_bytes:
            problems.append(f"{path.name} が {size:,} バイトで上限 {max_bytes:,} バイトを超えています")
    for path in pdf_paths or []:
        try:
            from pypdf import PdfReader
            from pypdf.errors import PdfReadError

            size = path.stat().st_size
            pages = len(PdfReader(path).pages)
        except (OSError, PdfReadError, ValueError) as exc:
            problems.append(f"{path.name} を PDF として読み直せません: {exc}")
            continue
        if pages == 0:
            problems.append(f"{path.name} にページがありません")
        if size > pdf_max_bytes:
            problems.append(f"{path.name} が {size:,} バイトで上限 {pdf_max_bytes:,} バイトを超えています")
    return problems


def text_parts_summary(parts: List[str]) -> List[Dict[str, Any]]:
    """API 応答用: 各パートの番号・全体数・文字数。"""
    return [{"index": index, "total": len(parts), "chars": len(part)} for index, part in enumerate(parts, start=1)]


def attachment_warning(file_count: int) -> str:
    """チャットの添付上限（5 ファイル）を超えるときの注意文。超えなければ空文字。"""
    if file_count <= 5:
        return ""
    return f"出力が{file_count}ファイルになりました。チャットの添付上限(5ファイル)を超えるため、複数回に分けて添付してください。"
