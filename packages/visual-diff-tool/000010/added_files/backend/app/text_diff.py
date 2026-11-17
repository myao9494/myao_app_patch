"""
テキスト差分（Git差分画面・HTMLレポート用）の行データ生成。
- 文字コード判定: BOM付きUTF-8 / UTF-8 / CP932。NUL・制御文字の多い内容はバイナリとして拒否する
- 行の対応付け: 先頭・末尾の共通行を除いてから SequenceMatcher に渡す（大きなファイルでも高速）
- 長いファイルで変更箇所が多く SequenceMatcher が遅くなる差分だけ、両側に1回ずつ現れる行を目印に分割して比較する
- 空行や `:` `---` などの単純な行は junk 扱いにし、見出しや関数定義行をアンカーとして保つ
- 行内ハイライト: 英数字・漢字・ひらがな・カタカナの塊と記号を単位に比較する
- Obsidian Excalidraw の埋め込みデータ行は比較・表示から除外する（行インデックスは元ファイルのまま）
- Markdown で「書式の違いを無視」するとき（ignore_format）は、プラグインやリンターが変えがちな書式だけの違いを
  変更として扱わず kind "format" の行（画面では薄い色）にする。無視するのは、行頭・行中の空白（全角・タブ・表の
  位置合わせを含む）、空行の追加・削除、箇条書き記号の種類（- * +）、番号付きリストの番号と `.` / `)`、
  強調の記号（_ と *）、区切り線の書き方（--- *** ___）、ファイル末尾の改行の有無。
  行末の空白（2つで改行の意味がある）、見出しのレベル、記号の有無、チェックボックスの状態は無視しない。
  フロントマターとコードブロックの中は書式に意味があるので、そのまま比べる。
"""

from __future__ import annotations

import bisect
import difflib
import re

from fastapi import HTTPException

MAX_TEXT_BYTES = 5 * 1024 * 1024
MAX_TEXT_DIFF_LINES = 30_000
MAX_INLINE_DIFF_CHARS = 20_000
# SequenceMatcher は変更箇所ごとに残りの範囲を調べ直すため、3万行で1割が変わると5秒以上かかる。
# 目印で分割すると一致行がわずかに減ることがあるので、「行数 × 変更箇所数」が
# この値を超えて遅くなる差分だけ分割する（通常の差分は対応付けの結果を変えない）。
ANCHOR_SPLIT_MIN_COST = 2_000_000
# SequenceMatcher は同じトークンが繰り返される長い行で計算量がほぼ3乗に増える（2,800トークンで約28秒）。
# 両側のトークン数の積がこれを超える行は、共通の先頭・末尾を除いた中間を変更として強調する（線形時間）。
MAX_INLINE_DIFF_TOKEN_PRODUCT = 250_000
EXCALIDRAW_PLUGIN_MARKER_RE = re.compile(r"(?im)^\s*excalidraw-plugin\s*:\s*parsed\s*$")
EXCALIDRAW_DATA_HEADING_RE = re.compile(r"(?i)^\s{0,3}#{1,6}\s+excalidraw\s+data\s*$")
EXCALIDRAW_FENCE_RE = re.compile(r"(?i)^\s*```(?:compressed-json|json)\s*$")
MARKDOWN_SUFFIXES = (".md", ".markdown")
# 行頭の記号。引用（>）の後の、見出し（#）・箇条書き（- * +）・番号付きリスト（1. / 1)）。後ろに空白が要る
# （`#tag` や `-1` は記号ではない。空白を消して比べるので、ここで記号を別の文字に置き換えて区別する）。
MARKDOWN_PREFIX_RE = re.compile(r"^((?:[ \t\u3000]*>)*)[ \t\u3000]*(?:(#{1,6})|([-*+])|(\d{1,9})[.)])(?=[ \t\u3000]|$)")
MARKDOWN_HR_RE = re.compile(r"^[ \t\u3000]*([-*_])(?:[ \t\u3000]*\1){2,}[ \t\u3000]*$")
MARKDOWN_FENCE_RE = re.compile(r"^[ \t]*(`{3,}|~{3,})")
# `_強調_` / `__太字__` を `*` に揃える。単語の途中の `_`（snake_case）は強調にならないので対象外。
MARKDOWN_UNDERSCORE_EMPHASIS_RE = re.compile(r"(?<![\w\\])(__|_)(?![\s_])(.+?)(?<![\s_\\])\1(?!\w)")
MARKDOWN_SPACE_RE = re.compile(r"[ \t\u3000]+")
TOKEN_SPLIT_RE = re.compile(
    r"[a-zA-Z0-9_]+"               # 英数字・アンダースコア（Python識別子、英単語）
    r"|[\u4e00-\u9faf]+"          # 漢字の連続
    r"|[\u3040-\u309f]+"          # ひらがなの連続
    r"|[\u30a0-\u30ff]+"          # カタカナの連続
    r"|[ \t]+"                     # 空白・インデント
    r"|[^\w\s]"                    # 記号（括弧、句読点、演算子等）
    r"|."                          # その他フォールバック
)
# 書式の違いを無視するときの行内比較用。`_` を単独のトークンにして `*` と同じに扱う。
MARKDOWN_TOKEN_SPLIT_RE = re.compile(
    r"[a-zA-Z0-9]+"
    r"|_"
    r"|[\u4e00-\u9faf]+"
    r"|[\u3040-\u309f]+"
    r"|[\u30a0-\u30ff]+"
    r"|[ \t\u3000]+"
    r"|[^\w\s]"
    r"|."
)


