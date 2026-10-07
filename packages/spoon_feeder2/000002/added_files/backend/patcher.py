"""
AI出力コードのパース、反映先推測、差分プレビュー生成、および安全なトランザクション反映モジュール (patcher.py)

仕様:
1. AI出力内の文字列リテラル物理改行の正規化や言語タグなしコードブロックのフォールバック解析に対応。
2. 関数・クラス置換、ファイルブロック、<file_changes> の3形式を自動判定。
3. メインリポジトリに加え、許可された外部ライブラリ（extra_roots: PYTHONPATH / sys.path 対象）への差分反映に対応。
4. safe_target による安全なパス検証およびトランザクション書き込み（ロールバック機能付き）。
5. 新規Pythonシンボル追加時、if __name__ == '__main__' がある場合はその直前に挿入。同名シンボル重複時の優先置換に対応。
"""

from __future__ import annotations

import ast
import difflib
import os
import re
import tempfile
import textwrap
import threading
from dataclasses import dataclass, field
from pathlib import Path

from .repository import list_repository_entries, read_text_file


_APPLY_LOCK = threading.RLock()


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
FENCE_RE = re.compile(r"```([^\n]*)\n(.*?)```", re.DOTALL)
PATH_HINT_RE = re.compile(r"(?:file|path|ファイル(?:パス)?)[：:\s]+[`\"]?([^`\"\s]+\.(?:py|cs|md|json|xml|ya?ml|toml|txt))[`\"]?", re.IGNORECASE)
RAW_PATH_RE = re.compile(r"(?:^|[`\s(])([A-Za-z0-9_.\-/\\]+\.(?:py|cs|md|json|xml|ya?ml|toml|txt))(?:$|[`\s)])", re.IGNORECASE)
CS_METHOD_RE = re.compile(
    r"(?P<all>(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|partial|new|extern)\s+)+"
    r"[\w<>,.?\[\]\s]+\s+(?P<name>[A-Za-z_]\w*)\s*\((?P<args>[^)]*)\)\s*(?:where[^\{=>]+)?(?:\{|=>))",
    re.MULTILINE,
)
CS_TYPE_RE = re.compile(
    r"(?P<all>(?:(?:public|private|protected|internal|static|sealed|abstract|partial)\s+)*(?:class|interface|struct|record)\s+(?P<name>[A-Za-z_]\w*)(?:<[^>]+>)?(?:\s*:[^{]+)?\s*\{)",
    re.MULTILINE,
)
MAIN_GUARD_RE = re.compile(
    r'^[ \t]*if\s+__name__\s*==\s*["\']__main__["\']\s*:',
    re.MULTILINE,
)


def safe_target(root: Path, path: str, extra_roots: list[Path] | None = None) -> Path:
    normalized = path.replace("\\", "/").strip("/")
    if not normalized:
        raise ValueError(f"不正なファイルパスです: {path}")

    all_allowed = [root.resolve()] + [er.resolve() for er in (extra_roots or []) if er.resolve() != root.resolve()]

    raw_path = Path(path).expanduser()
    if raw_path.is_absolute():
        target_abs = raw_path.resolve()
        for allowed in all_allowed:
            if allowed == target_abs or allowed in target_abs.parents:
                return target_abs
        raise ValueError(f"不正なファイルパスです: {path}")

    for allowed in all_allowed:
        if normalized == allowed.name or normalized.startswith(f"{allowed.name}/"):
            sub_rel = normalized[len(allowed.name):].lstrip("/")
            target = (allowed / sub_rel).resolve()
            if allowed in target.parents or allowed == target:
                return target

    target_main = (root / normalized).resolve()
    if root.resolve() in target_main.parents or root.resolve() == target_main:
        return target_main

    for allowed in all_allowed:
        target_extra = (allowed / normalized).resolve()
        if allowed in target_extra.parents or allowed == target_extra:
            return target_extra

    raise ValueError(f"不正なファイルパスです: {path}")


