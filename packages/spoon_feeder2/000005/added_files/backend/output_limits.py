"""出力ファイルの上限（テキスト20万文字・画像4.5MB）に収める分割・保存・検証 (output_limits.py)

仕様:
1. テキストは MAX_TEXT_CHARS 文字以内、画像は MAX_IMAGE_BYTES バイト以内に収める（社内AIの添付制限）。
2. テキストが上限を超える場合は、ファイル境界（なければ空行・改行）で分割し、各パートの先頭と末尾に
   「何番目/全何個か」「続きがあるか」を記載する。分割しない場合は本文をそのまま返す。
3. 保存後はディスクから読み直して上限を検証する。NGなら呼び出し側が条件を厳しくしてやり直す。
4. 画像は結合画像側（mkdocs_support.build_image_parts）で分割・圧縮する。ここでは検証と命名だけ扱う。
"""

from __future__ import annotations

import re
from pathlib import Path

from PIL import Image

MAX_TEXT_CHARS = 200_000
MAX_IMAGE_BYTES = 4_500_000
# 連結した無圧縮PNGがこのサイズ以下なら圧縮して1枚、超えたら分割する。
IMAGE_SPLIT_THRESHOLD_BYTES = 6_000_000
MAX_ATTEMPTS = 3
# 分割ファイルの先頭・末尾の注記に使う文字数の見込み（本文の予算から差し引く）。
PART_MARKER_RESERVE = 800
# やり直しのたびに文字数上限を下げる量。
RETRY_TEXT_STEP = 10_000
# やり直しのたびに画像サイズ上限へ掛ける係数。
RETRY_IMAGE_FACTOR = 0.9

_MIN_FILL_RATIO = 0.25
_FILE_BOUNDARY = re.compile(
    r"(?m)^(?:# ===== \[ファイル[^\n]*\n)?<file path=|^<reference_repository\b|^<response_reminder>|^# 🖼️ 添付結合画像"
)


def text_limit_for_attempt(attempt: int) -> int:
    """やり直し回数(0始まり)に応じた文字数上限。回を重ねるほど余裕を持たせる。"""
    return MAX_TEXT_CHARS - RETRY_TEXT_STEP * attempt


def image_limit_for_attempt(attempt: int) -> int:
    """やり直し回数(0始まり)に応じた画像サイズ上限。"""
    return int(MAX_IMAGE_BYTES * (RETRY_IMAGE_FACTOR ** attempt))


def _find_cut(text: str, start: int, budget: int) -> int:
    """
    text[start:] の先頭から budget 文字以内で、分割に最適な終端位置を返す。
    ファイル境界 → 空行 → 改行の順に優先するが、予算の _MIN_FILL_RATIO 未満しか使えない候補は
    ほぼ空のパートを作ってしまうため採用しない（どれも満たさなければ最も後ろの改行、なければ予算いっぱいで切る）。
    """
    end = start + budget
    if end >= len(text):
        return len(text)
    boundary = None
    for match in _FILE_BOUNDARY.finditer(text, start + 1, end):
        boundary = match.start()
    blank = text.rfind("\n\n", start + 1, end)
    newline = text.rfind("\n", start + 1, end)
    candidates = [
        boundary,
        blank + 2 if blank != -1 else None,
        newline + 1 if newline != -1 else None,
    ]
    for cut in candidates:
        if cut is not None and cut - start >= budget * _MIN_FILL_RATIO:
            return cut
    return newline + 1 if newline != -1 else end


def _part_header(index: int, total: int) -> str:
    lines = [f"【分割ファイル {index}/{total}】このファイルは全{total}個に分割された内容の{index}番目です。全{total}個を順番にすべて読み込んでから回答してください。"]
    if index > 1:
        lines.append("指示文・リポジトリ構造などの前提は1番目のファイルに記載されています。")
    return "\n".join(lines)


def _part_footer(index: int, total: int) -> str:
    if index < total:
        return (
            f"【続きあり】このファイルは途中までです。続きは {index + 1}/{total} 番目のファイルにあります。"
            "（ファイルの途中で切れている場合は、次のファイルの先頭からそのまま続きます）"
        )
    return f"【分割ファイルはここまでです】{index}/{total} 番目が最後のファイルです。"


def split_text_parts(text: str, limit: int = MAX_TEXT_CHARS) -> list[str]:
    """text を limit 文字以内（注記込み）のパートへ分割する。収まる場合は [text] をそのまま返す。"""
    if len(text) <= limit:
        return [text]
    budget = limit - PART_MARKER_RESERVE
    if budget < 1000:
        raise ValueError(f"分割の上限が小さすぎます: {limit}")
    bodies: list[str] = []
    start = 0
    while start < len(text):
        cut = _find_cut(text, start, budget)
        bodies.append(text[start:cut])
        start = cut
    total = len(bodies)
    return [
        f"{_part_header(index, total)}\n\n{body.strip(chr(10))}\n\n{_part_footer(index, total)}\n"
        for index, body in enumerate(bodies, start=1)
    ]


