"""
テキスト差分（Git差分画面・HTMLレポート用）の行データ生成。
- 文字コード判定: BOM付きUTF-8 / UTF-8 / CP932。NUL・制御文字の多い内容はバイナリとして拒否する
- 行の対応付け: 先頭・末尾の共通行を除いてから SequenceMatcher に渡す（大きなファイルでも高速）
- 空行や `:` `---` などの単純な行は junk 扱いにし、見出しや関数定義行をアンカーとして保つ
- 行内ハイライト: 英数字・漢字・ひらがな・カタカナの塊と記号を単位に比較する
- Obsidian Excalidraw の埋め込みデータ行は比較・表示から除外する（行インデックスは元ファイルのまま）
"""

from __future__ import annotations

import difflib
import re

from fastapi import HTTPException

MAX_TEXT_BYTES = 5 * 1024 * 1024
MAX_TEXT_DIFF_LINES = 30_000
MAX_INLINE_DIFF_CHARS = 20_000
# SequenceMatcher は同じトークンが繰り返される長い行で計算量がほぼ3乗に増える（2,800トークンで約28秒）。
# 両側のトークン数の積がこれを超える行は、共通の先頭・末尾を除いた中間を変更として強調する（線形時間）。
MAX_INLINE_DIFF_TOKEN_PRODUCT = 250_000
EXCALIDRAW_PLUGIN_MARKER_RE = re.compile(r"(?im)^\s*excalidraw-plugin\s*:\s*parsed\s*$")
EXCALIDRAW_DATA_HEADING_RE = re.compile(r"(?i)^\s{0,3}#{1,6}\s+excalidraw\s+data\s*$")
EXCALIDRAW_FENCE_RE = re.compile(r"(?i)^\s*```(?:compressed-json|json)\s*$")
TOKEN_SPLIT_RE = re.compile(
    r"[a-zA-Z0-9_]+"               # 英数字・アンダースコア（Python識別子、英単語）
    r"|[\u4e00-\u9faf]+"          # 漢字の連続
    r"|[\u3040-\u309f]+"          # ひらがなの連続
    r"|[\u30a0-\u30ff]+"          # カタカナの連続
    r"|[ \t]+"                     # 空白・インデント
    r"|[^\w\s]"                    # 記号（括弧、句読点、演算子等）
    r"|."                          # その他フォールバック
)


def decode_git_text(content: bytes) -> tuple[str, str]:
    if len(content) > MAX_TEXT_BYTES:
        raise HTTPException(status_code=413, detail=f"Text file exceeds {MAX_TEXT_BYTES // (1024 * 1024)} MB")
    if b"\x00" in content:
        raise HTTPException(status_code=422, detail="Binary content cannot be shown as text")
    control_bytes = sum(byte < 32 and byte not in {9, 10, 12, 13} for byte in content)
    if content and control_bytes / len(content) > 0.01:
        raise HTTPException(status_code=422, detail="Binary content cannot be shown as text")
    if content.startswith(b"\xef\xbb\xbf"):
        return content.decode("utf-8-sig"), "utf-8-sig"
    for encoding in ("utf-8", "cp932"):
        try:
            return content.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace"), "utf-8 (replacement characters)"


def _is_trivial_line(line: str) -> bool:
    stripped = line.strip()
    return not stripped or stripped in {":", "{", "}", "pass", "---"}


def line_opcodes(old_lines: list[str], new_lines: list[str]) -> list[tuple[str, int, int, int, int]]:
    """行単位のopcodesを返す。先頭・末尾の共通行はSequenceMatcherに渡さない。

    difflib.SequenceMatcher は純Pythonで、行数が多いほど急激に遅くなる。実際の編集は
    ファイルの一部だけなので、共通の先頭・末尾を先に除くだけで古いPCでも大幅に速くなる。
    """
    limit = min(len(old_lines), len(new_lines))
    prefix = 0
    while prefix < limit and old_lines[prefix] == new_lines[prefix]:
        prefix += 1
    suffix = 0
    while suffix < limit - prefix and old_lines[-1 - suffix] == new_lines[-1 - suffix]:
        suffix += 1

    old_end = len(old_lines) - suffix
    new_end = len(new_lines) - suffix
    opcodes: list[tuple[str, int, int, int, int]] = []
    if prefix:
        opcodes.append(("equal", 0, prefix, 0, prefix))
    middle_old = old_lines[prefix:old_end]
    middle_new = new_lines[prefix:new_end]
    if middle_old or middle_new:
        matcher = difflib.SequenceMatcher(
            _is_trivial_line,
            middle_old,
            middle_new,
            autojunk=max(len(middle_old), len(middle_new)) > 2_000,
        )
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            opcodes.append((tag, i1 + prefix, i2 + prefix, j1 + prefix, j2 + prefix))
    if suffix:
        opcodes.append(("equal", old_end, len(old_lines), new_end, len(new_lines)))
    return opcodes