def _normalize_ai_code(text: str) -> str:
    """AI出力内の文字列リテラルに含まれる物理改行を\\nにエスケープする。

    通常クォート（シングル/ダブルクォート）内の物理改行はPython構文エラーとなるため正規化する。
    docstring等のトリプルクォート内の物理改行は維持する。
    """
    result = []
    i = 0
    length = len(text)

    triple_prefixes = (
        'fr"""', "fr'''", 'rf"""', "rf'''", 'rb"""', "rb'''", 'br"""', "br'''",
        'f"""', "f'''", 'r"""', "r'''", 'b"""', "b'''", 'u"""', "u'''",
        '"""', "'''",
    )
    single_prefixes = (
        'fr"', "fr'", 'rf"', "rf'", 'rb"', "rb'", 'br"', "br'",
        'f"', "f'", 'r"', "r'", 'b"', "b'", 'u"', "u'",
        '"', "'",
    )

    while i < length:
        ch = text[i]

        # コメント内のクォートを文字列開始と誤認しないようスキップ
        if ch == "#":
            while i < length and text[i] not in "\r\n":
                result.append(text[i])
                i += 1
            continue

        # トリプルクォート
        matched_triple = None
        for prefix in triple_prefixes:
            if text[i:i + len(prefix)].lower() == prefix:
                matched_triple = prefix
                break
        if matched_triple:
            delim = matched_triple[-3:]
            actual_prefix = text[i:i + len(matched_triple)]
            result.append(actual_prefix)
            i += len(matched_triple)
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

        # シングル/ダブルクォート
        matched_single = None
        for prefix in single_prefixes:
            if text[i:i + len(prefix)].lower() == prefix:
                matched_single = prefix
                break
        if matched_single:
            end_char = matched_single[-1]
            actual_prefix = text[i:i + len(matched_single)]
            result.append(actual_prefix)
            i += len(matched_single)
            while i < length:
                if text[i] == "\\" and i + 1 < length:
                    if text[i + 1] == "\r" and i + 2 < length and text[i + 2] == "\n":
                        result.append(text[i:i + 3])
                        i += 3
                    elif text[i + 1] in "\r\n":
                        result.append(text[i:i + 2])
                        i += 2
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
            continue

        result.append(ch)
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


_extract_python_functions = _extract_python_symbols


def _brace_end(text: str, brace_start: int) -> int:
    depth = 0
    state = "code"
    index = brace_start
    while index < len(text):
        ch = text[index]
        pair = text[index:index + 2]
        if state == "code":
            if pair == "//": state = "line"; index += 2; continue
            if pair == "/*": state = "block"; index += 2; continue
            if ch == '"': state = "string"
            elif ch == "'": state = "char"
            elif ch == "{": depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0: return index + 1
        elif state == "line" and ch in "\r\n": state = "code"
        elif state == "block" and pair == "*/": state = "code"; index += 2; continue
        elif state in {"string", "char"}:
            if ch == "\\": index += 2; continue
            if (state == "string" and ch == '"') or (state == "char" and ch == "'"): state = "code"
        index += 1
    return len(text)


def _extract_csharp_symbols(text: str) -> list[Change]:
    changes = []
    class_ranges = []
    for match in CS_TYPE_RE.finditer(text):
        start = match.start("all")
        marker = text.find("{", match.start(), match.end())
        end = _brace_end(text, marker)
        class_ranges.append((start, end))
        content = text[start:end].strip() + "\n"
        changes.append(Change(f"cs:{match.group('name')}:{len(changes)}", "csharp", content, symbol=match.group("name"), signature=""))

    for match in CS_METHOD_RE.finditer(text):
        start = match.start("all")
        if any(cs <= start < ce for cs, ce in class_ranges):
            continue
        marker = text.find(match.group(0)[-1], match.start(), match.end())
        end = _brace_end(text, marker) if text[marker] == "{" else text.find(";", marker) + 1
        content = text[start:end].strip() + "\n"
        args = re.sub(r"\s+", " ", match.group("args").strip())
        changes.append(Change(f"cs:{match.group('name')}:{len(changes)}", "csharp", content, symbol=match.group("name"), signature=args))
    return changes


_extract_csharp_methods = _extract_csharp_symbols