def part_file_name(base: str, kind: str, index: int, total: int, extension: str) -> str:
    """出力ファイル名。分割なしは `{base}_{kind}{ext}`、分割ありは `{base}_{kind}_part{n}of{m}{ext}`。"""
    if total <= 1:
        return f"{base}_{kind}{extension}"
    return f"{base}_{kind}_part{index}of{total}{extension}"


def remove_stale_outputs(folder: Path, base: str, kind: str, extension: str, keep: set[str]) -> None:
    """同じ名前規則で過去に書き出した出力のうち、今回のセットに含まれないものを削除する（古いパートの混入防止）。"""
    pattern = re.compile(rf"^{re.escape(base)}_{re.escape(kind)}(?:_part\d+of\d+)?{re.escape(extension)}$")
    for path in folder.iterdir():
        if path.is_file() and path.name not in keep and pattern.match(path.name):
            path.unlink()


def write_text_files(folder: Path, base: str, kind: str, extension: str, parts: list[str]) -> list[Path]:
    """テキストパートを UTF-8・LF で書き出す（文字数をOS間で一致させるため改行は変換しない）。"""
    paths = []
    for index, part in enumerate(parts, start=1):
        path = folder / part_file_name(base, kind, index, len(parts), extension)
        with path.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(part)
        paths.append(path)
    remove_stale_outputs(folder, base, kind, extension, {path.name for path in paths})
    return paths


def image_extension(data: bytes) -> str:
    return ".png" if data.startswith(b"\x89PNG\r\n\x1a\n") else ".jpg"


def write_image_files(folder: Path, base: str, kind: str, parts: list[bytes]) -> list[Path]:
    paths = []
    for index, data in enumerate(parts, start=1):
        path = folder / part_file_name(base, kind, index, len(parts), image_extension(data))
        path.write_bytes(data)
        paths.append(path)
    keep = {path.name for path in paths}
    for extension in (".png", ".jpg"):
        remove_stale_outputs(folder, base, kind, extension, keep)
    return paths


def check_text_parts(parts: list[str], limit: int = MAX_TEXT_CHARS) -> list[str]:
    return [f"テキスト {index}/{len(parts)} が {len(part):,} 文字で上限 {limit:,} 文字を超えています" for index, part in enumerate(parts, start=1) if len(part) > limit]


def check_image_parts(parts: list[bytes], max_bytes: int = MAX_IMAGE_BYTES) -> list[str]:
    return [f"画像 {index}/{len(parts)} が {len(data):,} バイトで上限 {max_bytes:,} バイトを超えています" for index, data in enumerate(parts, start=1) if len(data) > max_bytes]


def verify_saved_files(text_paths: list[Path], image_paths: list[Path]) -> list[str]:
    """書き出した実ファイルを読み直して上限を検証し、問題点の一覧を返す（空なら合格）。"""
    problems: list[str] = []
    for path in text_paths:
        try:
            chars = len(path.read_bytes().decode("utf-8"))
        except (OSError, UnicodeDecodeError) as exc:
            problems.append(f"{path.name} を読み直せません: {exc}")
            continue
        if chars > MAX_TEXT_CHARS:
            problems.append(f"{path.name} が {chars:,} 文字で上限 {MAX_TEXT_CHARS:,} 文字を超えています")
    for path in image_paths:
        try:
            size = path.stat().st_size
            with Image.open(path) as image:
                image.verify()
        except (OSError, SyntaxError) as exc:
            problems.append(f"{path.name} を画像として読み直せません: {exc}")
            continue
        if size > MAX_IMAGE_BYTES:
            problems.append(f"{path.name} が {size:,} バイトで上限 {MAX_IMAGE_BYTES:,} バイトを超えています")
    return problems


def text_parts_payload(parts: list[str]) -> list[dict]:
    """API応答用: 各パートの番号・全体数・文字数・本文。"""
    return [{"index": index, "total": len(parts), "chars": len(part), "text": part} for index, part in enumerate(parts, start=1)]


def attachment_warning(file_count: int) -> str:
    """チャットの添付上限(5ファイル)を超えるときの注意文。超えなければ空文字。"""
    if file_count <= 5:
        return ""
    return f"出力が{file_count}ファイルになりました。チャットの添付上限(5ファイル)を超えるため、複数回に分けて添付してください。"