def build_text_diff_rows(
    old_text: str,
    new_text: str,
    *,
    old_hidden: set[int] | None = None,
    new_hidden: set[int] | None = None,
) -> list[dict]:
    """左右対応のテキスト差分行を作る。

    old_hidden / new_hidden に指定した行（Excalidrawの埋め込みデータ等）は比較・表示から除外するが、
    各行の old_index / new_index は元ファイルの行番号のまま返す。これにより、表示を間引いても
    行編集・1行復元は実ファイルの正しい行を操作できる。

    行番号の表示仕様: 共通行・置換行は左右同じ通し番号、追加行は新側に "A"、削除行は旧側に "D" を
    表示し、追加・削除行は通し番号を消費しない（後続の共通行番号が左右でずれない）。
    """
    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()
    if len(old_lines) > MAX_TEXT_DIFF_LINES or len(new_lines) > MAX_TEXT_DIFF_LINES:
        raise HTTPException(status_code=413, detail=f"Text diff exceeds {MAX_TEXT_DIFF_LINES:,} lines per side")

    old_hidden = old_hidden or set()
    new_hidden = new_hidden or set()
    # 表示対象の行と、その元ファイルでの行インデックス
    old_visible = [index for index in range(len(old_lines)) if index not in old_hidden]
    new_visible = [index for index in range(len(new_lines)) if index not in new_hidden]
    old_clean = [old_lines[index] for index in old_visible]
    new_clean = [new_lines[index] for index in new_visible]

    def original_index(visible: list[int], position: int, total: int) -> int:
        # 片側に行がない（挿入・削除）場合は、その位置の直後の元インデックス＝挿入位置を返す。
        return visible[position] if position < len(visible) else total

    rows: list[dict] = []
    common_line_num = 1
    for tag, old_start, old_end, new_start, new_end in line_opcodes(old_clean, new_clean):
        old_group = old_clean[old_start:old_end]
        new_group = new_clean[new_start:new_end]
        for offset in range(max(len(old_group), len(new_group))):
            has_old = offset < len(old_group)
            has_new = offset < len(new_group)
            old_line = old_group[offset] if has_old else None
            new_line = new_group[offset] if has_new else None
            row_tag = tag
            if tag == "replace" and not has_old:
                row_tag = "insert"
            elif tag == "replace" and not has_new:
                row_tag = "delete"

            if row_tag == "insert":
                old_number, new_number = None, "A"
            elif row_tag == "delete":
                old_number, new_number = "D", None
            else:
                old_number = new_number = common_line_num
                common_line_num += 1

            # 左右のハイライトは同じ比較結果から作れるため、行ごとに1回だけ計算する。
            old_segments, new_segments = (
                inline_diff_pair(old_line or "", new_line or "") if row_tag == "replace" else (None, None)
            )
            rows.append(
                {
                    "kind": row_tag,
                    "old_number": old_number,
                    "new_number": new_number,
                    "old_index": original_index(old_visible, old_start + (offset if has_old else 0), len(old_lines)),
                    # 削除行はすべて同じ挿入位置に属する。旧側のオフセットで進めると、
                    # 複数行を戻したときに無関係な後続行の後ろへ復元されてしまう。
                    "new_index": original_index(new_visible, new_start + (offset if has_new else 0), len(new_lines)),
                    "old": old_line,
                    "new": new_line,
                    "old_segments": old_segments,
                    "new_segments": new_segments,
                }
            )

    old_terminal_newline = old_text.endswith(("\n", "\r"))
    new_terminal_newline = new_text.endswith(("\n", "\r"))
    if old_terminal_newline != new_terminal_newline:
        old_marker = "ファイル末尾: 改行あり" if old_terminal_newline else "ファイル末尾: 改行なし"
        new_marker = "ファイル末尾: 改行あり" if new_terminal_newline else "ファイル末尾: 改行なし"
        rows.append(
            {
                "kind": "replace",
                "old_number": None,
                "new_number": None,
                "old": old_marker,
                "new": new_marker,
                "old_segments": [{"text": old_marker, "changed": True}],
                "new_segments": [{"text": new_marker, "changed": True}],
            }
        )
    return rows