def decode_git_text(content: bytes) -> tuple[str, str]:
    if len(content) > MAX_TEXT_BYTES:
        raise HTTPException(status_code=413, detail=f"テキストファイルが上限（{MAX_TEXT_BYTES // (1024 * 1024)} MB）を超えています")
    if b"\x00" in content:
        raise HTTPException(status_code=422, detail="バイナリファイルはテキストとして表示できません")
    control_bytes = sum(byte < 32 and byte not in {9, 10, 12, 13} for byte in content)
    if content and control_bytes / len(content) > 0.01:
        raise HTTPException(status_code=422, detail="バイナリファイルはテキストとして表示できません")
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


def _sequence_opcodes(
    old_lines: list[str],
    new_lines: list[str],
    old_offset: int,
    new_offset: int,
) -> list[tuple[str, int, int, int, int]]:
    if not old_lines and not new_lines:
        return []
    matcher = difflib.SequenceMatcher(
        _is_trivial_line,
        old_lines,
        new_lines,
        autojunk=max(len(old_lines), len(new_lines)) > 2_000,
    )
    return [
        (tag, i1 + old_offset, i2 + old_offset, j1 + new_offset, j2 + new_offset)
        for tag, i1, i2, j1, j2 in matcher.get_opcodes()
    ]


def _unique_line_anchors(old_lines: list[str], new_lines: list[str]) -> list[tuple[int, int]]:
    """両側に1回ずつだけ現れる行の対のうち、順序が崩れない最長の並びを返す（patience diff）。"""

    def unique_positions(lines: list[str]) -> dict[str, int]:
        positions: dict[str, int] = {}
        repeated: set[str] = set()
        for index, line in enumerate(lines):
            if line in positions:
                repeated.add(line)
            positions[line] = index
        return {line: index for line, index in positions.items() if line not in repeated}

    old_unique = unique_positions(old_lines)
    new_unique = unique_positions(new_lines)
    pairs = [
        (old_index, new_unique[line])
        for line, old_index in old_unique.items()
        if line in new_unique and not _is_trivial_line(line)
    ]
    pairs.sort()

    # new 側の位置の最長増加部分列。行の移動があっても対応が交差しない目印だけを残す。
    tail_new_positions: list[int] = []
    tail_pair_indexes: list[int] = []
    previous = [-1] * len(pairs)
    for pair_index, (_, new_index) in enumerate(pairs):
        length = bisect.bisect_left(tail_new_positions, new_index)
        if length:
            previous[pair_index] = tail_pair_indexes[length - 1]
        if length == len(tail_new_positions):
            tail_new_positions.append(new_index)
            tail_pair_indexes.append(pair_index)
        else:
            tail_new_positions[length] = new_index
            tail_pair_indexes[length] = pair_index

    anchors: list[tuple[int, int]] = []
    pair_index = tail_pair_indexes[-1] if tail_pair_indexes else -1
    while pair_index >= 0:
        anchors.append(pairs[pair_index])
        pair_index = previous[pair_index]
    anchors.reverse()
    return anchors