def parse_ai_output(ai_output: str) -> list[Change]:
    xml_changes = []
    for index, match in enumerate(FILE_CHANGE_RE.finditer(ai_output)):
        content = match.group(3)
        if content.startswith("\n"): content = content[1:]
        xml_changes.append(Change(f"file:{index}", Path(match.group(1)).suffix.lstrip("."), content, path=match.group(1), action=match.group(2).lower()))
    if xml_changes:
        return xml_changes

    changes: list[Change] = []
    for index, fence in enumerate(FENCE_RE.finditer(ai_output)):
        info, code = fence.group(1).strip(), fence.group(2)
        nearby = ai_output[max(0, fence.start() - 240):fence.start()]
        hint = PATH_HINT_RE.search(info) or RAW_PATH_RE.search(info) or PATH_HINT_RE.search(nearby) or RAW_PATH_RE.search(nearby)
        language = info.lower().split()[0] if info else ""
        if hint:
            path = hint.group(1)
            if Path(path).suffix.lower() == ".py":
                language = "python"
            elif Path(path).suffix.lower() == ".cs":
                language = "csharp"
            symbols = _extract_python_symbols(code) if language in {"python", "py"} else _extract_csharp_symbols(code) if language in {"csharp", "cs", "c#"} else []
            if not symbols and not language:
                symbols = _extract_python_symbols(code) or _extract_csharp_symbols(code)
            if symbols:
                for symbol in symbols:
                    symbol.key = f"fence:{index}:{symbol.key}"
                    symbol.path = path
                changes.extend(symbols)
                continue
            changes.append(Change(f"fence:{index}", Path(path).suffix.lstrip("."), code, path=path, action="modify"))
            continue
        symbols = _extract_python_symbols(code) if language in {"python", "py"} else _extract_csharp_symbols(code) if language in {"csharp", "cs", "c#"} else []
        if not symbols and not language:
            symbols = _extract_python_symbols(code) or _extract_csharp_symbols(code)
        changes.extend(symbols)
    if changes:
        return changes
    return _extract_python_symbols(ai_output) or _extract_csharp_symbols(ai_output)


def _python_symbols(path: Path) -> list[tuple[str, str, int, int]]:
    try:
        source, _ = read_text_file(path)
        tree = ast.parse(source)
    except (OSError, SyntaxError):
        return []
    result = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            signature = ""
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                signature = ",".join(arg.arg for arg in node.args.args)
            first = node.decorator_list[0].lineno if node.decorator_list else node.lineno
            result.append((node.name, signature, first, node.end_lineno or node.lineno))
    return result


def _csharp_symbols(path: Path) -> list[tuple[str, str, int, int]]:
    try: source, _ = read_text_file(path)
    except OSError: return []
    return _csharp_symbols_from_source(source)


def _candidate_files(root: Path, language: str, extra_roots: list[Path] | None = None) -> list[str]:
    entries, _ = list_repository_entries(root)
    suffix = ".py" if language == "python" else ".cs"
    results = [entry.path for entry in entries if entry.path.lower().endswith(suffix)]
    for er in extra_roots or []:
        if er.is_dir() and er.resolve() != root.resolve():
            extra_entries, _ = list_repository_entries(er)
            for entry in extra_entries:
                if entry.path.lower().endswith(suffix):
                    results.append(f"{er.name}/{entry.path}")
    return results


def infer_changes(
    root: Path,
    changes: list[Change],
    overrides: dict[str, str] | None = None,
    target_path: str = "",
    extra_roots: list[Path] | None = None,
) -> list[Change]:
    overrides = overrides or {}
    files_by_language: dict[str, list[str]] = {}
    symbols_by_file: dict[tuple[str, str], list[tuple[str, str, int, int]]] = {}

    def language_files(language: str) -> list[str]:
        if language not in files_by_language:
            files_by_language[language] = _candidate_files(root, language, extra_roots)
        return files_by_language[language]

    def file_symbols(language: str, relative: str) -> list[tuple[str, str, int, int]]:
        key = (language, relative)
        if key not in symbols_by_file:
            path = safe_target(root, relative, extra_roots)
            symbols_by_file[key] = _python_symbols(path) if language == "python" else _csharp_symbols(path)
        return symbols_by_file[key]

    for change in changes:
        explicit = overrides.get(change.key) or change.path or target_path
        if explicit:
            change.path = explicit.replace("\\", "/")
            continue
        candidates = []
        files = language_files(change.language)
        for rel in files:
            symbols = file_symbols(change.language, rel)
            if any(name == change.symbol and (not change.signature or not signature or signature == change.signature) for name, signature, _, _ in symbols):
                candidates.append(rel)
        change.candidates = candidates
        if len(candidates) == 1:
            change.path = candidates[0]
        elif not candidates:
            preferred = [p for p in files if Path(p).name.lower() in {"main.py", "program.cs", "app.py"}]
            if len(preferred) == 1:
                change.path = preferred[0]
            elif len(files) == 1:
                change.path = files[0]
            else:
                change.candidates = preferred or files[:30]
    return changes