def build_markdown_text_diff_rows(old_text: str, new_text: str) -> list[dict]:
    """埋め込みExcalidrawのデータ行を比較・表示から除外してテキスト差分行を作る。

    巨大な描画JSONを SequenceMatcher に渡さないことで高速化する。行インデックスは元ファイルのまま。
    """
    return build_text_diff_rows(
        old_text,
        new_text,
        old_hidden=embedded_excalidraw_line_indexes(old_text),
        new_hidden=embedded_excalidraw_line_indexes(new_text),
    )


def embedded_excalidraw_line_indexes(text: str) -> set[int]:
    lines = text.splitlines()
    if not lines:
        return set()
    if not EXCALIDRAW_PLUGIN_MARKER_RE.search(text):
        return set()

    for index, line in enumerate(lines):
        if EXCALIDRAW_DATA_HEADING_RE.match(line):
            # Keep the heading visible; only the embedded drawing source
            # below it is omitted from the text diff.
            return set(range(index + 1, len(lines)))

    # Support notes that use the plugin marker and a drawing fence without the
    # standard ``# Excalidraw Data`` heading. Do not hide arbitrary JSON blocks
    # in ordinary Markdown: only treat a fence as drawing data when the note
    # contains the plugin's parsed marker.
    hidden: set[int] = set()
    index = 0
    while index < len(lines):
        if not EXCALIDRAW_FENCE_RE.match(lines[index]):
            index += 1
            continue
        end = index + 1
        while end < len(lines) and not lines[end].strip().startswith("```"):
            end += 1
        if end < len(lines):
            hidden.update(range(index, end + 1))
            index = end + 1
        else:
            hidden.update(range(index, len(lines)))
            break
    return hidden


def _tokenize_line(text: str) -> list[str]:
    return TOKEN_SPLIT_RE.findall(text)


def inline_diff_pair(old_line: str, new_line: str) -> tuple[list[dict], list[dict]]:
    """旧・新の行内差分セグメントを1回の比較でまとめて返す。

    長大な行（MAX_INLINE_DIFF_CHARS 超）は行全体を変更とし、トークン数の多い行は先頭・末尾の
    共通部分だけを除いて強調する（どちらも計算時間が行の長さに比例する範囲に収める）。
    """
    if len(old_line) + len(new_line) > MAX_INLINE_DIFF_CHARS:
        return (
            [{"text": old_line, "changed": True}] if old_line else [],
            [{"text": new_line, "changed": True}] if new_line else [],
        )
    old_tokens = _tokenize_line(old_line)
    new_tokens = _tokenize_line(new_line)
    if len(old_tokens) * len(new_tokens) > MAX_INLINE_DIFF_TOKEN_PRODUCT:
        return _prefix_suffix_segments(old_tokens, new_tokens)
    matcher = difflib.SequenceMatcher(None, old_tokens, new_tokens, autojunk=False)
    old_segments: list[dict] = []
    new_segments: list[dict] = []

    def append(segments: list[dict], tokens: list[str], changed: bool) -> None:
        text = "".join(tokens)
        if not text:
            return
        if segments and segments[-1]["changed"] == changed:
            segments[-1]["text"] += text
        else:
            segments.append({"text": text, "changed": changed})

    for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
        changed = tag != "equal"
        append(old_segments, old_tokens[old_start:old_end], changed)
        append(new_segments, new_tokens[new_start:new_end], changed)
    return old_segments, new_segments


def _prefix_suffix_segments(old_tokens: list[str], new_tokens: list[str]) -> tuple[list[dict], list[dict]]:
    """共通の先頭・末尾トークンを除いた中間部分を変更として返す（長い行向けの線形時間の近似）。"""
    limit = min(len(old_tokens), len(new_tokens))
    prefix = 0
    while prefix < limit and old_tokens[prefix] == new_tokens[prefix]:
        prefix += 1
    suffix = 0
    while suffix < limit - prefix and old_tokens[-1 - suffix] == new_tokens[-1 - suffix]:
        suffix += 1

    def segments(tokens: list[str]) -> list[dict]:
        parts = [
            ("".join(tokens[:prefix]), False),
            ("".join(tokens[prefix : len(tokens) - suffix]), True),
            ("".join(tokens[len(tokens) - suffix :]), False),
        ]
        return [{"text": text, "changed": changed} for text, changed in parts if text]

    return segments(old_tokens), segments(new_tokens)