def _estimated_match_cost(old_lines: list[str], new_lines: list[str], anchors: list[tuple[int, int]]) -> int:
    """SequenceMatcher の処理量の目安（行数 × 目印の連続が途切れる箇所の数）。"""
    changed_regions = 1 + sum(
        1
        for (old_a, new_a), (old_b, new_b) in zip(anchors, anchors[1:])
        if old_b != old_a + 1 or new_b != new_a + 1
    )
    return max(len(old_lines), len(new_lines)) * changed_regions


def _anchored_opcodes(
    old_lines: list[str],
    new_lines: list[str],
    anchors: list[tuple[int, int]],
    offset: int,
) -> list[tuple[str, int, int, int, int]]:
    """目印の行で範囲を分け、目印の間だけを SequenceMatcher で比較する。"""
    opcodes: list[tuple[str, int, int, int, int]] = []

    def append(opcode: tuple[str, int, int, int, int]) -> None:
        last = opcodes[-1] if opcodes else None
        if last and last[0] == "equal" and opcode[0] == "equal" and last[2] == opcode[1] and last[4] == opcode[3]:
            opcodes[-1] = ("equal", last[1], opcode[2], last[3], opcode[4])
        else:
            opcodes.append(opcode)

    old_start = 0
    new_start = 0
    for old_anchor, new_anchor in [*anchors, (len(old_lines), len(new_lines))]:
        for opcode in _sequence_opcodes(
            old_lines[old_start:old_anchor],
            new_lines[new_start:new_anchor],
            old_start + offset,
            new_start + offset,
        ):
            append(opcode)
        if old_anchor < len(old_lines):
            append(("equal", old_anchor + offset, old_anchor + 1 + offset, new_anchor + offset, new_anchor + 1 + offset))
        old_start = old_anchor + 1
        new_start = new_anchor + 1
    return opcodes


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
    anchors = _unique_line_anchors(middle_old, middle_new)
    if _estimated_match_cost(middle_old, middle_new, anchors) > ANCHOR_SPLIT_MIN_COST:
        opcodes.extend(_anchored_opcodes(middle_old, middle_new, anchors, prefix))
    else:
        opcodes.extend(_sequence_opcodes(middle_old, middle_new, prefix, prefix))
    if suffix:
        opcodes.append(("equal", old_end, len(old_lines), new_end, len(new_lines)))
    return opcodes


def is_markdown_path(path: str) -> bool:
    return str(path).lower().endswith(MARKDOWN_SUFFIXES)


def _markdown_line_key(line: str) -> str | None:
    """書式の違いを除いた比較用の文字列。空白だけの行は None（空行の追加・削除は無視する）。

    行末の空白は Markdown で改行の意味（2つ以上）があるので、本文と区別できる形で残す。
    """
    body = line.rstrip()
    if not body:
        return None
    trail = line[len(body):]
    trail_key = f"\x01{trail}" if trail else ""
    if MARKDOWN_HR_RE.match(body):
        return "---" + trail_key
    match = MARKDOWN_PREFIX_RE.match(body)
    if match:
        quotes, heading, bullet, _number = match.groups()
        marker = f"\x02H{len(heading)}" if heading else "\x02L" if bullet else "\x02O"
        body = ">" * quotes.count(">") + marker + body[match.end():]
    for _ in range(2):  # 入れ子（__太字 _斜体_ 太字__）も揃える
        body = MARKDOWN_UNDERSCORE_EMPHASIS_RE.sub(lambda m: "*" * len(m.group(1)) + m.group(2) + "*" * len(m.group(1)), body)
    return MARKDOWN_SPACE_RE.sub("", body) + trail_key


