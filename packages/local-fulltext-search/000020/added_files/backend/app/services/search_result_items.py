"""
検索結果（SearchResultItem）の組み立て・除外判定・並び替え・ページ切り出し。

DB から読んだ行を画面用のモデルへ変換する。SQL で並び替えられない場合（フォルダ結果との統合、
正規表現検索、gantt タスクとの統合）は、ここの並び替えで SQL と同じ順序規則を再現する。
"""

from __future__ import annotations

import time as time_module
from collections.abc import Sequence
from functools import lru_cache
from pathlib import Path

from app.models.search import SearchQueryParams, SearchResponse, SearchResultItem
from app.services import exclude_rules
from app.services.path_service import matches_exclude_keyword
from app.services.timestamps import utc_datetime


@lru_cache(maxsize=16)
def _name_keywords(excluded_keywords: tuple[str, ...]) -> tuple[tuple[str, str], ...]:
    """パス区切りを含まないキーワードを（前後の空白を除いた表記, 小文字）の組で返す。"""
    stripped_keywords = [keyword.strip() for keyword in excluded_keywords]
    return tuple(
        (keyword, keyword.lower())
        for keyword in stripped_keywords
        if keyword and "/" not in keyword and "\\" not in keyword
    )


def should_exclude_search_result(
    *,
    target_path: str,
    candidate_path: str,
    excluded_keywords: list[str],
    scope_roots: Sequence[str] = (),
) -> bool:
    """
    検索結果の除外判定。
    1. Web URL またはローカルファイル名/ステムに除外キーワードが含まれる場合は除外。
    2. パス形式はパス全体で、フォルダ名は対象フォルダより下の要素だけで判定する。
       フォルダ未指定の検索では、結果を含む検索対象（scope_roots）を対象フォルダとして扱う。
    """
    if not excluded_keywords:
        return False
    if target_path.startswith(("http://", "https://")) or candidate_path.startswith(("http://", "https://")):
        lowered_candidate = candidate_path.lower()
        return any(keyword.lower() in lowered_candidate for keyword in excluded_keywords)

    # DB に保存済みの正規化パスなので、結果1件ごとに resolve（実ファイルへのアクセス）はしない。
    result_path = Path(candidate_path)
    # ファイル名（または末尾の名前）およびステムに対する除外キーワード判定
    file_name = result_path.name
    stem = result_path.stem
    lowered_file_name = file_name.lower()
    # パス区切りを含まないキーワードはファイル名またはステムの部分一致で除外
    for keyword, lowered_keyword in _name_keywords(tuple(excluded_keywords)):
        # 「結果の件数 × キーワード数」回通るので、含まれないものは語の区切りの判定へ進めない
        if lowered_keyword in lowered_file_name and (
            matches_exclude_keyword(file_name, keyword) or matches_exclude_keyword(stem, keyword)
        ):
            return True

    root = target_path or exclude_rules.find_enclosing_root(candidate_path, scope_roots)
    return exclude_rules.should_exclude_under_root(result_path, root, excluded_keywords)


def resolve_folder_path(normalized_path: str, file_name: str) -> str:
    """
    正規化済みフルパスから、検索用の親フォルダーパスを取り出す。
    """
    if normalized_path.endswith(file_name):
        return normalized_path[: -len(file_name)].rstrip("/") or "/"
    parts = normalized_path.rsplit("/", 1)
    return parts[0] if len(parts) == 2 and parts[0] else "/"


def resolve_result_display_name(result_kind: str, full_path: str, file_name: str) -> str:
    """
    フォルダ結果ではフルパスではなく末尾名を表示名として返す。
    """
    if result_kind != "folder":
        return file_name
    trimmed = full_path.rstrip("/\\")
    if not trimmed:
        return full_path
    last_separator_index = max(trimmed.rfind("/"), trimmed.rfind("\\"))
    if last_separator_index < 0:
        return trimmed
    if last_separator_index == 0:
        return trimmed
    return trimmed[last_separator_index + 1 :]


