"""
参照リポジトリ解決および同一リポジトリ内依存モジュール検出モジュール (references.py)

仕様:
1. 現在選択されているファイルから呼び出されている同一リポジトリ内のモジュールを再帰的に検出（discover_internal_modules）。
2. コード内の sys.path.append() / sys.path.insert() からディレクトリを静的解析し、外部ライブラリ検索パスに追加（extract_sys_path_entries）。
3. PYTHONPATH および sys.path 追加先から、pip（site-packages）を除外した外部Gitリポジトリの参照モジュールを自動検出（discover_reference_modules）。
4. C# の ProjectReference / using / 型参照の解析に対応。
"""

from __future__ import annotations

import ast
import json
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import deque
from functools import lru_cache
from pathlib import Path
from typing import Iterable

from .csharp_symbols import CS_NAMESPACE_RE
from .pyenv import executable_dir_name, executable_name, find_venv_python
from .repository import RepoEntry, entries_to_tree, read_text_file


SOURCE_SUFFIXES = {".py", ".cs"}
IGNORED_PARTS = {".git", "__pycache__", ".pytest_cache", ".venv", "venv", "bin", "obj", "build", "dist", "node_modules"}
CS_TYPE_RE = re.compile(r"\b(?:class|interface|struct|record|enum)\s+([A-Za-z_]\w*)")
CS_USING_RE = re.compile(
    r"^\s*(?:global\s+)?using\s+(?:static\s+)?(?:(?:[A-Za-z_]\w*)\s*=\s*)?"
    r"([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*;",
    re.MULTILINE,
)
CS_IDENTIFIER_RE = re.compile(r"\b[A-Za-z_]\w*\b")
SYS_PATH_CALL_RE = re.compile(r"\.path\s*\.\s*(?:append|insert)\s*\(")
SLN_PROJECT_RE = re.compile(r'^Project\("[^"]+"\)\s*=\s*"[^"]+",\s*"([^"]+\.csproj)"', re.MULTILINE | re.IGNORECASE)


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _git_root(path: Path) -> Path | None:
    current = path.resolve() if path.is_dir() else path.resolve().parent
    for candidate in (current, *current.parents):
        if (candidate / ".git").exists():
            return candidate
    try:
        result = subprocess.run(
            ["git", "-C", str(current), "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return Path(result.stdout.strip()).resolve()
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def _python_executable(root: Path) -> Path | None:
    venv_python = find_venv_python(root)
    candidates = [venv_python] if venv_python else []
    virtual_env = os.environ.get("VIRTUAL_ENV", "").strip()
    if virtual_env:
        candidates.append(Path(virtual_env) / executable_dir_name() / executable_name())
    for candidate in candidates:
        if candidate.is_file():
            # Invoking a venv through its own symlink is what makes Python set
            # sys.prefix and site-packages correctly; resolving it would escape
            # the environment and run the base interpreter instead.
            return Path(os.path.abspath(candidate))
    found = shutil.which("python") or shutil.which("python3")
    return Path(os.path.abspath(found)) if found else None


@lru_cache(maxsize=32)
def _python_environment_cached(
    root_value: str,
    pythonpath_value: str,
    _virtual_env_value: str,
    executable_value: str,
    _environment_stamp: int,
) -> tuple[tuple[Path, ...], frozenset[str], tuple[Path, ...]]:
    """Cache interpreter discovery while users toggle many source files."""
    root = Path(root_value)
    import_roots: list[Path] = []
    for raw in pythonpath_value.split(os.pathsep):
        if raw.strip() and Path(raw).expanduser().is_dir():
            import_roots.append(Path(raw).expanduser().resolve())

    stdlib_names = set(getattr(sys, "stdlib_module_names", set()))
    prefixes: list[Path] = []
    executable = Path(executable_value) if executable_value else None
    if executable:
        script = (
            "import json,sys;"
            "print(json.dumps({'paths':sys.path,'prefix':sys.prefix,'base_prefix':sys.base_prefix,"
            "'stdlib':sorted(getattr(sys,'stdlib_module_names',()))}))"
        )
        try:
            result = subprocess.run(
                [str(executable), "-c", script], cwd=root, capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=10,
            )
            data = json.loads(result.stdout) if result.returncode == 0 else {}
            for raw in data.get("paths", []):
                candidate = Path(raw or root).expanduser()
                if candidate.is_dir():
                    import_roots.append(candidate.resolve())
            for raw in (data.get("prefix"), data.get("base_prefix")):
                if raw:
                    prefixes.append(Path(raw).resolve())
            stdlib_names.update(str(item) for item in data.get("stdlib", []))
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            pass

    import_roots = [root, root / "src", *import_roots]
    unique_roots = list(dict.fromkeys(path.resolve() for path in import_roots if path.is_dir()))
    return tuple(unique_roots), frozenset(stdlib_names), tuple(dict.fromkeys(prefixes))


def _python_environment(root: Path) -> tuple[list[Path], set[str], list[Path]]:
    """Return import roots, stdlib names and Python installation prefixes."""
    root = root.resolve()
    executable = _python_executable(root)
    environment_stamp = 0
    if executable:
        environment_root = executable.parent.parent
        stamp_candidates = [environment_root / "pyvenv.cfg", environment_root / "Lib" / "site-packages"]
        stamp_candidates.extend((environment_root / "lib").glob("python*/site-packages") if (environment_root / "lib").is_dir() else [])
        for candidate in stamp_candidates:
            try:
                environment_stamp = max(environment_stamp, candidate.stat().st_mtime_ns)
            except OSError:
                continue
    roots, names, prefixes = _python_environment_cached(
        str(root),
        os.environ.get("PYTHONPATH", ""),
        os.environ.get("VIRTUAL_ENV", ""),
        str(executable or ""),
        environment_stamp,
    )
    return list(roots), set(names), list(prefixes)


def _module_candidates(module: str, import_roots: Iterable[Path]) -> list[tuple[Path, Path]]:
    parts = [part for part in module.split(".") if part]
    if not parts:
        return []
    matches: list[tuple[Path, Path]] = []
    for import_root in import_roots:
        base = import_root.joinpath(*parts)
        for candidate in (base.with_suffix(".py"), base / "__init__.py"):
            if candidate.is_file():
                matches.append((candidate.resolve(), import_root.resolve()))
    return matches


def _installed_python_path(path: Path, prefixes: Iterable[Path]) -> bool:
    lowered = {part.lower() for part in path.parts}
    if "site-packages" in lowered or "dist-packages" in lowered:
        return True
    return any(_inside(path, prefix) for prefix in prefixes)


def _python_imports(path: Path, module_name: str = "") -> list[str]:
    try:
        tree = ast.parse(read_text_file(path)[0])
    except (OSError, SyntaxError):
        return []

    used_names = {
        node.id for node in ast.walk(tree)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
    }
    results: list[str] = []
    package = module_name.rpartition(".")[0]
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                bound = alias.asname or alias.name.split(".")[0]
                if bound in used_names and alias.name not in results:
                    results.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                package_parts = package.split(".") if package else []
                keep = max(0, len(package_parts) - node.level + 1)
                base = ".".join([*package_parts[:keep], *([base] if base else [])]).strip(".")
            for alias in node.names:
                bound = alias.asname or alias.name
                if alias.name == "*" or bound not in used_names:
                    continue
                child = f"{base}.{alias.name}".strip(".")
                if child and child not in results:
                    results.append(child)
    return results


def _module_name_for(path: Path, import_root: Path) -> str:
    try:
        relative = path.relative_to(import_root)
    except ValueError:
        return path.stem
    parts = list(relative.with_suffix("").parts)
    if parts and parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def _eval_path_expr(node: ast.AST, base_dir: Path) -> Path | None:
    """ASTノードからパス表現を評価・抽出する。"""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        val = node.value.strip()
        if not val:
            return None
        p = Path(val)
        return p.resolve() if p.is_absolute() else (base_dir / p).resolve()
    if isinstance(node, ast.Call):
        if isinstance(node.func, ast.Name) and node.func.id == "str" and node.args:
            return _eval_path_expr(node.args[0], base_dir)
        if isinstance(node.func, ast.Attribute) and node.func.attr == "join":
            parts = []
            for arg in node.args:
                sub = _eval_path_expr(arg, base_dir)
                if sub is not None:
                    parts.append(str(sub))
                elif isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    parts.append(arg.value)
            if parts:
                p = Path(os.path.join(*parts))
                return p.resolve() if p.is_absolute() else (base_dir / p).resolve()
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
        left = _eval_path_expr(node.left, base_dir)
        if left is not None and isinstance(node.right, ast.Constant) and isinstance(node.right.value, str):
            return (left / node.right.value).resolve()
    if isinstance(node, ast.Attribute) and node.attr == "parent":
        sub = _eval_path_expr(node.value, base_dir)
        if sub is not None:
            return sub.parent
        return base_dir
    if isinstance(node, ast.Name) and node.id == "__file__":
        return base_dir / "__file__"
    return None


def extract_sys_path_entries(root: Path, paths: Iterable[Path]) -> list[Path]:
    """コード内の sys.path.append() / sys.path.insert() からディレクトリを抽出する。"""
    found: list[Path] = []
    for path in paths:
        if not path.is_file() or path.suffix.lower() != ".py":
            continue
        try:
            source = read_text_file(path)[0]
        except OSError:
            continue
        if not SYS_PATH_CALL_RE.search(source):
            continue  # sys.path.append/insert を含まないファイルはAST解析を省く
        try:
            tree = ast.parse(source)
        except SyntaxError:
            continue
        base_dir = path.parent.resolve()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Attribute):
                if node.func.value.attr == "path":
                    target_arg = None
                    if node.func.attr == "append" and node.args:
                        target_arg = node.args[0]
                    elif node.func.attr == "insert" and len(node.args) >= 2:
                        target_arg = node.args[1]
                    if target_arg is not None:
                        resolved = _eval_path_expr(target_arg, base_dir)
                        if resolved is not None:
                            found.append(resolved)
    return list(dict.fromkeys(found))


def discover_internal_modules(root: Path, selected_files: list[str]) -> list[str]:
    """現在選択されているファイルから呼び出されている同一リポジトリ内のモジュールを再帰的に検出する。"""
    root = root.resolve()
    internal_files: set[str] = set()
    queue: deque[Path] = deque()

    for rel in selected_files:
        full = (root / rel).resolve()
        if full.is_file() and _inside(full, root):
            queue.append(full)

    visited: set[Path] = set(queue)
    search_roots = [root, root / "src"]
    search_roots = [d for d in search_roots if d.is_dir()]

    while queue:
        current = queue.popleft()
        if current.suffix.lower() == ".py":
            current_dir = current.parent
            current_roots = list(dict.fromkeys([current_dir, *search_roots]))
            mod_name = _module_name_for(current, root / "src" if _inside(current, root / "src") else root)
            imported_modules = _python_imports(current, mod_name)
            for module in imported_modules:
                matches = _module_candidates(module, current_roots)
                if not matches and "." in module:
                    parent_mod = module.rpartition(".")[0]
                    matches = _module_candidates(parent_mod, current_roots)
                for candidate_path, _ in matches:
                    if _inside(candidate_path, root):
                        rel = str(candidate_path.relative_to(root)).replace("\\", "/")
                        internal_files.add(rel)
                        if candidate_path not in visited:
                            visited.add(candidate_path)
                            queue.append(candidate_path)
        elif current.suffix.lower() == ".cs":
            main_projects = [p for p in root.rglob("*.csproj") if not any(part in IGNORED_PARTS for part in p.relative_to(root).parts)]
            matching = _matching_csharp_files([current], main_projects or [root / "__main__.csproj"])
            for matched_set in matching.values():
                for candidate_path in matched_set:
                    if _inside(candidate_path, root):
                        rel = str(candidate_path.relative_to(root)).replace("\\", "/")
                        internal_files.add(rel)
                        if candidate_path not in visited:
                            visited.add(candidate_path)
                            queue.append(candidate_path)

    return sorted(internal_files)


def _source_entries(paths: Iterable[str], root: Path) -> list[dict]:
    entries = []
    for relative in sorted(set(paths)):
        full = root / relative
        if full.is_file() and full.suffix.lower() in SOURCE_SUFFIXES:
            entries.append(RepoEntry(relative, size=full.stat().st_size))
    return entries_to_tree(entries)


def _repository_record(root: Path, files: set[str], reason: str = "auto") -> dict:
    return {
        "path": str(root),
        "name": root.name,
        "files": sorted(files),
        "tree": _source_entries(files, root),
        "reason": reason,
        "read_only": True,
    }


def _expand_msbuild_path(value: str) -> str:
    def replace(match: re.Match[str]) -> str:
        return os.environ.get(match.group(1), match.group(0))
    expanded = re.sub(r"\$\(([^)]+)\)", replace, value)
    return os.path.expandvars(expanded.replace("\\", os.sep))


def _project_references(project: Path) -> list[Path]:
    try:
        tree = ET.parse(project)
    except (OSError, ET.ParseError):
        return []
    references: list[Path] = []
    for element in tree.iter():
        if element.tag.rsplit("}", 1)[-1] != "ProjectReference":
            continue
        include = _expand_msbuild_path(element.attrib.get("Include", "")).strip()
        if include:
            candidate = (project.parent / include).resolve()
            if candidate.is_file():
                references.append(candidate)
    return references


def _solution_projects(root: Path) -> list[Path]:
    projects: list[Path] = []
    for solution in root.rglob("*.sln"):
        if any(part in IGNORED_PARTS for part in solution.relative_to(root).parts):
            continue
        try:
            source = read_text_file(solution)[0]
        except OSError:
            continue
        for raw in SLN_PROJECT_RE.findall(source):
            candidate = (solution.parent / raw.replace("\\", os.sep)).resolve()
            if candidate.is_file():
                projects.append(candidate)
    return list(dict.fromkeys(projects))


def _csharp_files(project: Path) -> tuple[Path, ...]:
    # Do not cache the directory walk across requests: adding a file inside a
    # nested directory does not reliably update the project file timestamp.
    return tuple(
        path.resolve() for path in project.parent.rglob("*.cs")
        if not any(part in IGNORED_PARTS for part in path.relative_to(project.parent).parts)
    )


@lru_cache(maxsize=4096)
def _csharp_metadata_cached(path_value: str, mtime_ns: int, size: int) -> tuple[str, frozenset[str], str]:
    path = Path(path_value)
    try:
        source = read_text_file(path)[0]
    except OSError:
        return "", frozenset(), ""
    namespace_match = CS_NAMESPACE_RE.search(source)
    return namespace_match.group(1) if namespace_match else "", frozenset(CS_TYPE_RE.findall(source)), source


def _csharp_metadata(path: Path) -> tuple[str, frozenset[str], str]:
    try:
        stat = path.stat()
    except OSError:
        return "", frozenset(), ""
    return _csharp_metadata_cached(str(path.resolve()), stat.st_mtime_ns, stat.st_size)


def _matching_csharp_files(source_paths: Iterable[Path], candidate_projects: Iterable[Path]) -> dict[Path, set[Path]]:
    usages: list[tuple[str, set[str], set[str], str]] = []
    for source_path in source_paths:
        source_namespace, _, source = _csharp_metadata(source_path)
        usages.append((source_namespace, set(CS_USING_RE.findall(source)), set(CS_IDENTIFIER_RE.findall(source)), source))

    result: dict[Path, set[Path]] = {}
    for project in candidate_projects:
        for candidate in _csharp_files(project):
            namespace, types, _ = _csharp_metadata(candidate)
            if not types:
                continue
            if any(
                bool(types & identifiers)
                and (
                    not namespace or namespace == source_namespace or namespace in usings
                    or any(f"{namespace}.{type_name}" in source for type_name in types)
                )
                for source_namespace, usings, identifiers, source in usages
            ):
                result.setdefault(project, set()).add(candidate)
    return result


def _discover_csharp(root: Path, selected_files: list[str], manual_references: dict[str, str]) -> tuple[dict[Path, set[str]], list[dict]]:
    selected_paths = [root / relative for relative in selected_files if Path(relative).suffix.lower() == ".cs" and (root / relative).is_file()]
    if not selected_paths:
        return {}, []
    main_projects = [project for project in root.rglob("*.csproj") if not any(part in IGNORED_PARTS for part in project.relative_to(root).parts)]
    candidates = list(main_projects)
    candidates.extend(reference for project in main_projects for reference in _project_references(project))
    candidates.extend(project for project in _solution_projects(root) if not _inside(project, root))
    for raw_path in manual_references.values():
        manual_root = Path(raw_path).expanduser()
        if manual_root.is_dir():
            manual_projects = list(manual_root.rglob("*.csproj"))
            candidates.extend(manual_projects or [manual_root / "__manual__.csproj"])
    candidates = list(dict.fromkeys(candidates))
    repositories: dict[Path, set[str]] = {}
    unresolved: list[dict] = []
    queue: deque[tuple[list[Path], list[Path]]] = deque([(selected_paths, candidates)])
    processed_sources: dict[Path, set[Path]] = {}
    while queue:
        sources, projects = queue.popleft()
        for project in projects:
            project = project.resolve()
            already_processed = processed_sources.setdefault(project, set())
            new_sources = {path.resolve() for path in sources} - already_processed
            if not new_sources:
                continue
            already_processed.update(new_sources)
            matched_files: set[Path] = set()
            frontier = new_sources
            # Resolve dependencies inside the same project before following its
            # ProjectReferences. This also makes cyclic project graphs finite.
            while frontier:
                matches = _matching_csharp_files(frontier, [project]).get(project, set())
                matches -= already_processed
                if not matches:
                    break
                matched_files.update(matches)
                already_processed.update(matches)
                frontier = matches
            if not matched_files:
                continue
            repo_root = _git_root(project) or project.parent.resolve()
            if repo_root != root.resolve():
                relative_files = {str(path.relative_to(repo_root)).replace("\\", "/") for path in matched_files if _inside(path, repo_root)}
                repositories.setdefault(repo_root, set()).update(relative_files)
            child_projects = _project_references(project)
            if child_projects:
                queue.append((list(matched_files), child_projects))

    main_source = "\n".join(_csharp_metadata(path)[2] for path in selected_paths)
    matched_namespaces = {
        namespace for repo_root, files in repositories.items() for relative in files
        for namespace, _, _ in [_csharp_metadata(repo_root / relative)] if namespace
    }
    for namespace in sorted(set(CS_USING_RE.findall(main_source)) - matched_namespaces):
        if not namespace.startswith(("System", "Microsoft")):
            unresolved.append({"language": "csharp", "module": namespace, "source_files": [str(path.relative_to(root)).replace("\\", "/") for path in selected_paths]})
    return repositories, unresolved


def discover_reference_modules(
    root: Path,
    selected_files: list[str],
    python_mode: str = "normal",
    manual_references: dict[str, str] | None = None,
) -> dict:
    """Find only source files actually referenced by selected main-repository modules."""
    if python_mode == "embedded":
        return {"enabled": False, "repositories": [], "unresolved": [], "warnings": []}

    root = root.resolve()
    manual_references = manual_references or {}
    import_roots, stdlib_names, prefixes = _python_environment(root)
    python_selected = [relative for relative in selected_files if Path(relative).suffix.lower() == ".py" and (root / relative).is_file()]
    sys_path_entries = extract_sys_path_entries(root, [root / r for r in python_selected])
    for entry in sys_path_entries:
        if entry.is_dir() and entry not in import_roots:
            import_roots.append(entry)
    pending: deque[tuple[str, str, Path | None]] = deque()
    for relative in python_selected:
        source_path = root / relative
        module_name = _module_name_for(source_path, root / "src" if _inside(source_path, root / "src") else root)
        pending.extend((module, relative, None) for module in _python_imports(source_path, module_name))

    repositories: dict[Path, set[str]] = {}
    repository_reason: dict[Path, str] = {}
    unresolved: dict[tuple[str, str], set[str]] = {}
    visited_modules: set[tuple[str, str]] = set()
    unresolved_visits: dict[tuple[str, str], tuple[str, str]] = {}
    while pending:
        module, source_relative, current_repo = pending.popleft()
        top_level = module.split(".", 1)[0]
        if not module or top_level in stdlib_names:
            continue
        visit_key = (str(current_repo or root), module)
        if visit_key in visited_modules:
            unresolved_key = unresolved_visits.get(visit_key)
            if unresolved_key:
                unresolved.setdefault(unresolved_key, set()).add(source_relative)
            continue
        visited_modules.add(visit_key)

        search_roots = list(import_roots)
        if current_repo:
            search_roots = [current_repo, current_repo / "src", *search_roots]
        manual_path = manual_references.get(module) or manual_references.get(top_level)
        if manual_path and Path(manual_path).expanduser().is_dir():
            manual_root = Path(manual_path).expanduser().resolve()
            search_roots = [manual_root, manual_root / "src", *search_roots]

        matches = _module_candidates(module, search_roots)
        if not matches and "." in module:
            parent_module = module.rpartition(".")[0]
            matches = _module_candidates(parent_module, search_roots)
            if matches:
                module = parent_module
        if not matches:
            unresolved_key = ("python", module)
            unresolved.setdefault(unresolved_key, set()).add(source_relative)
            unresolved_visits[visit_key] = unresolved_key
            continue

        source_path, import_root = matches[0]
        if _inside(source_path, root):
            continue
        if _installed_python_path(source_path, prefixes):
            continue
        repo_root = _git_root(source_path)
        if repo_root is None:
            unresolved_key = ("python", module)
            unresolved.setdefault(unresolved_key, set()).add(source_relative)
            unresolved_visits[visit_key] = unresolved_key
            continue
        if repo_root == root:
            continue
        relative = str(source_path.relative_to(repo_root)).replace("\\", "/")
        repositories.setdefault(repo_root, set()).add(relative)
        repository_reason[repo_root] = "manual" if manual_path else "environment"
        resolved_module = _module_name_for(source_path, import_root)
        for child in _python_imports(source_path, resolved_module):
            pending.append((child, relative, repo_root))

    csharp_repositories, csharp_unresolved = _discover_csharp(root, selected_files, manual_references)
    for repo_root, files in csharp_repositories.items():
        repositories.setdefault(repo_root, set()).update(files)
        repository_reason.setdefault(repo_root, "project-reference")

    unresolved_items = [
        {"language": language, "module": module, "source_files": sorted(source_files)}
        for (language, module), source_files in sorted(unresolved.items())
    ]
    unresolved_items.extend(csharp_unresolved)
    records = [_repository_record(repo_root, files, repository_reason.get(repo_root, "auto")) for repo_root, files in sorted(repositories.items(), key=lambda item: str(item[0]).lower())]
    return {
        "enabled": True,
        "repositories": records,
        "unresolved": unresolved_items,
        "manual_references": manual_references,
        "warnings": [],
    }
