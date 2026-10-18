"""
AI出力の解析モジュール (patch_parser.py)

仕様:
1. `<file_changes>`、ファイルパス付きコードブロック、言語タグなしコードブロック、素の関数/クラス貼り付け、
   統合マークダウン見出し（`# ===== [ファイル X/Y] path =====`）を自動判定して Change の一覧にする。
2. Markdownファイル自体が内部に ```bash 等を含む場合も、外側フェンスが途中で終わらないよう内部フェンスの開閉を追跡する。
3. AI出力の文字列リテラル内の物理改行は \\n へ正規化してから ast.parse する（docstring等のトリプルクォート内は維持）。
4. 言語タグ・パス指定がないブロックはPython（関数・クラス）を最優先で解釈し、該当しなければC#を試す。
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field
from pathlib import Path

from .csharp_symbols import scan_csharp_symbols


@dataclass
class Change:
    key: str
    language: str
    content: str
    path: str = ""
    action: str = "modify"
    symbol: str = ""
    signature: str = ""
    candidates: list[str] = field(default_factory=list)


FILE_CHANGE_RE = re.compile(
    r'<file\s+path=["\']([^"\']+)["\']\s+action=["\'](create|modify|delete)["\']\s*>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*</file>',
    re.DOTALL | re.IGNORECASE,
)
PATH_HINT_RE = re.compile(r"(?:file|path|ファイル(?:パス)?)[：:\s]+[`\"]?([^`\"\s]+\.(?:py|cs|md|json|xml|ya?ml|toml|txt))[`\"]?", re.IGNORECASE)
RAW_PATH_RE = re.compile(r"(?:^|[`\s(])([A-Za-z0-9_.\-/\\]+\.(?:py|cs|md|json|xml|ya?ml|toml|txt))(?:$|[`\s)])", re.IGNORECASE)
SECTION_RE = re.compile(r"(?m)^#\s*=====\s*(?:\[[^\]]+\]\s*)?([^\s=]+\.(?:md|ya?ml|py|cs|json|txt))\s*=====\s*$")
FENCE_OPEN_RE = re.compile(r"^[ \t]*(`{3,}|~{3,})([^\r\n]*)\r?\n?$")
PATH_HINT_WINDOW = 240

# 文字列リテラルの開始（任意の接頭辞 + クォート）またはコメント開始。トリプルクォートを優先する。
_STRING_OR_COMMENT_RE = re.compile(r"#|(?:fr|rf|rb|br|f|r|b|u)?(?:\"\"\"|'''|\"|')", re.IGNORECASE)


def _normalize_ai_code(text: str) -> str:
    """AI出力内の文字列リテラルに含まれる物理改行を\\nにエスケープする。

    通常クォート（シングル/ダブルクォート）内の物理改行はPython構文エラーとなるため正規化する。
    docstring等のトリプルクォート内の物理改行は維持する。
    """
    result: list[str] = []
    i = 0
    length = len(text)

    while i < length:
        found = _STRING_OR_COMMENT_RE.search(text, i)
        if not found:
            result.append(text[i:])
            break
        result.append(text[i:found.start()])
        i = found.start()
        token = found.group(0)

        # コメント内のクォートを文字列開始と誤認しないようスキップ
        if token == "#":
            while i < length and text[i] not in "\r\n":
                result.append(text[i])
                i += 1
            continue

        result.append(token)
        i = found.end()

        # トリプルクォート: 物理改行を維持
        if token.endswith(('"""', "'''")):
            delim = token[-3:]
            while i < length:
                if text[i] == "\\" and i + 1 < length:
                    result.append(text[i:i + 2])
                    i += 2
                    continue
                if text[i:i + 3] == delim:
                    result.append(delim)
                    i += 3
                    break
                result.append(text[i])
                i += 1
            continue

        # シングル/ダブルクォート: 物理改行を \n へ
        end_char = token[-1]
        while i < length:
            if text[i] == "\\" and i + 1 < length:
                if text[i + 1] == "\r" and i + 2 < length and text[i + 2] == "\n":
                    result.append(text[i:i + 3])
                    i += 3
                else:
                    result.append(text[i:i + 2])
                    i += 2
                continue
            if text[i] == end_char:
                result.append(end_char)
                i += 1
                break
            if text[i] == "\r" and i + 1 < length and text[i + 1] == "\n":
                result.append("\\n")
                i += 2
            elif text[i] in "\r\n":
                result.append("\\n")
                i += 1
            else:
                result.append(text[i])
                i += 1

    return "".join(result)


def _extract_python_symbols(text: str) -> list[Change]:
    try:
        tree = ast.parse(text)
        lines = text.splitlines(keepends=True)
    except SyntaxError:
        try:
            normalized = _normalize_ai_code(text)
            tree = ast.parse(normalized)
            lines = normalized.splitlines(keepends=True)
        except SyntaxError:
            return []
    changes = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            first = node.decorator_list[0].lineno if node.decorator_list else node.lineno
            content = "".join(lines[first - 1: node.end_lineno]).rstrip() + "\n"
            signature = ""
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                signature = ",".join(arg.arg for arg in node.args.args)
            changes.append(Change(f"py:{node.name}:{len(changes)}", "python", content, symbol=node.name, signature=signature))
    return changes


