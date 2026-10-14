"""
Excalidraw 図面の書き出し済みキャッシュ画像（PNG / SVG）の探索。
Vault 内のキャッシュフォルダと索引ファイルから、図面ファイルに対応する画像を探す。
見つかれば、図面データから SVG を作り直さずにその画像を使う。
"""

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def get_fnv1a_hash(val: str) -> str:
    """Obsidian Excalidrawプラグイン互換のFNV-1aハッシュ計算 (32-bit unsigned hex)"""
    normalized = val.replace("\\", "/").strip("/")
    h = 2166136261
    for c in normalized:
        h = ((h ^ ord(c)) * 16777619) & 0xFFFFFFFF
    return hex(h)[2:]


def find_excalidraw_cache_dirs(vault_path: Path) -> List[Path]:
    """.excalidraw-cache ディレクトリをVaultおよび祖先ディレクトリから探索する"""
    cache_dirs = []
    current = vault_path.resolve()
    # 最大4階層上まで探索
    for _ in range(5):
        c = current / ".excalidraw-cache"
        if c.exists() and c.is_dir():
            cache_dirs.append(c)
        if current.parent == current:
            break
        current = current.parent
    return cache_dirs


def load_excalidraw_cache_indices(cache_dirs: List[Path]) -> Dict[str, Any]:
    """.excalidraw-cache/index.json からインデックスデータを読み込む"""
    index_map = {}
    for c_dir in cache_dirs:
        idx_file = c_dir / "index.json"
        if idx_file.exists():
            try:
                data = json.loads(idx_file.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    index_map.update(data)
            except (OSError, ValueError):
                logger.warning("Failed to read an Excalidraw cache index: %s", idx_file, exc_info=True)
    return index_map


def find_excalidraw_cache_image(
    target_file: Path,
    vault_path: Path,
    cache_dirs: List[Path],
    index_data: Dict[str, Any],
) -> Optional[Path]:
    """対象のExcalidrawノートに対応するPNG/SVGプレビューキャッシュを探索する"""
    if not cache_dirs:
        return None

    # 相対パス候補
    path_candidates = []
    try:
        path_candidates.append(str(target_file.relative_to(vault_path)).replace("\\", "/"))
    except ValueError:
        pass

    # 祖先ディレクトリからの相対パス
    current_v = vault_path
    for _ in range(3):
        try:
            path_candidates.append(str(target_file.relative_to(current_v)).replace("\\", "/"))
        except ValueError:
            pass
        current_v = current_v.parent

    path_candidates.append(target_file.name)
    if target_file.name.endswith(".md"):
        path_candidates.append(target_file.name[:-3])

    # 1. index.json によるマッチング
    for cand in path_candidates:
        norm_cand = cand.strip("/")
        entry = index_data.get(norm_cand) or index_data.get(cand)
        if entry and isinstance(entry, dict):
            cachefile_name = entry.get("cachefile") or entry.get("fallbackCachefile")
            if cachefile_name:
                for c_dir in cache_dirs:
                    cf = c_dir / Path(cachefile_name).name
                    if cf.exists() and cf.is_file():
                        return cf

    # 2. FNV-1a ハッシュ値によるキャッシュファイル名マッチング ({hash}_*.png, {hash}_*.svg)
    for cand in path_candidates:
        h = get_fnv1a_hash(cand)
        for c_dir in cache_dirs:
            try:
                for cf in c_dir.iterdir():
                    if cf.is_file() and cf.name.startswith(f"{h}_") and (cf.name.endswith(".png") or cf.name.endswith(".svg")):
                        return cf
            except OSError:
                logger.debug("Failed to scan an Excalidraw cache folder.", exc_info=True)

    return None
