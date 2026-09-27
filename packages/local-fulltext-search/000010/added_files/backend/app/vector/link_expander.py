"""
ノート間リンク（WikiLink・Markdownリンク）の再帰的展開モジュール。
仕様:
- 各Markdownファイル内の内部リンク（[[リンク先]] および [表示名](リンク先)）を解析・抽出する。
- 階層数 (depth) に応じて、リンク先ノートを再帰的にコンテキストへ取り込む。
- topタグを持つノートは初期階層数を 5、持たないノートは 1 とする。
- 循環リンク（A -> B -> A）や多重リンクを重複なく安全に解決し、無限ループを完全防止する。
"""

from __future__ import annotations

import os
import re
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple, Union

from app.extractors.obsidian_properties import has_obsidian_top_tag

# 画像・メールなど非Markdownメディア拡張子（リンク先ノート展開の対象外）
# ※ .excalidraw および .excalidraw.md は図面ノートファイルとして展開対象に含めるため、ここには含めない
NON_MARKDOWN_EXTENSIONS = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".tiff",
    ".pdf", ".msg", ".eml", ".zip", ".tar", ".gz", ".7z",
    ".mp3", ".wav", ".m4a", ".mp4", ".mov", ".avi", ".mkv",
})


def extract_markdown_links(content: str) -> List[str]:
    """
    Markdownテキスト内から内部リンク（WikiLink、Markdownリンク、Dataview/DataviewJS内参照、図面リンク）のリンク先文字列を抽出する。
    画像埋め込み、外部リンク、メール、アンカーリンクなどは除外する。
    """
    links: List[str] = []
    seen: Set[str] = set()

    def add_link(raw_target: str) -> None:
        if not raw_target:
            return
        cleaned = urllib.parse.unquote(raw_target.strip())
        if not cleaned:
            return
        if cleaned.startswith(("#", "mailto:", "data:", "javascript:")):
            return

        # 拡張子チェック（画像やPDFは除外、ただし .excalidraw や .excalidraw.md は許可）
        ext = Path(cleaned).suffix.lower()
        if ext in NON_MARKDOWN_EXTENSIONS:
            return

        if cleaned not in seen:
            seen.add(cleaned)
            links.append(cleaned)

    # 1. WikiLink: [[target#heading|alias]] or [[target|alias]] or [[target#heading]] or [[target]]
    wikilink_pattern = re.compile(r"(?<!!)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]")
    for match in wikilink_pattern.finditer(content):
        add_link(match.group(1))

    # 2. Excalidraw埋め込み: ![[target.excalidraw|...]] または ![[target.excalidraw.md]]
    excal_embed_pattern = re.compile(r"!\[\[([^\]|#]+\.excalidraw(?:\.md)?)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]")
    for match in excal_embed_pattern.finditer(content):
        add_link(match.group(1))

    # 3. 通常マークダウンリンク: [text](target)
    md_link_pattern = re.compile(r"(?<!!)\[([^\]]*)\]\(([^)]+)\)")
    for match in md_link_pattern.finditer(content):
        raw_url = match.group(2).strip()
        if not raw_url:
            continue

        # 外部リンクの場合: クエリパラメータに filepath= や path= があればローカルファイルパスとして抽出
        if raw_url.startswith(("http://", "https://")):
            try:
                parsed_url = urllib.parse.urlparse(raw_url)
                qs = urllib.parse.parse_qs(parsed_url.query)
                for qk in ("filepath", "path", "file"):
                    if qk in qs and qs[qk]:
                        val = qs[qk][0]
                        add_link(val)
            except Exception:
                pass
            continue

        url_path = raw_url.split("?")[0].split("#")[0].strip()
        add_link(url_path)

    # 4. Dataview / DataviewJS 内のノート抽出:
    # 4-1. JSON配列・オブジェクト: "path": "01_data/...", "file": "..."
    json_path_pattern = re.compile(r'["\'](?:path|file)["\']\s*:\s*["\']([^"\']+)["\']')
    for match in json_path_pattern.finditer(content):
        add_link(match.group(1))

    # 4-2. Dataview API: dv.page("..."), dv.pages("...")
    dv_page_pattern = re.compile(r'dv\.page(?:s)?\s*\(\s*["\']([^"\']+)["\']\s*\)')
    for match in dv_page_pattern.finditer(content):
        raw_p = match.group(1).strip().strip('"\'')
        add_link(raw_p)

    # 4-3. Dataview クエリ: FROM "..."
    dv_query_pattern = re.compile(r'FROM\s+["\']([^"\']+)["\']', re.IGNORECASE)
    for match in dv_query_pattern.finditer(content):
        add_link(match.group(1))

    return links