def _extract_csharp_symbols(text: str) -> list[Change]:
    changes = []
    for symbol in scan_csharp_symbols(text):
        content = text[symbol.start:symbol.end].strip() + "\n"
        changes.append(Change(f"cs:{symbol.name}:{len(changes)}", "csharp", content, symbol=symbol.name, signature=symbol.signature))
    return changes


def _find_path_hint(info: str, preceding_text: str) -> str:
    """フェンスの情報文字列、直前の文章の順にファイルパスの手掛かりを探す。"""
    for text in (info, preceding_text):
        match = PATH_HINT_RE.search(text) or RAW_PATH_RE.search(text)
        if match:
            return match.group(1)
    return ""


def _extract_symbols(language: str, code: str) -> list[Change]:
    """言語に応じて関数/クラス/型を抽出する。言語未指定ならPython、次にC#を試す。"""
    if language in {"python", "py"}:
        return _extract_python_symbols(code)
    if language in {"csharp", "cs", "c#"}:
        return _extract_csharp_symbols(code)
    if not language:
        return _extract_python_symbols(code) or _extract_csharp_symbols(code)
    return []


def _iter_fenced_blocks(ai_output: str) -> list[tuple[int, str, str]]:
    """
    AI出力からコードブロック (start_offset, info, code) を抽出する。
    Markdownファイルのコードブロック（```markdown path: docs/xxx.md 等）の内部に
    ```bash などのコードブロックがネストされている場合でも、途中で切れずに外側フェンス終端まで抽出する。
    """
    lines = ai_output.splitlines(keepends=True)
    blocks: list[tuple[int, str, str]] = []
    i = 0
    offset = 0
    n = len(lines)
    open_re = FENCE_OPEN_RE

    while i < n:
        line = lines[i]
        m = open_re.match(line)
        if not m:
            offset += len(line)
            i += 1
            continue

        fence_chars = m.group(1)
        fence_char = fence_chars[0]
        fence_len = len(fence_chars)
        info = m.group(2).strip()
        start_offset = offset
        hint = _find_path_hint(info, ai_output[max(0, start_offset - PATH_HINT_WINDOW):start_offset])
        lang_token = info.lower().split()[0] if info else ""
        is_md_block = lang_token in {"markdown", "md"} or hint.lower().endswith(".md")

        offset += len(line)
        i += 1
        body_lines: list[str] = []
        inner_fence_open = False

        while i < n:
            cur_line = lines[i]
            offset += len(cur_line)
            i += 1
            m_inner = open_re.match(cur_line)
            if m_inner and m_inner.group(1)[0] == fence_char:
                cur_len = len(m_inner.group(1))
                cur_info = m_inner.group(2).strip()
                if is_md_block and cur_len == fence_len:
                    if not inner_fence_open and cur_info:
                        # Markdown内部の ```bash 等の開始
                        inner_fence_open = True
                        body_lines.append(cur_line)
                        continue
                    if inner_fence_open and not cur_info:
                        # Markdown内部のコードブロック終了
                        inner_fence_open = False
                        body_lines.append(cur_line)
                        continue
                if not cur_info and cur_len >= fence_len and not inner_fence_open:
                    break
            body_lines.append(cur_line)

        blocks.append((start_offset, info, "".join(body_lines)))

    return blocks


def parse_ai_output(ai_output: str) -> list[Change]:
    xml_changes = []
    for index, match in enumerate(FILE_CHANGE_RE.finditer(ai_output)):
        content = match.group(3)
        if content.startswith("\n"):
            content = content[1:]
        xml_changes.append(Change(f"file:{index}", Path(match.group(1)).suffix.lstrip("."), content, path=match.group(1), action=match.group(2).lower()))
    if xml_changes:
        return xml_changes

    changes: list[Change] = []
    for index, (start_offset, info, code) in enumerate(_iter_fenced_blocks(ai_output)):
        path = _find_path_hint(info, ai_output[max(0, start_offset - PATH_HINT_WINDOW):start_offset])
        language = info.lower().split()[0] if info else ""
        if path:
            suffix = Path(path).suffix.lower()
            if suffix == ".py":
                language = "python"
            elif suffix == ".cs":
                language = "csharp"
            symbols = _extract_symbols(language, code)
            if symbols:
                for symbol in symbols:
                    symbol.key = f"fence:{index}:{symbol.key}"
                    symbol.path = path
                changes.extend(symbols)
            else:
                changes.append(Change(f"fence:{index}", Path(path).suffix.lstrip("."), code, path=path, action="modify"))
            continue
        changes.extend(_extract_symbols(language, code))
    if changes:
        return changes

    # 統合マークダウンの境界見出し形式 (# ===== [ファイル 1/N] docs/xxx.md =====) からの抽出フォールバック
    section_matches = list(SECTION_RE.finditer(ai_output))
    if section_matches:
        for idx, m in enumerate(section_matches):
            sec_path = m.group(1).strip()
            body_end = section_matches[idx + 1].start() if idx + 1 < len(section_matches) else len(ai_output)
            sec_body = ai_output[m.end():body_end].strip() + "\n"
            changes.append(Change(f"section:{idx}", Path(sec_path).suffix.lstrip("."), sec_body, path=sec_path, action="modify"))
        return changes

    return _extract_python_symbols(ai_output) or _extract_csharp_symbols(ai_output)
