"""
C# の型・メソッド定義の位置を軽量に走査するモジュール (csharp_symbols.py)

仕様:
1. 正規表現と波括弧の対応で、class / interface / struct / record と（型の外にある）メソッドの範囲を求める。
2. 波括弧の対応は、行コメント・ブロックコメント・文字列・文字リテラルを読み飛ばして数える。
3. AI出力の抽出（patch_parser）と、既存ファイル内の置換位置特定（patcher / patch_paths）の両方で同じ走査結果を使う。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

CS_METHOD_RE = re.compile(
    r"(?P<all>(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|partial|new|extern)\s+)+"
    r"[\w<>,.?\[\]\s]+\s+(?P<name>[A-Za-z_]\w*)\s*\((?P<args>[^)]*)\)\s*(?:where[^\{=>]+)?(?:\{|=>))",
    re.MULTILINE,
)
CS_NAMESPACE_RE = re.compile(r"\bnamespace\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)")
CS_TYPE_RE = re.compile(
    r"(?P<all>(?:(?:public|private|protected|internal|static|sealed|abstract|partial)\s+)*(?:class|interface|struct|record)\s+(?P<name>[A-Za-z_]\w*)(?:<[^>]+>)?(?:\s*:[^{]+)?\s*\{)",
    re.MULTILINE,
)


@dataclass(frozen=True)
class CsSymbol:
    name: str
    signature: str  # 型は空文字、メソッドは空白を正規化した引数文字列
    start: int
    end: int


def brace_end(text: str, brace_start: int) -> int:
    """`{` の位置から対応する `}` の直後のオフセットを返す（見つからなければ末尾）。"""
    depth = 0
    state = "code"
    index = brace_start
    while index < len(text):
        ch = text[index]
        pair = text[index:index + 2]
        if state == "code":
            if pair == "//":
                state = "line"; index += 2; continue
            if pair == "/*":
                state = "block"; index += 2; continue
            if ch == '"':
                state = "string"
            elif ch == "'":
                state = "char"
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return index + 1
        elif state == "line" and ch in "\r\n":
            state = "code"
        elif state == "block" and pair == "*/":
            state = "code"; index += 2; continue
        elif state in {"string", "char"}:
            if ch == "\\":
                index += 2; continue
            if (state == "string" and ch == '"') or (state == "char" and ch == "'"):
                state = "code"
        index += 1
    return len(text)


def scan_csharp_symbols(text: str) -> list[CsSymbol]:
    """型 → 型の外にあるメソッドの順にシンボルを返す。"""
    symbols: list[CsSymbol] = []
    type_ranges: list[tuple[int, int]] = []
    for match in CS_TYPE_RE.finditer(text):
        start = match.start("all")
        end = brace_end(text, text.find("{", match.start(), match.end()))
        type_ranges.append((start, end))
        symbols.append(CsSymbol(match.group("name"), "", start, end))
    for match in CS_METHOD_RE.finditer(text):
        start = match.start("all")
        if any(type_start <= start < type_end for type_start, type_end in type_ranges):
            continue
        marker = text.find(match.group(0)[-1], match.start(), match.end())
        end = brace_end(text, marker) if text[marker] == "{" else text.find(";", marker) + 1
        symbols.append(CsSymbol(match.group("name"), re.sub(r"\s+", " ", match.group("args").strip()), start, end))
    return symbols
