"""
Obsidian Vault 関連の処理

- find_obsidian_vault_root: パスから上位を遡り `.obsidian` を持つ Vault ルートを探す
  （見つからなければ設定の Obsidian ベースディレクトリから探す）
- find_file_in_vault: ファイル名だけの指定（`![[image.png]]`）から Vault 内のファイルを探す
    - Vault ごとにファイル名索引をキャッシュし、画像ごとに Vault 全体を走査しない
    - 見つからない場合や索引のファイルが消えている場合は、索引を作り直して再検索する
    - ファイル名はそのまま比較する（`[` や `*` を glob として解釈しない）
- get_string_hash: Obsidian Excalidraw Cards プラグイン互換の FNV-1a ハッシュ
- resolve_excalidraw_preview_image: Excalidraw 図面のプレビュー画像（.excalidraw-cache 等）を探す
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Optional

from app.config import settings

# 索引を作るときに辿らないフォルダ
VAULT_INDEX_SKIP_DIRS = frozenset({".git", "node_modules"})
# 見つからなかったときに索引を作り直すまでの最短間隔（貼り付け直後の画像に対応しつつ連続走査を防ぐ）
VAULT_INDEX_MIN_REBUILD_SECONDS = 5.0
# この時間が経った索引は使う前に作り直す
VAULT_INDEX_MAX_AGE_SECONDS = 300.0


class _VaultIndex:
    def __init__(self, root: Path):
        self.root = root
        self.built_at = 0.0
        self.by_name: dict[str, list[Path]] = {}
        self.lock = threading.Lock()

    def _build(self) -> None:
        by_name: dict[str, list[Path]] = {}
        for current, dirs, files in os.walk(self.root):
            dirs[:] = [d for d in dirs if d not in VAULT_INDEX_SKIP_DIRS]
            for name in files:
                by_name.setdefault(name, []).append(Path(current) / name)
        self.by_name = by_name
        self.built_at = time.monotonic()

    def find(self, name: str) -> Optional[Path]:
        with self.lock:
            now = time.monotonic()
            if not self.built_at or now - self.built_at > VAULT_INDEX_MAX_AGE_SECONDS:
                self._build()
            found = self._lookup(name)
            if found is None and now - self.built_at >= VAULT_INDEX_MIN_REBUILD_SECONDS:
                self._build()
                found = self._lookup(name)
            return found

    def _lookup(self, name: str) -> Optional[Path]:
        candidates = self.by_name.get(name, [])
        existing = [p for p in candidates if p.is_file()]
        if len(existing) != len(candidates):
            # 削除・移動されたファイルが索引に残っている
            self.by_name[name] = existing
        if not existing:
            return None
        # 同名ファイルが複数ある場合は Vault ルートに近いものを優先する
        return min(existing, key=lambda p: (len(p.parts), str(p)))


_indexes_lock = threading.Lock()
_indexes: dict[str, _VaultIndex] = {}


def find_file_in_vault(vault_root: Path, name: str) -> Optional[Path]:
    """Vault 内でファイル名が一致するファイルを探す（キャッシュ付き）"""
    key = os.path.normcase(str(vault_root))
    with _indexes_lock:
        index = _indexes.get(key)
        if index is None:
            index = _indexes[key] = _VaultIndex(vault_root)
    return index.find(name)


def clear_vault_indexes() -> None:
    """ファイル名索引のキャッシュを破棄する（テスト用）"""
    with _indexes_lock:
        _indexes.clear()


def get_string_hash(s: str) -> str:
    """Obsidian Excalidraw Cards プラグイン互換の FNV-1a ハッシュ (32-bit unsigned hex)"""
    h = 2166136261
    for ch in s:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return hex(h)[2:]


def find_obsidian_vault_root(start_path: Path) -> Optional[Path]:
    """与えられたパスから上位を遡り、.obsidian フォルダを持つ Obsidian Vault ルートを検索する"""
    curr = start_path if start_path.is_dir() else start_path.parent
    for _ in range(8):
        if (curr / ".obsidian").is_dir():
            return curr
        if curr.parent == curr:
            break
        curr = curr.parent

    try:
        obsidian_base = Path(settings.obsidian_base_dir)
        curr = obsidian_base if obsidian_base.is_dir() else obsidian_base.parent
        for _ in range(5):
            if (curr / ".obsidian").is_dir():
                return curr
            if curr.parent == curr:
                break
            curr = curr.parent
    except OSError:
        pass

    return None


def resolve_excalidraw_preview_image(excal_path: Path, vault_root: Optional[Path]) -> Optional[Path]:
    """
    .excalidraw.md または .excalidraw ファイルに対応するプレビュー画像を探す
    1. 同一ディレクトリの .png / .svg / .excalidraw.png / .excalidraw.svg
    2. .excalidraw-cache/index.json による探索
    3. .excalidraw-cache/[hash]_*_preview.png 探索
    """
    stem = excal_path.stem
    base_stem = stem[:-11] if stem.endswith(".excalidraw") else stem

    parent = excal_path.parent
    for ext in [".excalidraw.png", ".excalidraw.svg", ".png", ".svg"]:
        candidate = parent / f"{base_stem}{ext}"
        if candidate.is_file():
            return candidate

    if not vault_root:
        vault_root = find_obsidian_vault_root(excal_path)
    if not vault_root or not vault_root.is_dir():
        return None

    v_res = vault_root.resolve()
    cache_dir = v_res / ".excalidraw-cache"
    if not cache_dir.is_dir():
        return None
    try:
        rel_path = excal_path.resolve().relative_to(v_res).as_posix()
    except ValueError:
        rel_path = excal_path.name

    index_file = cache_dir / "index.json"
    if index_file.is_file():
        try:
            data = json.loads(index_file.read_text(encoding="utf-8", errors="ignore"))
            entry = data.get(rel_path)
            if isinstance(entry, dict) and "cachefile" in entry:
                cache_file = cache_dir / entry["cachefile"]
                if cache_file.is_file():
                    return cache_file
            target_name = excal_path.name
            for key, value in data.items():
                if (key.endswith(target_name) or key.endswith(f"{base_stem}.excalidraw.md")) and isinstance(value, dict):
                    if "cachefile" in value:
                        cache_file = cache_dir / value["cachefile"]
                        if cache_file.is_file():
                            return cache_file
        except (OSError, ValueError, AttributeError):
            pass

    hash_str = get_string_hash(rel_path)
    matching_files = sorted(
        cache_dir.glob(f"{hash_str}_*_preview.*"), key=lambda p: p.stat().st_mtime, reverse=True
    )
    return matching_files[0] if matching_files else None