def markdown_format_keys(lines: list[str]) -> list[str | None]:
    """各行の比較用の文字列。フロントマターとコードブロックの中は書式に意味があるので元の行のまま比べる。"""
    keys: list[str | None] = []
    fence: str | None = None
    in_front_matter = bool(lines) and lines[0].strip() == "---"
    for index, line in enumerate(lines):
        if in_front_matter:
            keys.append(line)
            if index > 0 and line.strip() in {"---", "..."}:
                in_front_matter = False
            continue
        if fence is not None:
            keys.append(line)
            stripped = line.strip()
            if stripped.startswith(fence) and set(stripped) == {fence[0]}:
                fence = None
            continue
        opening = MARKDOWN_FENCE_RE.match(line)
        if opening:
            fence = opening.group(1)
        keys.append(_markdown_line_key(line))
    return keys


# 行の並び: (種類, 旧側の位置, 旧側に行があるか, 新側の位置, 新側に行があるか)。
# 片側に行がないときの位置は、その側での挿入位置（行インデックスの計算に使う）。
_RowSpec = tuple[str, int, bool, int, bool]


def _exact_row_specs(old_lines: list[str], new_lines: list[str]) -> list[_RowSpec]:
    specs: list[_RowSpec] = []
    for tag, old_start, old_end, new_start, new_end in line_opcodes(old_lines, new_lines):
        for offset in range(max(old_end - old_start, new_end - new_start)):
            has_old = offset < old_end - old_start
            has_new = offset < new_end - new_start
            row_tag = "insert" if tag == "replace" and not has_old else "delete" if tag == "replace" and not has_new else tag
            # 削除行はすべて同じ挿入位置に属する。旧側のオフセットで進めると、
            # 複数行を戻したときに無関係な後続行の後ろへ復元されてしまう。
            specs.append((row_tag, old_start + (offset if has_old else 0), has_old, new_start + (offset if has_new else 0), has_new))
    return specs


def _format_row_specs(
    old_lines: list[str],
    new_lines: list[str],
    old_keys: list[str | None],
    new_keys: list[str | None],
) -> list[_RowSpec]:
    """書式の違いを除いて行を対応づける。空行は対応づけに使わず、前後の行の間へ戻す。

    比較用の文字列が同じで元の行が違う行、片側だけの空行は "format"（書式だけの違い）にする。
    """
    old_match = [index for index, key in enumerate(old_keys) if key is not None]
    new_match = [index for index, key in enumerate(new_keys) if key is not None]
    aligned: list[tuple[str, int | None, int | None]] = []
    for tag, old_start, old_end, new_start, new_end in line_opcodes(
        [old_keys[index] for index in old_match],
        [new_keys[index] for index in new_match],
    ):
        for offset in range(max(old_end - old_start, new_end - new_start)):
            old_pos = old_match[old_start + offset] if offset < old_end - old_start else None
            new_pos = new_match[new_start + offset] if offset < new_end - new_start else None
            row_tag = tag if tag == "equal" or (old_pos is not None and new_pos is not None) else "insert" if old_pos is None else "delete"
            aligned.append((row_tag, old_pos, new_pos))

    specs: list[_RowSpec] = []
    old_next = 0
    new_next = 0

    def add_blank_lines(old_until: int, new_until: int) -> None:
        nonlocal old_next, new_next
        old_blank = list(range(old_next, old_until))
        new_blank = list(range(new_next, new_until))
        for offset in range(max(len(old_blank), len(new_blank))):
            has_old = offset < len(old_blank)
            has_new = offset < len(new_blank)
            old_pos = old_blank[offset] if has_old else old_until
            new_pos = new_blank[offset] if has_new else new_until
            same = has_old and has_new and old_lines[old_pos] == new_lines[new_pos]
            specs.append(("equal" if same else "format", old_pos, has_old, new_pos, has_new))
        old_next = max(old_next, old_until)
        new_next = max(new_next, new_until)

    for row_tag, old_pos, new_pos in aligned:
        add_blank_lines(old_next if old_pos is None else old_pos, new_next if new_pos is None else new_pos)
        if row_tag == "equal" and old_lines[old_pos] != new_lines[new_pos]:
            row_tag = "format"
        specs.append((row_tag, old_next if old_pos is None else old_pos, old_pos is not None, new_next if new_pos is None else new_pos, new_pos is not None))
        if old_pos is not None:
            old_next = old_pos + 1
        if new_pos is not None:
            new_next = new_pos + 1
    add_blank_lines(len(old_lines), len(new_lines))
    return specs


