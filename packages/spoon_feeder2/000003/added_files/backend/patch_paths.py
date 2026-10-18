"""
AI出力の反映先パスの検証と推測モジュール (patch_paths.py)

仕様:
1. safe_target: メインリポジトリと許可された外部ライブラリ（extra_roots）の外へ出るパスを拒否する。
   リポジトリ名の接頭辞（`myrepo/src/a.py`）は、メインリポジトリ直下に同名の実体がない場合だけ接頭辞として解釈する。
2. infer_changes: パス指定のない変更を、同名シンボルを持つ一意なファイルへ割り当てる。複数候補・候補なしの場合は候補一覧を返す。
"""

from __future__ import annotations

import ast
from pathlib import Path

from .csharp_symbols import scan_csharp_symbols
from .patch_parser import Change
from .repository import list_repository_entries, read_text_file

# (名前, 引数シグネチャ, 開始, 終了)  Pythonは行番号、C#は文字オフセット
SymbolSpan = tuple[str, str, int, int]


def _within(allowed: Path, target: Path) -> bool:
    return allowed == target or allowed in target.parents


def safe_target(root: Path, path: str, extra_roots: list[Path] | None = None) -> Path:
    normalized = path.replace("\\", "/").strip("/")
    if not normalized:
        raise ValueError(f"不正なファイルパスです: {path}")

    main_root = root.resolve()
    all_allowed = [main_root] + [er.resolve() for er in (extra_roots or []) if er.resolve() != main_root]

    raw_path = Path(path).expanduser()
    if raw_path.is_absolute():
        target_abs = raw_path.resolve()
        if any(_within(allowed, target_abs) for allowed in all_allowed):
            return target_abs
        raise ValueError(f"不正なファイルパスです: {path}")

    # メインリポジトリ直下に同名の実体（例: myapp/myapp/）があれば、リポジトリ名の接頭辞とは解釈しない。
    exists_in_main = (main_root / normalized.split("/", 1)[0]).exists()
    if not exists_in_main:
        for allowed in all_allowed:
            if normalized == allowed.name or normalized.startswith(f"{allowed.name}/"):
                target = (allowed / normalized[len(allowed.name):].lstrip("/")).resolve()
                if _within(allowed, target):
                    return target

    target_main = (main_root / normalized).resolve()
    if _within(main_root, target_main):
        return target_main

    for allowed in all_allowed:
        target_extra = (allowed / normalized).resolve()
        if _within(allowed, target_extra):
            return target_extra

    raise ValueError(f"不正なファイルパスです: {path}")


def python_symbol_spans(path: Path) -> list[SymbolSpan]:
    try:
        tree = ast.parse(read_text_file(path)[0])
    except (OSError, SyntaxError):
        return []
    spans: list[SymbolSpan] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            signature = ""
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                signature = ",".join(arg.arg for arg in node.args.args)
            first = node.decorator_list[0].lineno if node.decorator_list else node.lineno
            spans.append((node.name, signature, first, node.end_lineno or node.lineno))
    return spans


def csharp_symbol_spans(path: Path) -> list[SymbolSpan]:
    try:
        source, _ = read_text_file(path)
    except OSError:
        return []
    return [(symbol.name, symbol.signature, symbol.start, symbol.end) for symbol in scan_csharp_symbols(source)]


def candidate_files(root: Path, language: str, extra_roots: list[Path] | None = None) -> list[str]:
    suffix = ".py" if language == "python" else ".cs"
    entries, _ = list_repository_entries(root)
    results = [entry.path for entry in entries if entry.path.lower().endswith(suffix)]
    for extra in extra_roots or []:
        if extra.is_dir() and extra.resolve() != root.resolve():
            extra_entries, _ = list_repository_entries(extra)
            results.extend(f"{extra.name}/{entry.path}" for entry in extra_entries if entry.path.lower().endswith(suffix))
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
    symbols_by_file: dict[tuple[str, str], list[SymbolSpan]] = {}

    def language_files(language: str) -> list[str]:
        if language not in files_by_language:
            files_by_language[language] = candidate_files(root, language, extra_roots)
        return files_by_language[language]

    def file_symbols(language: str, relative: str) -> list[SymbolSpan]:
        key = (language, relative)
        if key not in symbols_by_file:
            path = safe_target(root, relative, extra_roots)
            symbols_by_file[key] = python_symbol_spans(path) if language == "python" else csharp_symbol_spans(path)
        return symbols_by_file[key]

    for change in changes:
        explicit = overrides.get(change.key) or change.path or target_path
        if explicit:
            change.path = explicit.replace("\\", "/")
            continue
        files = language_files(change.language)
        candidates = [
            rel for rel in files
            if any(name == change.symbol and (not change.signature or not signature or signature == change.signature)
                   for name, signature, _, _ in file_symbols(change.language, rel))
        ]
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