def find_obsidian_vault_root(start_path: Path) -> Optional[Path]:
    """
    指定されたファイルまたはディレクトリから親ディレクトリを遡り、
    .obsidian フォルダが存在するディレクトリ（Vaultルート）を探索する。
    """
    try:
        curr = start_path.resolve()
        if curr.is_file():
            curr = curr.parent
        while curr.parent != curr:
            if (curr / ".obsidian").is_dir():
                return curr
            curr = curr.parent
    except Exception:
        pass
    return None


def resolve_linked_note_file(
    base_dir: Path,
    target_link: str,
    vault_path: Optional[Path] = None,
) -> Optional[Path]:
    """
    リンク先文字列から、実在するMarkdownノートファイル（.md, .excalidraw.md）を特定して絶対Pathを返す。
    見つからない場合は None を返す。
    """
    clean = target_link.strip().replace("\\", "/")
    if not clean:
        return None

    # 絶対パスの直接判定
    try:
        p_direct = Path(clean)
        if p_direct.is_absolute():
            resolved = p_direct.resolve()
            if resolved.exists() and resolved.is_file():
                return resolved
            if not clean.lower().endswith(".md"):
                resolved_md = Path(clean + ".md").resolve()
                if resolved_md.exists() and resolved_md.is_file():
                    return resolved_md
            if clean.lower().endswith(".excalidraw"):
                resolved_ex = Path(clean + ".md").resolve()
                if resolved_ex.exists() and resolved_ex.is_file():
                    return resolved_ex
    except Exception:
        pass

    # 拡張子補完候補の生成
    candidates = [clean]
    if clean.lower().endswith(".excalidraw"):
        candidates.append(clean + ".md")
    elif not clean.lower().endswith(".md"):
        candidates.append(clean + ".md")
        candidates.append(clean + ".excalidraw.md")

    # 1. base_dir 基準
    for cand in candidates:
        try:
            p = (base_dir / cand).resolve()
            if p.exists() and p.is_file():
                return p
        except Exception:
            pass

    # 2. vault_path 基準 (未指定時は base_dir の祖先から .obsidian Vault ルートを自動検出)
    effective_vault = vault_path or find_obsidian_vault_root(base_dir)
    if effective_vault:
        for cand in candidates:
            try:
                p = (effective_vault / cand).resolve()
                if p.exists() and p.is_file():
                    return p
            except Exception:
                pass

        # 祖先ディレクトリ探索（最大10階層上まで）
        parent_v = effective_vault.parent
        for _ in range(10):
            for cand in candidates:
                try:
                    p = (parent_v / cand).resolve()
                    if p.exists() and p.is_file():
                        return p
                except Exception:
                    pass
            if parent_v.parent == parent_v:
                break
            parent_v = parent_v.parent

        # 3. 再帰探索（ファイル名完全一致）
        file_basename = Path(clean).name
        target_names = {file_basename}
        if file_basename.lower().endswith(".excalidraw"):
            target_names.add(file_basename + ".md")
        elif not file_basename.lower().endswith(".md"):
            target_names.add(file_basename + ".md")
            target_names.add(file_basename + ".excalidraw.md")

        for root, dirs, files in os.walk(effective_vault):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for f in files:
                if f in target_names:
                    p = Path(root) / f
                    if p.is_file():
                        return p

    return None


def get_default_link_depth(file_path: Union[str, Path]) -> int:
    """
    ノートの初期リンク展開階層数を決定する。
    topタグが含まれている場合は 5、それ以外は 1 とする。
    """
    p = Path(file_path)
    if not p.exists() or not p.is_file():
        return 1

    try:
        content = p.read_text(encoding="utf-8")
    except Exception:
        try:
            content = p.read_text(encoding="cp932", errors="replace")
        except Exception:
            return 1

    return 5 if has_obsidian_top_tag(content) else 1


