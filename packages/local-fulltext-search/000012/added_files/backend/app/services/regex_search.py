"""
正規表現検索。

候補のファイルを DB から順に読み、本文・ファイル名・フォルダパスを Python の re で評価する。
フォルダパスだけに一致した場合は、フォルダを 1 件の結果として返す（file_id は負の連番）。
"""

from __future__ import annotations

import logging
import re
import time as time_module
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from sqlite3 import Connection, Row

from app.models.indexing import AppSettingsResponse
from app.models.search import SearchQueryParams, SearchResponse, SearchResultItem
from app.services import exclude_rules, search_query, search_result_items, search_snippets, search_sql
from app.services.path_service import normalize_path

logger = logging.getLogger(__name__)


def search_with_regex(
    connection: Connection,
    *,
    params: SearchQueryParams,
    normalized_target_path: str,
    excluded_keywords: list[str],
    app_settings: AppSettingsResponse,
    path_depth_limit: int | None,
    resolve_default_target_paths: Callable[[str], list[str]] | None = None,
    restrict_file_ids: Sequence[int] | None = None,
) -> SearchResponse:
    """
    正規表現モードでは Python の re で本文とファイル名を評価する。
    イテレータで逐次処理し、メモリ使用量を抑える。
    """
    regex_start = time_module.perf_counter()
    scoped_files_cte_sql, values = search_sql.build_scoped_files_cte(
        normalized_target_path=normalized_target_path,
        search_all_enabled=params.search_all_enabled,
        path_depth_limit=path_depth_limit,
        types=params.types,
        date_field=params.date_field,
        created_from=params.created_from,
        created_to=params.created_to,
        custom_content_extensions=app_settings.custom_content_extensions,
        custom_filename_extensions=app_settings.custom_filename_extensions,
        source_type=params.source_type,
        resolve_default_target_paths=resolve_default_target_paths,
        restrict_file_ids=restrict_file_ids,
    )
    cte_elapsed = time_module.perf_counter() - regex_start
    logger.info("Regex: Scoped files CTE build time: %.3fs", cte_elapsed)

    normalized_query = params.q.strip()
    include_groups, exclude_terms = search_query.split_search_terms(normalized_query)
    flat_include_terms = [term for group in include_groups for term in group]
    pattern = search_query.compile_regex(" ".join(flat_include_terms))
    search_body = search_query.search_target_includes_body(params.search_target)

    search_filename = search_query.search_target_includes_filename(params.search_target)
    search_folder = search_query.search_target_includes_folder(params.search_target)
    cursor = connection.execute(
        f"""
        {scoped_files_cte_sql}
        SELECT
            scoped_files.id AS file_id,
            scoped_files.file_name,
            scoped_files.normalized_path,
            scoped_files.file_ext,
            scoped_files.created_at,
            scoped_files.mtime,
            scoped_files.click_count,
            scoped_files.obsidian_click_count,
            scoped_files.obsidian_rank_score,
            scoped_files.has_obsidian_top_tag,
            scoped_files.source_type,
            file_segments.content
        FROM scoped_files
        LEFT JOIN file_segments
            ON file_segments.file_id = scoped_files.id
           AND file_segments.segment_type = 'body'
        ORDER BY {search_sql.build_scan_order_by_clause(
            sort_by=params.sort_by,
            sort_order=params.sort_order,
            table_alias="scoped_files",
        )}
        """,
        tuple(values),
    )

    exec_elapsed = time_module.perf_counter() - regex_start - cte_elapsed
    logger.info("Regex: DB execution time: %.3fs", exec_elapsed)

    proc_start = time_module.perf_counter()

    file_items: list[SearchResultItem] = []
    folder_items_by_path: dict[str, SearchResultItem] = {}
    for row in cursor:
        normalized_path = str(row["normalized_path"])
        if exclude_rules.should_exclude_path(normalize_path(normalized_path), excluded_keywords):
            continue

        file_name = str(row["file_name"])
        folder_path = search_result_items.resolve_folder_path(normalized_path, file_name)
        content = str(row["content"] or "")
        content_match = pattern.search(content) if search_body else None
        file_name_match = pattern.search(file_name) if search_filename else None
        folder_path_match = pattern.search(folder_path) if search_folder else None
        if content_match is None and file_name_match is None and folder_path_match is None:
            continue
        if search_query.matches_excluded_search_terms(
            file_name=file_name,
            body_content=content,
            folder_path=folder_path,
            exclude_terms=exclude_terms,
        ):
            continue

        if content_match is not None or file_name_match is not None:
            file_items.append(
                _build_file_item(
                    row,
                    normalized_target_path=normalized_target_path,
                    folder_path=folder_path,
                    content_match=content_match,
                    file_name_match=file_name_match,
                    include_snippets=params.include_snippets,
                )
            )

        if folder_path_match is not None and folder_path not in folder_items_by_path:
            folder_items_by_path[folder_path] = _build_folder_item(
                row,
                # フォルダ結果は files に行が無いため、負の連番を割り当てる
                file_id=-len(folder_items_by_path) - 1,
                normalized_target_path=normalized_target_path,
                folder_path=folder_path,
                folder_path_match=folder_path_match,
                include_snippets=params.include_snippets,
            )

    all_items = search_result_items.sort_search_result_items(
        [*file_items, *folder_items_by_path.values()],
        sort_by=params.sort_by,
        sort_order=params.sort_order,
    )
    response = search_result_items.paginate_search_items(all_items, params)

    proc_elapsed = time_module.perf_counter() - proc_start
    logger.info(
        "Regex: Result processing and matching time: %.3fs (total=%d, visible=%d)",
        proc_elapsed,
        len(all_items),
        len(response.items),
    )
    return response