def _is_main_guard_test(test_node: ast.expr) -> bool:
    """if __name__ == '__main__' または '__main__' == __name__ かどうか判定する。"""
    if isinstance(test_node, ast.Compare):
        if len(test_node.ops) == 1 and isinstance(test_node.ops[0], ast.Eq) and len(test_node.comparators) == 1:
            left, right = test_node.left, test_node.comparators[0]
            if isinstance(left, ast.Name) and left.id == "__name__" and isinstance(right, ast.Constant) and right.value == "__main__":
                return True
            if isinstance(right, ast.Name) and right.id == "__name__" and isinstance(left, ast.Constant) and left.value == "__main__":
                return True
    return False


def _find_python_main_guard_line(source: str) -> int | None:
    """Pythonソースコード内のトップレベル if __name__ == '__main__': の開始行番号（1-indexed）を取得する。"""
    try:
        tree = ast.parse(source)
        for node in tree.body:
            if isinstance(node, ast.If) and _is_main_guard_test(node.test):
                return node.lineno
    except SyntaxError:
        pass

    match = MAIN_GUARD_RE.search(source)
    if match:
        return source[:match.start()].count("\n") + 1
    return None


def _insert_python_symbol(source: str, content: str) -> str:
    """新規Pythonシンボルを追加する。if __name__ == '__main__' がある場合はその直前に挿入する。"""
    guard_line = _find_python_main_guard_line(source)
    cleaned_content = content.rstrip()
    if guard_line is not None:
        lines = source.splitlines(keepends=True)
        before_lines = lines[:guard_line - 1]
        after_lines = lines[guard_line - 1:]

        before_text = "".join(before_lines).rstrip()
        after_text = "".join(after_lines).lstrip("\r\n")

        sep_before = "\n\n\n" if before_text else ""
        sep_after = "\n\n\n" if after_text else "\n"

        return before_text + sep_before + cleaned_content + sep_after + after_text

    sep = "\n\n\n" if source.strip() else ""
    return source.rstrip() + sep + cleaned_content + "\n"


def _find_target_match(tree: ast.AST, symbol_name: str, replacement_code: str) -> tuple[int, int] | None:
    """Python ASTから置換対象のノード範囲 (first_lineno, end_lineno) を特定する。"""
    replacement_has_decorator = replacement_code.lstrip().startswith("@")

    toplevel_matches: list[tuple[int, int]] = []
    other_matches: list[tuple[int, int]] = []

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == symbol_name:
            first = node.decorator_list[0].lineno if replacement_has_decorator and node.decorator_list else node.lineno
            toplevel_matches.append((first, node.end_lineno or node.lineno))

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == symbol_name:
            first = node.decorator_list[0].lineno if replacement_has_decorator and node.decorator_list else node.lineno
            span = (first, node.end_lineno or node.lineno)
            if span not in toplevel_matches and span not in other_matches:
                other_matches.append(span)

    # 1. トップレベルに1つだけ一致がある場合は最優先でそれを置換
    if len(toplevel_matches) == 1:
        return toplevel_matches[0]

    # 2. トップレベルに複数一致がある場合（同名関数が既に重複している場合）は最後の定義を置換して増殖を防ぐ
    if len(toplevel_matches) > 1:
        return toplevel_matches[-1]

    # 3. トップレベルに一致はないが、クラス内等に一致がある場合
    if len(other_matches) == 1:
        return other_matches[0]
    if len(other_matches) > 1:
        return other_matches[-1]

    return None


def _replace_symbol(source: str, change: Change) -> str:
    if change.language == "python":
        try:
            tree = ast.parse(source)
        except SyntaxError:
            tree = None
        target_span = _find_target_match(tree, change.symbol, change.content) if tree else None
        if target_span:
            lines = source.splitlines(keepends=True)
            first, last = target_span
            existing_line = lines[first - 1] if first <= len(lines) else ""
            indentation = existing_line[: len(existing_line) - len(existing_line.lstrip())]
            replacement = textwrap.indent(textwrap.dedent(change.content).rstrip() + "\n", indentation)
            return "".join(lines[:first - 1]) + replacement + "".join(lines[last:])
        return _insert_python_symbol(source, change.content)
    else:
        matches = [item for item in _csharp_symbols_from_source(source) if item[0] == change.symbol]
        if change.signature:
            exact = [item for item in matches if item[1] == change.signature]
            matches = exact or matches
        if len(matches) == 1:
            _, _, first, last = matches[0]
            return source[:first] + change.content.rstrip() + source[last:]
    separator = "\n\n"
    return source.rstrip() + separator + change.content.rstrip() + "\n"