def expand_linked_files(
    file_paths: List[Union[str, Path]],
    file_depths: Optional[Dict[str, int]] = None,
    vault_path: Union[str, Path] = "",
    excluded_paths: Optional[Union[List[str], Set[str]]] = None,
) -> Tuple[List[str], Dict[str, Any]]:
    """
    指定された複数Markdownノートを起点とし、各ノートごとに指定された階層数 (depth) まで
    リンク先ノートを再帰的に展開したファイルパス一覧とメタデータを返す。
    excluded_paths が指定された場合は、該当ファイルを展開結果から完全に除外する。

    戻り値:
        (expanded_file_paths, meta_stats)
    """
    vault_dir: Optional[Path] = None
    if vault_path and str(vault_path).strip():
        vault_dir = Path(vault_path).resolve()
    elif file_paths:
        try:
            first_path = Path(file_paths[0]).resolve()
            detected_vault = find_obsidian_vault_root(first_path)
            if detected_vault:
                vault_dir = detected_vault
            else:
                common = os.path.commonpath([str(Path(f).resolve().parent) for f in file_paths])
                vault_dir = Path(common).resolve()
        except Exception:
            vault_dir = Path(file_paths[0]).resolve().parent

    file_depths_map = file_depths or {}

    excluded_canonical: Set[str] = set()
    if excluded_paths:
        for ep in excluded_paths:
            try:
                excluded_canonical.add(str(Path(ep).resolve()))
            except Exception:
                pass

    expanded_paths: List[str] = []
    seen_canonical_paths: Set[str] = set()
    nodes: List[Dict[str, Any]] = []

    root_files_count = 0
    linked_files_count = 0
    depths_applied: Dict[str, int] = {}

    for root_p in file_paths:
        path_obj = Path(root_p).resolve()
        if not path_obj.exists() or not path_obj.is_file():
            continue

        canon_root = str(path_obj)
        if canon_root in excluded_canonical:
            continue

        root_files_count += 1

        # ルートファイルの内容を読み込み
        try:
            root_content = path_obj.read_text(encoding="utf-8")
        except Exception:
            try:
                root_content = path_obj.read_text(encoding="cp932", errors="replace")
            except Exception:
                root_content = ""
        root_has_top = has_obsidian_top_tag(root_content)

        # ルートファイル自身を順序通りに追加
        if canon_root not in seen_canonical_paths:
            seen_canonical_paths.add(canon_root)
            expanded_paths.append(canon_root)
            nodes.append({
                "full_path": canon_root,
                "file_name": path_obj.name,
                "depth_level": 0,
                "root_path": canon_root,
                "parent_path": None,
                "parent_name": None,
                "has_top_tag": root_has_top,
            })

        # 階層数判定（指定があればそれを使用、なければデフォルト判定）
        depth = file_depths_map.get(str(root_p))
        if depth is None:
            depth = file_depths_map.get(canon_root)
        if depth is None:
            depth = 5 if root_has_top else 1

        depths_applied[canon_root] = depth
        if depth <= 0:
            continue

        # 幅優先探索 (BFS) でリンク先を探索
        # queue: [(current_file_path, current_depth)]
        queue: List[Tuple[Path, int]] = [(path_obj, 0)]
        visited_in_this_chain: Set[str] = {canon_root}

        while queue:
            curr_file, curr_d = queue.pop(0)
            if curr_d >= depth:
                continue

            try:
                curr_content = curr_file.read_text(encoding="utf-8")
            except Exception:
                try:
                    curr_content = curr_file.read_text(encoding="cp932", errors="replace")
                except Exception:
                    curr_content = ""

            links = extract_markdown_links(curr_content)
            for link_str in links:
                resolved_p = resolve_linked_note_file(
                    base_dir=curr_file.parent,
                    target_link=link_str,
                    vault_path=vault_dir,
                )
                if resolved_p is None:
                    continue

                canon_resolved = str(resolved_p.resolve())
                if canon_resolved in excluded_canonical:
                    continue
                if canon_resolved in visited_in_this_chain:
                    continue
                visited_in_this_chain.add(canon_resolved)

                # 全体の展開結果に追加
                if canon_resolved not in seen_canonical_paths:
                    try:
                        sub_content = resolved_p.read_text(encoding="utf-8")
                    except Exception:
                        try:
                            sub_content = resolved_p.read_text(encoding="cp932", errors="replace")
                        except Exception:
                            sub_content = ""
                    sub_has_top = has_obsidian_top_tag(sub_content)

                    seen_canonical_paths.add(canon_resolved)
                    expanded_paths.append(canon_resolved)
                    linked_files_count += 1
                    nodes.append({
                        "full_path": canon_resolved,
                        "file_name": resolved_p.name,
                        "depth_level": curr_d + 1,
                        "root_path": canon_root,
                        "parent_path": str(curr_file.resolve()),
                        "parent_name": curr_file.name,
                        "has_top_tag": sub_has_top,
                    })

                # 次の階層の探索キューに追加
                if curr_d + 1 < depth:
                    queue.append((resolved_p, curr_d + 1))

    meta = {
        "total_root_files": root_files_count,
        "total_linked_files": linked_files_count,
        "total_expanded_files": len(expanded_paths),
        "depths_applied": depths_applied,
        "nodes": nodes,
    }

    return expanded_paths, meta