def _build_file_item(
    row: Row,
    *,
    normalized_target_path: str,
    folder_path: str,
    content_match: re.Match[str] | None,
    file_name_match: re.Match[str] | None,
    include_snippets: bool,
) -> SearchResultItem:
    """本文またはファイル名が一致したファイルの検索結果を作る。"""
    file_name = str(row["file_name"])
    click_count = int(row["click_count"] or 0) + int(row["obsidian_click_count"] or 0)
    return SearchResultItem(
        file_id=int(row["file_id"]),
        result_kind="file",
        source_type="web" if str(row["source_type"] or "local") == "web" else "local",
        target_path=normalized_target_path,
        file_name=file_name,
        full_path=str(row["normalized_path"]),
        file_ext=str(row["file_ext"]),
        created_at=datetime.fromtimestamp(float(row["created_at"]), tz=UTC),
        mtime=datetime.fromtimestamp(float(row["mtime"]), tz=UTC),
        click_count=click_count,
        has_obsidian_top_tag=bool(row["has_obsidian_top_tag"]),
        filename_match_priority=file_name_match is not None,
        filename_match_level=2 if file_name_match is not None else 0,
        relevance_bucket=10,
        utility_score=search_result_items.calculate_utility_score(
            click_count=click_count,
            obsidian_rank_score=float(row["obsidian_rank_score"] or 0.0),
            mtime=float(row["mtime"]),
        ),
        snippet=(
            search_snippets.build_regex_snippet(
                content=str(row["content"] or ""),
                file_name=file_name,
                folder_path=folder_path,
                content_match=content_match,
                file_name_match=file_name_match,
                folder_path_match=None,
            )
            if include_snippets
            else ""
        ),
    )


def _build_folder_item(
    row: Row,
    *,
    file_id: int,
    normalized_target_path: str,
    folder_path: str,
    folder_path_match: re.Match[str],
    include_snippets: bool,
) -> SearchResultItem:
    """フォルダパスが一致したフォルダの検索結果を作る。日時は、最初に見つかった配下ファイルのものを使う。"""
    return SearchResultItem(
        file_id=file_id,
        result_kind="folder",
        source_type="local",
        target_path=normalized_target_path,
        file_name=search_result_items.resolve_result_display_name("folder", folder_path, folder_path),
        full_path=folder_path,
        file_ext="",
        created_at=datetime.fromtimestamp(float(row["created_at"]), tz=UTC),
        mtime=datetime.fromtimestamp(float(row["mtime"]), tz=UTC),
        click_count=0,
        snippet=(
            search_snippets.build_regex_snippet(
                content=str(row["content"] or ""),
                file_name=str(row["file_name"]),
                folder_path=folder_path,
                content_match=None,
                file_name_match=None,
                folder_path_match=folder_path_match,
            )
            if include_snippets
            else ""
        ),
    )
