"""
OpenCode の応答（Markdown）を、ランチャーの小さなペインで表示するための簡易 Markdown 解析。
WPF 版（MarkdownLite.cs）と同じ約束で動く。

【仕様】
- ブロック: 段落・見出し（# 〜 ######、level=見出しの深さ）・箇条書き（- * +、level=字下げ 2 文字ごとの階層）・
  番号付き（1. 、level=番号）・引用（> ）・コード（``` で囲む。言語名を持ち、中身は解釈しない）。
- 空行で段落を分け、段落内の改行はそのまま残す。閉じていないコードブロックは最後までコードとして扱う。
- 行内: `コード` と **太字** だけを分ける。閉じていない記号は文字のまま残す。
"""

from __future__ import annotations

from dataclasses import dataclass
import re

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
_BULLET_RE = re.compile(r"^(\s*)[-*+]\s+(.*)$")
_NUMBERED_RE = re.compile(r"^\s*(\d+)[.)]\s+(.*)$")
_QUOTE_RE = re.compile(r"^>\s?(.*)$")
_FENCE_RE = re.compile(r"^\s*```\s*([\w+#.-]*)\s*$")
_INLINE_RE = re.compile(r"`([^`\n]+)`|\*\*([^*\n](?:[^\n]*?[^*\s])?)\*\*")


@dataclass(frozen=True)
class MdInline:
    """行内の文字列と書式（plain / bold / code）。"""

    text: str
    style: str = "plain"


@dataclass(frozen=True)
class MdBlock:
    """ブロック 1 つ。code は text / language を、それ以外は inlines を持つ。"""

    kind: str
    inlines: tuple[MdInline, ...]
    level: int = 0
    text: str = ""
    language: str = ""


def parse_inlines(text: str) -> list[MdInline]:
    """行内コードと太字を分ける。"""
    result: list[MdInline] = []
    position = 0
    for match in _INLINE_RE.finditer(text):
        if match.start() > position:
            result.append(MdInline(text[position:match.start()]))
        if match.group(1) is not None:
            result.append(MdInline(match.group(1), "code"))
        else:
            result.append(MdInline(match.group(2), "bold"))
        position = match.end()
    if position < len(text):
        result.append(MdInline(text[position:]))
    return result


def _block(kind: str, text: str, level: int = 0) -> MdBlock:
    return MdBlock(kind, tuple(parse_inlines(text)), level)


def parse_markdown(text: str) -> list[MdBlock]:
    """Markdown をブロックの並びへ分ける。"""
    lines = str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks: list[MdBlock] = []
    paragraph: list[str] = []

    def flush_paragraph() -> None:
        if paragraph:
            blocks.append(_block("paragraph", "\n".join(paragraph)))
            paragraph.clear()

    index = 0
    while index < len(lines):
        line = lines[index]
        fence = _FENCE_RE.match(line)
        if fence:
            flush_paragraph()
            code_lines: list[str] = []
            index += 1
            while index < len(lines) and not _FENCE_RE.match(lines[index]):
                code_lines.append(lines[index])
                index += 1
            blocks.append(MdBlock("code", (), text="\n".join(code_lines), language=fence.group(1)))
            index += 1
            continue
        if not line.strip():
            flush_paragraph()
        elif heading := _HEADING_RE.match(line):
            flush_paragraph()
            blocks.append(_block("heading", heading.group(2).strip(), len(heading.group(1))))
        elif bullet := _BULLET_RE.match(line):
            flush_paragraph()
            blocks.append(_block("bullet", bullet.group(2).strip(), len(bullet.group(1).expandtabs(2)) // 2))
        elif numbered := _NUMBERED_RE.match(line):
            flush_paragraph()
            blocks.append(_block("numbered", numbered.group(2).strip(), int(numbered.group(1))))
        elif quote := _QUOTE_RE.match(line):
            flush_paragraph()
            blocks.append(_block("quote", quote.group(1).strip()))
        else:
            paragraph.append(line.rstrip())
        index += 1
    flush_paragraph()
    return blocks