def _csharp_symbols_from_source(source: str) -> list[tuple[str, str, int, int]]:
    result = []
    class_ranges = []
    for match in CS_TYPE_RE.finditer(source):
        start = match.start("all")
        marker = source.find("{", match.start(), match.end())
        end = _brace_end(source, marker)
        class_ranges.append((start, end))
        result.append((match.group("name"), "", start, end))
    for match in CS_METHOD_RE.finditer(source):
        start = match.start("all")
        if any(cs <= start < ce for cs, ce in class_ranges):
            continue
        marker = source.find(match.group(0)[-1], match.start(), match.end())
        end = _brace_end(source, marker) if source[marker] == "{" else source.find(";", marker) + 1
        result.append((match.group("name"), re.sub(r"\s+", " ", match.group("args").strip()), start, end))
    return result



def _preferred_newline(source: str) -> str:
    crlf = source.count("\r\n")
    lf = source.count("\n") - crlf
    cr = source.count("\r") - crlf
    if crlf >= max(lf, cr) and crlf:
        return "\r\n"
    if cr > lf and cr:
        return "\r"
    return "\n"


def _normalize_newlines(source: str, newline: str) -> str:
    return source.replace("\r\n", "\n").replace("\r", "\n").replace("\n", newline)


def prepare_preview(
    root: Path,
    ai_output: str,
    overrides: dict[str, str] | None = None,
    target_path: str = "",
    extra_roots: list[Path] | None = None,
) -> dict:
    changes = parse_ai_output(ai_output)
    if not changes:
        return {"status": "needs_input", "message": "反映可能なコードを検出できませんでした。ファイルパス付きコードブロック、関数全体、または file_changes を貼り付けてください。", "changes": []}
    infer_changes(root, changes, overrides, target_path, extra_roots)
    unresolved = [change for change in changes if not change.path]
    operations = []
    working_content: dict[Path, str] = {}
    for change in changes:
        item = {"key": change.key, "path": change.path, "action": change.action, "symbol": change.symbol, "language": change.language, "candidates": change.candidates}
        if not change.path:
            item["diff"] = ""
            operations.append(item); continue
        target = safe_target(root, change.path, extra_roots)
        old = working_content[target] if target in working_content else (read_text_file(target)[0] if target.exists() and target.is_file() else "")
        if change.action == "delete": new = ""
        elif change.symbol and target.exists(): new = _replace_symbol(old, change)
        elif change.symbol: new = change.content.rstrip() + "\n"
        else: new = change.content
        if change.action != "delete":
            newline = _preferred_newline(old) if old else os.linesep
            new = _normalize_newlines(new, newline)
        working_content[target] = new
        item["diff"] = "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile=f"a/{change.path}", tofile=f"b/{change.path}"))
        item["content"] = new
        operations.append(item)
    return {
        "status": "needs_selection" if unresolved else "success",
        "message": "反映先を選択してください。" if unresolved else f"{len(operations)}件の変更を検証しました。",
        "changes": operations,
    }


def apply_preview(root: Path, preview: dict, extra_roots: list[Path] | None = None) -> dict:
    if preview.get("status") != "success":
        return {"status": "needs_selection", "message": "未確定の反映先があります。"}
    backups: dict[Path, bytes | None] = {}
    temporary_paths: list[Path] = []
    with _APPLY_LOCK:
        try:
            for operation in preview["changes"]:
                target = safe_target(root, operation["path"], extra_roots)
                backups[target] = target.read_bytes() if target.exists() else None
            for operation in preview["changes"]:
                target = safe_target(root, operation["path"], extra_roots)
                if operation["action"] == "delete":
                    if target.exists(): target.unlink()
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                encoding = read_text_file(target)[1] if target.exists() else "utf-8"
                with tempfile.NamedTemporaryFile(
                    mode="w", encoding=encoding, newline="", dir=target.parent,
                    prefix=f".{target.name}.spoonfeeder.", suffix=".tmp", delete=False,
                ) as temporary:
                    temporary.write(operation.get("content", ""))
                    temporary_path = Path(temporary.name)
                temporary_paths.append(temporary_path)
                os.replace(temporary_path, target)
                temporary_paths.remove(temporary_path)
            return {"status": "success", "message": f"{len(preview['changes'])}件の変更を反映しました。", "applied": [op["path"] for op in preview["changes"]]}
        except Exception as exc:
            for target, backup in backups.items():
                if backup is None:
                    if target.exists(): target.unlink()
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(backup)
            return {"status": "error", "message": f"反映に失敗したため元に戻しました: {exc}"}
        finally:
            for temporary_path in temporary_paths:
                try:
                    temporary_path.unlink(missing_ok=True)
                except OSError:
                    pass
