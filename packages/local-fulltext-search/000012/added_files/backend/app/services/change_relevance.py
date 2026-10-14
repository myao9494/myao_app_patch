"""
OS の変更通知が、どの検索対象のインデックスに影響しうるかを判定する。

仕様:
- 変更パスが検索対象フォルダ配下にあるときだけ、その対象を更新候補にする。
- 変更パスが対象の除外キーワード（フォルダ名・ファイル名・パス形式）に該当する場合は、
  走査しても結果が変わらないため更新候補にしない（`.git/` や `node_modules/` 配下の書き込みで
  対象全体の差分走査とベクトル同期が繰り返されるのを防ぐ）。
- 判定はインデックス走査（local_target_indexer.walk_indexable_files）と同じ除外規則を使う。
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

from app.services import exclude_rules
from app.services.path_service import normalize_path


def _normalize_for_comparison(path: str) -> str | None:
    try:
        return normalize_path(path).as_posix()
    except (OSError, ValueError):
        return None


def is_change_relevant_to_target(changed_path: str, root_path: str, exclude_keywords: str | None) -> bool:
    """変更パスが検索対象配下にあり、かつ除外対象ではない（インデックスへ影響しうる）かを返す。"""
    normalized_path = _normalize_for_comparison(changed_path)
    normalized_root = _normalize_for_comparison(root_path)
    if normalized_path is None or normalized_root is None:
        return False
    normalized_root = normalized_root.rstrip("/")
    if normalized_path == normalized_root:
        return True
    if not normalized_path.startswith(f"{normalized_root}/"):
        return False

    keywords = exclude_rules.parse_exclude_keywords(exclude_keywords)
    if not keywords:
        return True
    keyword_set, substring_keywords, excluded_path_prefixes = exclude_rules.compile_exclude_keywords(keywords)
    if exclude_rules.is_excluded_path_prefix(normalized_path, excluded_path_prefixes):
        return False
    relative_parts = [part for part in normalized_path[len(normalized_root) :].split("/") if part]
    return not any(
        exclude_rules.is_excluded_name(part, keyword_set, substring_keywords) for part in relative_parts
    )


def find_targets_affected_by_changes(targets: Iterable[Any], changed_paths: Sequence[str]) -> list[Any]:
    """
    変更パスのいずれかがインデックスへ影響しうる検索対象だけを返す。
    targets の各要素は `full_path` と `exclude_keywords` をキーで参照できる行（sqlite3.Row 等）とする。
    """
    return [
        target
        for target in targets
        if any(
            is_change_relevant_to_target(path, str(target["full_path"]), str(target["exclude_keywords"] or ""))
            for path in changed_paths
        )
    ]