def resolve_folder_path_for_result(result_kind: str, full_path: str, file_name: str) -> str:
    """
    結果種別に応じて、スニペットや除外判定に使うフォルダーパスを返す。
    """
    if result_kind == "folder":
        return full_path
    return resolve_folder_path(full_path, file_name)


def build_search_result_item(*, row, normalized_target_path: str) -> SearchResultItem:
    """
    DB 行から UI 用の検索結果モデルを組み立てる。
    スニペットは本文が必要なので、ページが決まってから呼び出し元が入れる。
    """
    result_kind = str(row["result_kind"] or "file")
    try:
        source_type = str(row["source_type"] or "local")
    except (KeyError, IndexError):
        source_type = "local"
    full_path = str(row["normalized_path"])
    raw_name = str(row["file_name"])
    display_name = resolve_result_display_name(result_kind, full_path, raw_name)
    return SearchResultItem(
        file_id=int(row["file_id"]),
        result_kind="folder" if result_kind == "folder" else "file",
        source_type=source_type if source_type in {"web", "gantt"} else "local",
        target_path=normalized_target_path,
        file_name=display_name,
        full_path=full_path,
        file_ext=str(row["file_ext"]),
        created_at=utc_datetime(float(row["created_at"])),
        mtime=utc_datetime(float(row["mtime"])),
        click_count=int(row["click_count"] or 0) + int(row["obsidian_click_count"] or 0),
        has_obsidian_top_tag=bool(row["has_obsidian_top_tag"]),
        filename_match_priority=int(row["filename_match_level"] or 0) >= 2,
        filename_match_level=int(row["filename_match_level"] or 0),
        relevance_bucket=int(row["relevance_bucket"] or 0),
        utility_score=float(row["utility_score"] or 0.0),
        query_click_score=float(row["query_click_score"] or 0.0),
        snippet="",
    )


def sort_search_result_items(
    items: list[SearchResultItem],
    *,
    sort_by: str,
    sort_order: str,
) -> list[SearchResultItem]:
    """
    Python 側で構築した検索結果を UI 指定の並び順で安定ソートする。
    """
    if sort_by == "default":
        return sorted(
            items,
            key=lambda item: (
                item.filename_match_level,
                item.has_obsidian_top_tag,
                item.query_click_score,
                item.relevance_bucket,
                item.utility_score,
                item.mtime.timestamp(),
                item.file_id,
            ),
            reverse=True,
        )

    reverse = sort_order == "desc"

    def key(item: SearchResultItem) -> tuple[float, int]:
        if sort_by == "click_count":
            return (float(item.click_count), item.file_id)
        if sort_by == "created":
            return (item.created_at.timestamp(), item.file_id)
        return (item.mtime.timestamp(), item.file_id)

    return sorted(items, key=key, reverse=reverse)


def paginate_search_items(items: list[SearchResultItem], params: SearchQueryParams) -> SearchResponse:
    """
    並び替え済みの結果一覧から、offset / limit の範囲を切り出してレスポンスにする。
    """
    page_items = items[params.offset : params.offset + params.limit]
    has_more = params.offset + len(page_items) < len(items)
    return SearchResponse(
        total=len(items),
        items=page_items,
        has_more=has_more,
        next_offset=params.offset + len(page_items) if has_more else None,
    )


def calculate_utility_score(*, click_count: int, obsidian_rank_score: float, mtime: float) -> float:
    """
    SQL版と同じ利用価値スコアを、正規表現検索などPython側の並び替え用に計算する。
    """
    popularity = click_count / (click_count + 10.0)
    obsidian_importance = min(max(obsidian_rank_score / 1000.0, 0.0), 1.0)
    age_seconds = max(time_module.time() - mtime, 0.0)
    recency = 1.0 / (1.0 + age_seconds / (90 * 24 * 60 * 60))
    return 0.55 * popularity + 0.25 * obsidian_importance + 0.20 * recency
