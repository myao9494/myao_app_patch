"""
AI出力コードの差分プレビュー生成と安全なトランザクション反映モジュール (patcher.py)

仕様:
1. 解析は patch_parser、反映先の検証・推測は patch_paths、C#の範囲走査は csharp_symbols に分離している。
2. 関数・クラス・C#型の置換、ファイル全文置換、作成、削除の差分プレビュー（prepare_preview）を生成する。
3. 新規Pythonシンボル追加時、if __name__ == '__main__' がある場合はその直前に挿入。同名シンボル重複時はトップレベル/最後の定義を優先置換。
4. apply_preview は一時ファイル経由のアトミック置換で書き込み、失敗時は全ファイルを元に戻す（既存の文字コード・BOM・改行を維持）。
"""

from __future__ import annotations

import ast
import difflib
import os
import re
import tempfile
import textwrap
import threading
from pathlib import Path

from .csharp_symbols import scan_csharp_symbols
from .patch_parser import Change, parse_ai_output
from .patch_paths import infer_changes, safe_target
from .repository import read_text_file

__all__ = ["Change", "apply_preview", "parse_ai_output", "prepare_preview", "safe_target"]

_APPLY_LOCK = threading.RLock()
MAIN_GUARD_RE = re.compile(r'^[ \t]*if\s+__name__\s*==\s*["\']__main__["\']\s*:', re.MULTILINE)


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
        matches = [symbol for symbol in scan_csharp_symbols(source) if symbol.name == change.symbol]
        if change.signature:
            matches = [symbol for symbol in matches if symbol.signature == change.signature] or matches
        if len(matches) == 1:
            return source[:matches[0].start] + change.content.rstrip() + source[matches[0].end:]
    separator = "\n\n"
    return source.rstrip() + separator + change.content.rstrip() + "\n"


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
