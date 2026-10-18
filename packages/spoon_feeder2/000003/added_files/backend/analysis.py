"""Lightweight Python and C# dependency analysis for the graph page."""

from __future__ import annotations

import ast
import re
from collections import defaultdict
from pathlib import Path

from .csharp_symbols import CS_NAMESPACE_RE
from .repository import list_repository_entries, read_text_file


CS_TYPE_RE = re.compile(r"\b(class|interface|struct|record|enum)\s+([A-Za-z_]\w*)")
CS_METHOD_RE = re.compile(r"\b(?:public|private|protected|internal|static|virtual|override|async|sealed|partial|new)\s+[\w<>,.?\[\]\s]+\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:\{|=>)")
CS_USING_RE = re.compile(r"^\s*using\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*;", re.MULTILINE)
CS_CALL_RE = re.compile(r"\b([A-Za-z_]\w*)\s*\(")


def build_dependency_map(root: Path) -> dict:
    entries, _ = list_repository_entries(root)
    source_paths = [e.path for e in entries if Path(e.path).suffix.lower() in {".py", ".cs"}]
    nodes: list[dict] = []
    edges: list[dict] = []
    symbols: dict[str, list[str]] = {}
    module_files: dict[str, str] = {}
    parsed: dict[str, tuple[str, object]] = {}
    # ファイルごとのシンボルノード索引（ノード全件の走査を避ける）
    owners_by_file_label: dict[tuple[str, str], list[str]] = defaultdict(list)
    functions_by_file: dict[str, list[str]] = defaultdict(list)

    def add_node(identifier: str, label: str, kind: str, parent: str = "") -> None:
        nodes.append({"id": identifier, "label": label, "type": kind, "parent": parent})
        if parent:
            edges.append({"source": parent, "target": identifier, "type": "contains"})
        symbols.setdefault(label, []).append(identifier)
        if ":" in identifier:  # ファイル配下のシンボル（ファイルノード自身は含めない）
            file_path = identifier.split(":", 1)[0]
            owners_by_file_label[(file_path, label)].append(identifier)
            if kind == "function":
                functions_by_file[file_path].append(identifier)

    for rel in source_paths:
        path = root / rel
        source = read_text_file(path)[0]
        add_node(rel, Path(rel).name, "file")
        if rel.endswith(".py"):
            module = rel[:-3].replace("/", ".").removesuffix(".__init__")
            module_files[module] = rel
            try:
                tree = ast.parse(source)
            except SyntaxError:
                parsed[rel] = (source, None)
                continue
            parsed[rel] = (source, tree)
            for item in tree.body:
                if isinstance(item, ast.ClassDef):
                    class_id = f"{rel}:{item.name}"
                    add_node(class_id, item.name, "class", rel)
                    for child in item.body:
                        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            add_node(f"{class_id}:{child.name}", child.name, "function", class_id)
                elif isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    add_node(f"{rel}:{item.name}", item.name, "function", rel)
        else:
            namespace_match = CS_NAMESPACE_RE.search(source)
            module_files[namespace_match.group(1) if namespace_match else Path(rel).stem] = rel
            parsed[rel] = (source, None)
            types = list(CS_TYPE_RE.finditer(source))
            for index, match in enumerate(types):
                type_id = f"{rel}:{match.group(2)}"
                add_node(type_id, match.group(2), "class", rel)
                boundary = types[index + 1].start() if index + 1 < len(types) else len(source)
                for method in CS_METHOD_RE.finditer(source, match.end(), boundary):
                    add_node(f"{type_id}:{method.group(1)}", method.group(1), "function", type_id)

    edge_keys = {(e["source"], e["target"], e["type"]) for e in edges}

    def edge(source: str, target: str, kind: str) -> None:
        key = (source, target, kind)
        if source != target and key not in edge_keys:
            edges.append({"source": source, "target": target, "type": kind})
            edge_keys.add(key)

    def called_name(node: ast.AST) -> str:
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                return node.func.id
            if isinstance(node.func, ast.Attribute):
                return node.func.attr
        return ""

    for rel, (source, tree) in parsed.items():
        if rel.endswith(".py") and tree is not None:
            for item in ast.walk(tree):
                if isinstance(item, ast.Import):
                    for alias in item.names:
                        target = module_files.get(alias.name)
                        if target:
                            edge(rel, target, "import")
                elif isinstance(item, ast.ImportFrom) and item.module:
                    target = module_files.get(item.module)
                    if target:
                        edge(rel, target, "import")
            for item in ast.walk(tree):
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    owners = owners_by_file_label.get((rel, item.name), [])
                    if not owners:
                        continue
                    for called in ast.walk(item):
                        targets = symbols.get(called_name(called), [])
                        if len(targets) == 1:
                            edge(owners[0], targets[0], "calls")
        elif rel.endswith(".cs"):
            for namespace in CS_USING_RE.findall(source):
                target = module_files.get(namespace)
                if target:
                    edge(rel, target, "import")
            called_names = CS_CALL_RE.findall(source)  # 呼び出し名の抽出はファイルごとに1回
            for owner_id in functions_by_file.get(rel, []):
                for name in called_names:
                    targets = [target for target in symbols.get(name, []) if target != owner_id]
                    if len(targets) == 1:
                        edge(owner_id, targets[0], "calls")

    return {"nodes": nodes, "edges": edges}
