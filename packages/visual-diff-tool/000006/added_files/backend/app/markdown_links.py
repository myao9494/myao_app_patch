"""
Obsidian Markdown を起点にした関連ファイルの収集。
- `![[画像]]`・`[[ノート]]`・相対Markdownリンク・URLの filepath= 等・CADコードブロック（```step / cad / 3d）の
  path: 指定を再帰的にたどる（作業ツリーとHEADの両方の本文を読む）
- ファイル名だけのショートリンクは Vault ルート → 追跡ファイル → 未追跡ファイル → ファイルシステム走査 の順で解決
- Vault ルートは設定の obsidian_folder → 親方向の `.obsidian` → リポジトリ自身 の順で決める
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from fastapi import HTTPException

from .file_utils import read_file_limited
from .git_repo import GitBlobBatch, git_output
from .settings_store import load_server_settings
from .text_diff import MAX_TEXT_BYTES, decode_git_text

WIKI_LINK_RE = re.compile(r"!?\[\[([^\]]+)\]\]")
MARKDOWN_LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
CAD_CODEBLOCK_RE = re.compile(r"```(?:step|cad|3d|step-viewer|stp)\b([\s\S]*?)```", re.IGNORECASE)
CAD_PATH_PROPERTY_RE = re.compile(r"^\s*(?:path|file|source|model)\s*:\s*([^\r\n#]+)", re.IGNORECASE | re.MULTILINE)
STEP_PROPERTY_RE = re.compile(r"^\s*(?:path|file|source|model|cad|step)\s*:\s*([^\r\n#]+\.(?:step|stp))\b", re.IGNORECASE | re.MULTILINE)
MAX_OBSIDIAN_LINKS = 500
COMMON_IMAGE_SUFFIXES = [
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".svg",
    ".excalidraw",
    ".excalidraw.md",
    ".pdf",
    ".gif",
    ".bmp",
    ".step",
    ".stp",
]


def related_paths_for_markdown(repo: Path, source_markdown: str) -> set[str]:
    source_path = Path(source_markdown).resolve()
    try:
        source_rel = source_path.relative_to(repo).as_posix()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Markdown file must be inside the git repository") from exc
    return related_markdown_paths(repo, source_rel)


def find_vault_root(repo: Path, source_rel: str) -> Path:
    """Markdownファイルに対するObsidian Vaultルートを判定する。
    1. 設定の obsidian_folder が有効で、repo と親子または同一であればそれを優先。
    2. なければ、Markdownファイルから親ディレクトリを遡って .obsidian を持つフォルダを探す。
    3. 見つからない場合は、Gitリポジトリ（repo）自身を Vault ルートとして扱う。
    """
    settings = load_server_settings()
    configured_vault = str(settings.get("obsidian_folder") or "").strip()
    if configured_vault:
        candidate = Path(configured_vault).expanduser()
        if candidate.is_dir():
            try:
                candidate = candidate.resolve()
                if candidate == repo or candidate in repo.parents or repo in candidate.parents:
                    return candidate
            except OSError:
                pass

    # Markdownファイルの親から遡って .obsidian を探索
    start_dir = (repo / source_rel).resolve().parent
    current = start_dir
    while True:
        if (current / ".obsidian").is_dir():
            return current
        if current == repo or current.parent == current:
            break
        current = current.parent

    # .obsidian が見つからない場合はリポジトリ自身を Vault ルートとして扱う
    return repo


def related_markdown_paths(repo: Path, source_rel: str) -> set[str]:
    vault_root = find_vault_root(repo, source_rel)

    # Git追跡ファイル一覧を取得（日本語ファイル名対応・削除ファイルも検出可能）
    tracked_files: list[str] = []
    try:
        raw_tracked = git_output(["ls-files"], repo)
        tracked_files = [line.strip() for line in raw_tracked.splitlines() if line.strip()]
    except Exception:
        tracked_files = []
    # ファイル名→パスの索引は1リクエストにつき1回だけ構築し、全リンクで共有する。
    link_index = LinkIndex(repo, tracked_files)

    related: set[str] = set()
    pending = [source_rel]
    # HEAD側の読み出しは常駐プロセス1つに集約する（ノートごとの git 起動を排除）。
    with GitBlobBatch(repo) as head_reader:
        while pending and len(related) < MAX_OBSIDIAN_LINKS:
            current_rel = pending.pop(0)
            if current_rel in related:
                continue
            related.add(current_rel)
            current_path = repo / current_rel
            contents: list[bytes] = []
            if current_path.is_file():
                contents.append(read_file_limited(current_path, MAX_TEXT_BYTES, current_rel))
            head_content = head_reader.read(current_rel, MAX_TEXT_BYTES)
            if head_content is not None:
                contents.append(head_content)
            for content in contents:
                try:
                    text, _ = decode_git_text(content)
                except HTTPException:
                    continue
                for target in extract_markdown_links(text):
                    resolved = resolve_obsidian_link(
                        repo,
                        current_rel,
                        target,
                        vault_root,
                        tracked_files=tracked_files,
                        link_index=link_index,
                    )
                    if resolved and resolved not in related and len(related) + len(pending) < MAX_OBSIDIAN_LINKS:
                        pending.append(resolved)
    return related


class LinkIndex:
    """リンク解決用のファイル名索引（1リクエスト内で共有）。

    従来は未解決のリンクごと・候補名ごとにVault全体を `os.walk` していたため、
    リンク切れが数件あるだけでWindowsでは数十秒〜数分かかっていた。
    追跡ファイル → 未追跡ファイル(git ls-files --others) → ファイルシステム走査 の順で、
    それぞれ最大1回だけ構築する。優先順位は従来と同じ（候補名の順 → 一覧の順）。
    """

    _SKIP_DIRS = {".git", "node_modules", ".venv", "__pycache__", ".obsidian"}

    def __init__(self, repo: Path, tracked_files: list[str] | None) -> None:
        # resolve() 済みの実パスで包含判定する（symlink・subst ドライブ経由の指定でも一致させる）。
        self.repo = repo.resolve()
        self.tracked: dict[str, str] | None = None
        if tracked_files is not None:
            self.tracked = {}
            for tracked in tracked_files:
                self.tracked.setdefault(tracked.rsplit("/", 1)[-1], tracked)
        self._untracked: dict[str, str] | None = None
        self._walked: dict[Path, dict[str, list[Path]]] = {}

    def find_tracked(self, names: list[str]) -> str | None:
        if self.tracked is None:
            return None
        for name in names:
            found = self.tracked.get(name)
            if found:
                return found
        return None

    def find_untracked(self, names: list[str]) -> str | None:
        if self._untracked is None:
            self._untracked = {}
            try:
                output = git_output(["ls-files", "--others", "--exclude-standard"], self.repo)
            except HTTPException:
                output = ""
            for line in output.splitlines():
                line = line.strip()
                if line:
                    self._untracked.setdefault(line.rsplit("/", 1)[-1], line)
        for name in names:
            found = self._untracked.get(name)
            if found:
                return found
        return None

    def find_in_filesystem(self, search_roots: list[Path], names: list[str]) -> str | None:
        """gitignore済みなど、git一覧に出ないファイルのための最終手段（ルートごとに1回だけ走査）。"""
        for search_root in search_roots:
            index = self._walked.get(search_root)
            if index is None:
                index = {}
                for root, dirs, files in os.walk(str(search_root)):
                    dirs[:] = [d for d in dirs if d not in self._SKIP_DIRS]
                    for filename in files:
                        index.setdefault(filename, []).append(Path(root) / filename)
                self._walked[search_root] = index
            for name in names:
                # 同名ファイルがリポジトリ外にもある場合に備え、リポジトリ内のものが見つかるまで試す。
                for candidate in index.get(name, ()):
                    try:
                        resolved = candidate.resolve()
                        if self.repo == resolved or self.repo in resolved.parents:
                            return resolved.relative_to(self.repo).as_posix()
                    except OSError:
                        continue
        return None


def extract_markdown_links(text: str) -> list[str]:
    targets: list[str] = []
    for match in WIKI_LINK_RE.finditer(text):
        target = match.group(1).split("|", 1)[0].split("#", 1)[0].strip()
        if target:
            targets.append(target)
    for match in MARKDOWN_LINK_RE.finditer(text):
        raw_target = match.group(1).strip().split()[0].strip("<>").split("#", 1)[0].strip()
        if not raw_target:
            continue
        if raw_target.startswith(("http://", "https://")):
            # URL形式のクエリパラメータに含まれるローカルファイルパス（filepath=, path=, file=）を抽出
            try:
                parsed = urlparse(raw_target)
                query_params = parse_qs(parsed.query)
                for param_key in ("filepath", "path", "file"):
                    if param_key in query_params:
                        for val in query_params[param_key]:
                            val_clean = unquote(val).strip()
                            if val_clean:
                                targets.append(val_clean)
            except Exception:
                pass
        elif not raw_target.startswith(("#", "mailto:", "data:")):
            targets.append(raw_target)

    # CADコードブロック（```step, ```cad, ```3d 等）内の path: / file: 指定を抽出
    for block_match in CAD_CODEBLOCK_RE.finditer(text):
        block_content = block_match.group(1)
        for path_match in CAD_PATH_PROPERTY_RE.finditer(block_content):
            val = path_match.group(1).strip().strip("\"'").split("#", 1)[0].strip()
            if val and val not in targets:
                targets.append(val)

    # 汎用YAML/プロパティ内の STEP ファイル指定（path: xxx.step, file: xxx.stp 等）を抽出
    for step_prop_match in STEP_PROPERTY_RE.finditer(text):
        val = step_prop_match.group(1).strip().strip("\"'").split("#", 1)[0].strip()
        if val and val not in targets:
            targets.append(val)

    return targets


def resolve_obsidian_link(
    repo: Path,
    source_rel: str,
    raw_target: str,
    vault_root: Path | None,
    tracked_files: list[str] | None = None,
    link_index: "LinkIndex | None" = None,
) -> str | None:
    repo = repo.resolve()
    if vault_root:
        vault_root = vault_root.resolve()
    cleaned = raw_target.strip()
    if not cleaned or cleaned.startswith(("#", "http://", "https://", "mailto:", "data:")):
        return None

    # 絶対パスまたはURLからデコードされたローカル絶対パスのチェック
    if os.path.isabs(cleaned) or (len(cleaned) > 2 and cleaned[1] == ":" and cleaned[2] in ("/", "\\")):
        try:
            abs_candidate = Path(cleaned).resolve()
            if repo == abs_candidate or repo in abs_candidate.parents:
                return abs_candidate.relative_to(repo).as_posix()
        except (ValueError, OSError):
            pass

    target = unquote(cleaned.replace("\\", "/")).strip().lstrip("/")
    if not target or target.startswith(("#", "http://", "https://", "mailto:", "data:")):
        return None
    target_path = Path(target)
    source_parent = (repo / source_rel).parent
    candidates = [source_parent / target_path, repo / target_path]
    if vault_root:
        candidates.insert(1, vault_root / target_path)

    # 拡張子のサフィックス候補
    if target_path.suffix.lower() == ".excalidraw":
        suffixes = ["", ".md"]
    elif target_path.suffix:
        suffixes = [""]
    else:
        suffixes = ["", ".md"] + COMMON_IMAGE_SUFFIXES

    # 1. 直接指定（親ディレクトリ相対、リポジトリルート相対、Vaultルート相対）
    for candidate_base in candidates:
        for suffix in suffixes:
            raw_candidate = candidate_base.parent / f"{candidate_base.name}{suffix}"
            try:
                # 存在しない候補が大半なので、コストの高い resolve() より先に存在確認する。
                if not raw_candidate.is_file():
                    continue
                candidate = raw_candidate.resolve()
                if repo == candidate or repo in candidate.parents:
                    return candidate.relative_to(repo).as_posix()
            except OSError:
                continue

    # 候補となるファイル名のリストを作成
    if target_path.suffix.lower() == ".excalidraw":
        names = [target_path.name, f"{target_path.name}.md"]
    elif target_path.suffix:
        names = [target_path.name]
    else:
        names = [target_path.name, f"{target_path.name}.md"] + [f"{target_path.name}{s}" for s in COMMON_IMAGE_SUFFIXES]

    if link_index is None:
        link_index = LinkIndex(repo, tracked_files)

    # 2. Git管理下の追跡ファイル（git ls-files）から探索（高速・作業ツリー削除ファイルも網羅）
    found = link_index.find_tracked(names)
    if found:
        return found

    # 3. 未追跡ファイル（git ls-files --others）。ファイルシステム全探索より桁違いに速い。
    found = link_index.find_untracked(names)
    if found:
        return found

    # 4. gitignore済み等、gitの一覧に出ないファイルのみファイルシステムを走査する。
    search_roots = []
    if vault_root and vault_root.is_dir():
        search_roots.append(vault_root)
    if repo not in search_roots and repo.is_dir():
        search_roots.append(repo)
    return link_index.find_in_filesystem(search_roots, names)