def build_text_diff_rows(
    old_text: str,
    new_text: str,
    *,
    old_hidden: set[int] | None = None,
    new_hidden: set[int] | None = None,
    ignore_format: bool = False,
) -> list[dict]:
    """左右対応のテキスト差分行を作る。

    old_hidden / new_hidden に指定した行（Excalidrawの埋め込みデータ等）は比較・表示から除外するが、
    各行の old_index / new_index は元ファイルの行番号のまま返す。これにより、表示を間引いても
    行編集・1行復元は実ファイルの正しい行を操作できる。

    行番号の表示仕様: 共通行・置換行は左右同じ通し番号、追加行は新側に "A"、削除行は旧側に "D" を
    表示し、追加・削除行は通し番号を消費しない（後続の共通行番号が左右でずれない）。

    ignore_format=True（Markdown用）のときは書式だけの違いを kind "format" の行にする（モジュール先頭の説明）。
    書式の行の番号は、両側にあれば共通行と同じ通し番号、片側だけ（空行の追加・削除）なら "A" / "D"。
    """
    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()
    if len(old_lines) > MAX_TEXT_DIFF_LINES or len(new_lines) > MAX_TEXT_DIFF_LINES:
        raise HTTPException(status_code=413, detail=f"テキスト差分は片側 {MAX_TEXT_DIFF_LINES:,} 行までです")

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

    if ignore_format:
        # コードブロックの開始・終了を正しく追うため、隠す行も含めた元の行で比較用の文字列を作る
        old_keys = markdown_format_keys(old_lines)
        new_keys = markdown_format_keys(new_lines)
        specs = _format_row_specs(
            old_clean,
            new_clean,
            [old_keys[index] for index in old_visible],
            [new_keys[index] for index in new_visible],
        )
    else:
        specs = _exact_row_specs(old_clean, new_clean)

    rows: list[dict] = []
    common_line_num = 1
    for row_tag, old_pos, has_old, new_pos, has_new in specs:
        old_line = old_clean[old_pos] if has_old else None
        new_line = new_clean[new_pos] if has_new else None
        if not has_old:
            old_number, new_number = None, "A"
        elif not has_new:
            old_number, new_number = "D", None
        else:
            old_number = new_number = common_line_num
            common_line_num += 1

        # 左右のハイライトは同じ比較結果から作れるため、行ごとに1回だけ計算する。
        # 書式の行は、何が変わったかを薄く示すため、書式も含めた違いを強調する。
        if row_tag == "replace":
            old_segments, new_segments = inline_diff_pair(old_line or "", new_line or "", ignore_format=ignore_format)
        elif row_tag == "format" and has_old and has_new:
            old_segments, new_segments = inline_diff_pair(old_line or "", new_line or "")
        else:
            old_segments, new_segments = None, None
        rows.append(
            {
                "kind": row_tag,
                "old_number": old_number,
                "new_number": new_number,
                "old_index": original_index(old_visible, old_pos, len(old_lines)),
                "new_index": original_index(new_visible, new_pos, len(new_lines)),
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
                # 末尾の改行の有無はリンターがよく変える書式なので、書式を無視するときは書式の行にする
                "kind": "format" if ignore_format else "replace",
                "old_number": None,
                "new_number": None,
                "old": old_marker,
                "new": new_marker,
                "old_segments": [{"text": old_marker, "changed": True}],
                "new_segments": [{"text": new_marker, "changed": True}],
            }
        )
    return rows


