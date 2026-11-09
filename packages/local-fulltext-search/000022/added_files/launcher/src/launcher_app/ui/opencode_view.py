"""
macOS 版 OpenCode ペインのチャット表示を「文字列＋書式名＋リンク」の並び（Segment）へ変換する。
native_mac.py はこの並びを NSAttributedString にして NSTextView へ流し込む。AppKit に依存しない。

【仕様】（Claudian 風）
- 会話が空のときは操作の案内（EMPTY_HINT）を出す。
- 自分の指示: 「あなた」の見出し（user_label）＋本文（user、背景色付きの吹き出し）。
- opencode の応答: 1 往復の最初に「opencode」の見出し（assistant_label）を 1 回だけ出し、
  本文は簡易 Markdown（見出し heading / 箇条書き「• 」/ 番号「n. 」/ 引用「│ 」/ コード code / 行内コード inline_code / 太字 bold）。
  本文の吹き出しごとに「コピー」リンク（copy:<ID>）を付ける。
- 思考とツールは見出しだけを出して折りたたむ（▸ 閉 / ▾ 開）。見出しは toggle:<ID> のリンク。
  - 思考: 「思考（1.2秒）」。開くと本文（muted）
  - ツール: 「✓ bash  npm test」（失敗は tool_error）。開くと入力と出力（detail）
- お知らせ: 「— 中断しました —」（notice）、エラーは「⚠ 理由」（error）。
"""

from __future__ import annotations

from dataclasses import dataclass

from launcher_app.markdown_lite import MdBlock, parse_markdown
from launcher_app.opencode_chat import ChatEntry, ChatTranscript, format_elapsed, tool_header

EMPTY_HINT = (
    "opencode に指示を入力してください。\n"
    "Enter で送信 / Shift+Enter で改行 / ↑ で過去の指示\n"
    "履歴から過去の会話を再開でき、Plan にすると変更せず計画だけ立てます。\n"
)


@dataclass(frozen=True)
class Segment:
    """表示する文字列と書式名。link があればクリックで toggle:<ID> / copy:<ID> を通知する。"""

    text: str
    style: str
    link: str | None = None


def _markdown_segments(blocks: list[MdBlock]) -> list[Segment]:
    """簡易 Markdown のブロックを Segment へ変換する。"""
    segments: list[Segment] = []
    for block in blocks:
        if block.kind == "code":
            segments.append(Segment(f"{block.text}\n", "code"))
            continue
        if block.kind == "heading":
            segments.append(Segment("".join(inline.text for inline in block.inlines) + "\n", "heading"))
            continue
        if block.kind == "bullet":
            segments.append(Segment("    " * block.level + "• ", "assistant"))
        elif block.kind == "numbered":
            segments.append(Segment(f"{block.level}. ", "assistant"))
        elif block.kind == "quote":
            segments.append(Segment("│ ", "muted"))
        base = "muted" if block.kind == "quote" else "assistant"
        for inline in block.inlines:
            style = {"bold": "bold", "code": "inline_code"}.get(inline.style, base)
            segments.append(Segment(inline.text, style))
        segments.append(Segment("\n", base))
    return segments


def _entry_segments(entry: ChatEntry) -> list[Segment]:
    """表示項目 1 つ分の Segment。"""
    if entry.kind == "user":
        return [Segment("あなた\n", "user_label"), Segment(f"{entry.text}\n", "user")]
    if entry.kind == "text":
        return [*_markdown_segments(parse_markdown(entry.text)), Segment("コピー", "link", f"copy:{entry.id}"), Segment("\n", "assistant")]
    if entry.kind == "reasoning":
        label = f"思考（{format_elapsed(entry.duration_seconds)}）" if entry.duration_seconds is not None else "思考"
        segments = [Segment(f"{'▾' if entry.expanded else '▸'} {label}\n", "toggle", f"toggle:{entry.id}")]
        if entry.expanded:
            segments.append(Segment(f"{entry.text}\n", "muted"))
        return segments
    if entry.kind == "tool":
        style = "tool_error" if entry.status == "error" else "tool"
        header = tool_header(entry.tool, entry.status, entry.summary)
        segments = [Segment(f"{'▾' if entry.expanded else '▸'} {header}\n", style, f"toggle:{entry.id}")]
        if entry.expanded:
            if entry.detail_input:
                segments.append(Segment(f"{entry.detail_input}\n", "detail"))
            segments.append(Segment(f"{entry.detail_output or '（出力なし）'}\n", "detail"))
        return segments
    if entry.status == "error":
        return [Segment(f"⚠ {entry.text}\n", "error")]
    return [Segment(f"— {entry.text} —\n", "notice")]


def render_chat(transcript: ChatTranscript) -> list[Segment]:
    """会話全体を Segment の並びへ変換する。"""
    entries = transcript.snapshot()
    if not entries:
        return [Segment(EMPTY_HINT, "muted")]
    segments: list[Segment] = []
    in_response = False
    for entry in entries:
        if entry.kind == "user":
            in_response = False
        elif entry.kind in {"text", "reasoning", "tool"} and not in_response:
            segments.append(Segment("opencode\n", "assistant_label"))
            in_response = True
        segments.extend(_entry_segments(entry))
    return segments