def build_markdown_text_diff_rows(old_text: str, new_text: str, *, ignore_format: bool = False) -> list[dict]:
    """埋め込みExcalidrawのデータ行を比較・表示から除外してテキスト差分行を作る。

    巨大な描画JSONを SequenceMatcher に渡さないことで高速化する。行インデックスは元ファイルのまま。
    ignore_format は Markdown の書式だけの違いを無視する（呼び出し側が Markdown のときだけ True にする）。
    """
    return build_text_diff_rows(
        old_text,
        new_text,
        old_hidden=embedded_excalidraw_line_indexes(old_text),
        new_hidden=embedded_excalidraw_line_indexes(new_text),
        ignore_format=ignore_format,
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


def inline_diff_pair(old_line: str, new_line: str, *, ignore_format: bool = False) -> tuple[list[dict], list[dict]]:
    """旧・新の行内差分セグメントを1回の比較でまとめて返す。

    長大な行（MAX_INLINE_DIFF_CHARS 超）は行全体を変更とし、トークン数の多い行は先頭・末尾の
    共通部分だけを除いて強調する（どちらも計算時間が行の長さに比例する範囲に収める）。
    ignore_format=True では、行の比較と同じ規則で空白や記号だけの違いを強調しない。
    """
    if len(old_line) + len(new_line) > MAX_INLINE_DIFF_CHARS:
        return (
            [{"text": old_line, "changed": True}] if old_line else [],
            [{"text": new_line, "changed": True}] if new_line else [],
        )
    if ignore_format:
        old_tokens, old_keys = _markdown_tokens(old_line)
        new_tokens, new_keys = _markdown_tokens(new_line)
    else:
        old_tokens = _tokenize_line(old_line)
        new_tokens = _tokenize_line(new_line)
        old_keys, new_keys = old_tokens, new_tokens
    if len(old_tokens) * len(new_tokens) > MAX_INLINE_DIFF_TOKEN_PRODUCT:
        return _prefix_suffix_segments(old_tokens, new_tokens)

    # 比較用の文字列が None のトークン（無視する空白）は比較せず、変更なしとして表示する
    old_compared = [index for index, key in enumerate(old_keys) if key is not None]
    new_compared = [index for index, key in enumerate(new_keys) if key is not None]
    matcher = difflib.SequenceMatcher(
        None,
        [old_keys[index] for index in old_compared],
        [new_keys[index] for index in new_compared],
        autojunk=False,
    )
    old_changed = [False] * len(old_tokens)
    new_changed = [False] * len(new_tokens)
    for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
        if tag == "equal":
            continue
        for index in old_compared[old_start:old_end]:
            old_changed[index] = True
        for index in new_compared[new_start:new_end]:
            new_changed[index] = True
    return _merge_segments(old_tokens, old_changed), _merge_segments(new_tokens, new_changed)


def _merge_segments(tokens: list[str], changed: list[bool]) -> list[dict]:
    segments: list[dict] = []
    for token, is_changed in zip(tokens, changed):
        if not token:
            continue
        if segments and segments[-1]["changed"] == is_changed:
            segments[-1]["text"] += token
        else:
            segments.append({"text": token, "changed": is_changed})
    return segments


def _markdown_tokens(line: str) -> tuple[list[str], list[str | None]]:
    """書式を無視した行内比較用のトークンと比較用の文字列（None は比較しない空白）。"""
    body = line.rstrip()
    trail = line[len(body):]
    tokens: list[str] = []
    keys: list[str | None] = []
    prefix = MARKDOWN_PREFIX_RE.match(body)
    marker_start, marker_end, marker_key = -1, -1, ""
    if prefix and (prefix.group(3) or prefix.group(4)):
        group = 3 if prefix.group(3) else 4
        marker_start, marker_end = prefix.start(group), prefix.end()
        marker_key = "\x02L" if group == 3 else "\x02O"
    for match in MARKDOWN_TOKEN_SPLIT_RE.finditer(body):
        token = match.group()
        tokens.append(token)
        if MARKDOWN_SPACE_RE.fullmatch(token):
            keys.append(None)
        elif marker_start <= match.start() < marker_end:
            # 番号付きリストの「12」「.」のように複数のトークンでも、記号1つとして比べる
            keys.append(marker_key if match.start() == marker_start else None)
        elif token == "_":
            keys.append("*")
        else:
            keys.append(token)
    if trail:
        tokens.append(trail)
        keys.append(f"\x01{trail}")
    return tokens, keys


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
