"""
FTS5 を使う通常の全文検索。

- 除外条件もフォルダ検索も無いときは、総件数と表示ページ分を 1 つの SQL で取得する（高速ページング）。
- 除外キーワード・除外語・フォルダ検索があるときは、一致したファイルをすべて読み、Python 側で絞り込む。
  除外キーワードの保存はインデックスを消さないので、フォルダを指定した検索でも絞り込みが要る。
- 検索語が除外語（`-語`）だけのときは、候補全体から除外語に該当しないものを返す。
- 本文は SQL の中間結果へ載せず、セグメント ID だけを運ぶ。スニペット用の本文は表示するページの分だけ読み、
  除外語の判定用の本文は除外語があるときだけ 1 件ずつ読む。
"""

from __future__ import annotations

import logging
import time as time_module
from collections.abc import Callable, Collection, Sequence
from dataclasses import dataclass
from sqlite3 import Connection

from app.models.indexing import AppSettingsResponse
from app.models.search import SearchQueryParams, SearchResponse, SearchResultItem
from app.services import search_query, search_result_items, search_snippets, search_sql
from app.services.timestamps import utc_datetime

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _PendingSnippet:
    """ページが決まるまで本文を読まずに保持しておく、スニペットの材料。"""

    snippet: object
    segment_type: str
    body_segment_id: int | None
    folder_path: str


def _pending_snippet(row) -> _PendingSnippet:
    return _PendingSnippet(
        snippet=row["snippet"],
        segment_type=str(row["segment_type"] or "filename"),
        body_segment_id=row["body_segment_id"],
        folder_path=search_result_items.resolve_folder_path(str(row["normalized_path"]), str(row["file_name"])),
    )


def _read_body_contents(connection: Connection, segment_ids: Collection[int]) -> dict[int, str]:
    """本文セグメントの ID から本文を読む。"""
    if not segment_ids:
        return {}
    placeholders = ", ".join("?" for _ in segment_ids)
    rows = connection.execute(
        f"SELECT id, content FROM file_segments WHERE id IN ({placeholders})",
        tuple(segment_ids),
    )
    return {int(row["id"]): str(row["content"] or "") for row in rows}


def _fill_snippets(
    connection: Connection,
    items: list[SearchResultItem],
    pending_snippets: dict[int, _PendingSnippet],
    highlight_terms: list[str],
) -> None:
    """表示するページの結果へスニペットを入れる。本文もここで初めて読む。"""
    page = [(item, pending_snippets[item.file_id]) for item in items if item.file_id in pending_snippets]
    body_contents = _read_body_contents(
        connection,
        {
            pending.body_segment_id
            for _, pending in page
            if pending.body_segment_id is not None and pending.segment_type in search_snippets.BODY_SEGMENT_TYPES
        },
    )
    for item, pending in page:
        item.snippet = search_snippets.resolve_snippet(
            snippet=pending.snippet,
            file_name=item.file_name,
            segment_type=pending.segment_type,
            body_content=body_contents.get(pending.body_segment_id),
            folder_path=pending.folder_path,
            highlight_terms=highlight_terms,
        )


def _paginate_with_snippets(
    connection: Connection,
    items: list[SearchResultItem],
    pending_snippets: dict[int, _PendingSnippet],
    params: SearchQueryParams,
    highlight_terms: list[str],
) -> SearchResponse:
    """並び替え済みの結果からページを切り出し、そのページにだけスニペットを入れる。"""
    response = search_result_items.paginate_search_items(items, params)
    if params.include_snippets:
        _fill_snippets(connection, response.items, pending_snippets, highlight_terms)
    return response


def _matches_excluded_terms(connection: Connection, row, exclude_terms: list[str]) -> bool:
    """除外語に該当するかを返す。除外語が無ければ本文を読まない。"""
    if not exclude_terms:
        return False
    body_segment_id = row["body_segment_id"]
    body_contents = _read_body_contents(connection, () if body_segment_id is None else (body_segment_id,))
    return search_query.matches_excluded_search_terms(
        file_name=str(row["file_name"]),
        body_content=body_contents.get(body_segment_id, ""),
        folder_path=search_result_items.resolve_folder_path(str(row["normalized_path"]), str(row["file_name"])),
        exclude_terms=exclude_terms,
    )


def search_with_fts(
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
    通常モードでは既存の FTS5 ベース全文検索を利用する。
    CTE を1回だけ評価し、COUNT と結果を同時に取得する。
    """
    fts_start = time_module.perf_counter()

    scoped_files_cte_sql, scoped_file_values = search_sql.build_scoped_files_cte(
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
        include_relative_path=params.include_path_in_filename,
    )
    cte_elapsed = time_module.perf_counter() - fts_start
    logger.info("FTS: Scoped files CTE build time: %.3fs", cte_elapsed)

    normalized_query = params.q.strip()
    include_terms, exclude_terms = search_query.split_search_terms(normalized_query)
    expanded_include_terms = search_query.expand_include_terms_with_synonyms(include_terms, app_settings.synonym_groups)
    search_body = search_query.search_target_includes_body(params.search_target)
    search_filename = search_query.search_target_includes_filename(params.search_target)
    search_folder = search_query.search_target_includes_folder(params.search_target)

    matched_queries, query_values = search_sql.build_term_match_queries(
        expanded_include_terms,
        search_body=search_body,
        search_filename=search_filename,
        search_path=search_filename and params.include_path_in_filename,
    )
    prep_elapsed = time_module.perf_counter() - fts_start - cte_elapsed
    logger.info("FTS: Query preparation time: %.3fs", prep_elapsed)

    highlight_terms = search_query.flatten_highlight_terms(expanded_include_terms)
    # フォルダ未指定の検索の除外判定は、結果を含む検索対象より下の階層で行う
    scope_roots = (
        resolve_default_target_paths(params.source_type)
        if resolve_default_target_paths and excluded_keywords and not normalized_target_path
        else []
    )
    file_items: list[SearchResultItem] = []
    pending_snippets: dict[int, _PendingSnippet] = {}
    if matched_queries:
        order_by_clause = search_sql.build_order_by_clause(
            sort_by=params.sort_by,
            sort_order=params.sort_order,
            table_alias="scoped_files",
        )
        matched_files_cte = search_sql.build_matched_files_cte(
            scoped_files_cte_sql=scoped_files_cte_sql,
            matched_queries=matched_queries,
            expanded_include_terms=expanded_include_terms,
        )
        filename_phrase = f"%{search_query.escape_like_pattern(normalized_query.lower())}%"
        all_query_values = [
            *scoped_file_values,
            search_query.normalize_query_for_history(normalized_query),
            *query_values,
            normalized_query.lower(),
            filename_phrase,
            normalized_query.lower(),
        ]
        # フォルダ検索が有効、または除外条件がある場合は、全件を一旦取得して Python 側で処理する必要がある
        should_fetch_all_files = search_folder or exclude_terms or excluded_keywords
        if not should_fetch_all_files:
            return _search_matched_files_paged(
                connection,
                matched_files_cte=matched_files_cte,
                all_query_values=all_query_values,
                order_by_clause=order_by_clause,
                params=params,
                normalized_target_path=normalized_target_path,
                highlight_terms=highlight_terms,
            )
        file_items, pending_snippets = _collect_matched_file_items(
            connection,
            matched_files_cte=matched_files_cte,
            all_query_values=all_query_values,
            order_by_clause=order_by_clause,
            normalized_target_path=normalized_target_path,
            excluded_keywords=excluded_keywords,
            scope_roots=scope_roots,
            exclude_terms=exclude_terms,
        )
    elif exclude_terms:
        file_items, pending_snippets = _collect_exclude_only_file_items(
            connection,
            scoped_files_cte_sql=scoped_files_cte_sql,
            scoped_file_values=scoped_file_values,
            params=params,
            normalized_target_path=normalized_target_path,
            excluded_keywords=excluded_keywords,
            scope_roots=scope_roots,
            exclude_terms=exclude_terms,
        )

    if not search_folder:
        return _paginate_with_snippets(connection, file_items, pending_snippets, params, highlight_terms)

    folder_items = _search_folder_results(
        connection,
        scoped_files_cte_sql=scoped_files_cte_sql,
        scoped_file_values=scoped_file_values,
        normalized_target_path=normalized_target_path,
        excluded_keywords=excluded_keywords,
        scope_roots=scope_roots,
        expanded_include_terms=expanded_include_terms,
        exclude_terms=exclude_terms,
        sort_by=params.sort_by,
        sort_order=params.sort_order,
    )
    merged_items = search_result_items.sort_search_result_items(
        [*file_items, *folder_items],
        sort_by=params.sort_by,
        sort_order=params.sort_order,
    )
    return _paginate_with_snippets(connection, merged_items, pending_snippets, params, highlight_terms)


def _collect_matched_file_items(
    connection: Connection,
    *,
    matched_files_cte: str,
    all_query_values: list[object],
    order_by_clause: str,
    normalized_target_path: str,
    excluded_keywords: list[str],
    scope_roots: Sequence[str],
    exclude_terms: list[str],
) -> tuple[list[SearchResultItem], dict[int, _PendingSnippet]]:
    """
    全件取得モード: 一致したファイルをすべて取得し、除外キーワードと除外語を Python 側で適用する。
    フォルダ検索との統合や除外条件があり、SQL だけではページングできない場合に使う。
    スニペットはページが決まってから作るため、結果とスニペットの材料を返す。
    """
    file_items: list[SearchResultItem] = []
    pending_snippets: dict[int, _PendingSnippet] = {}
    exec_start = time_module.perf_counter()
    db_start = time_module.perf_counter()
    cursor = connection.execute(
        f"""
        {matched_files_cte}
        SELECT
            scoped_files.id AS file_id,
            'file' AS result_kind,
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
            filtered.snippet,
            filtered.segment_type,
            filtered.body_segment_id,
            filtered.filename_match_level,
            filtered.relevance_bucket,
            {search_sql.build_utility_score_expression('scoped_files')} AS utility_score,
            COALESCE(query_affinity.query_click_score, 0.0) AS query_click_score
        FROM filtered
        JOIN scoped_files ON scoped_files.id = filtered.file_id
        LEFT JOIN query_affinity ON query_affinity.file_id = scoped_files.id
        ORDER BY {order_by_clause}
        """,
        tuple(all_query_values),
    )
    db_elapsed = time_module.perf_counter() - db_start
    logger.info("FTS: SQL cursor creation time (all file search): %.3fs", db_elapsed)

    process_start = time_module.perf_counter()
    for row in cursor:
        if search_result_items.should_exclude_search_result(
            target_path=normalized_target_path,
            candidate_path=str(row["normalized_path"]),
            excluded_keywords=excluded_keywords,
            scope_roots=scope_roots,
        ):
            continue
        if _matches_excluded_terms(connection, row, exclude_terms):
            continue
        file_items.append(
            search_result_items.build_search_result_item(row=row, normalized_target_path=normalized_target_path)
        )
        pending_snippets[int(row["file_id"])] = _pending_snippet(row)
    process_elapsed = time_module.perf_counter() - process_start
    logger.info("FTS: Result fetch/filter/build time (all): %.3fs (matched=%d)", process_elapsed, len(file_items))

    exec_elapsed = time_module.perf_counter() - exec_start
    logger.info("FTS: Total execution and fetching time (all): %.3fs", exec_elapsed)
    return file_items, pending_snippets


def _search_matched_files_paged(
    connection: Connection,
    *,
    matched_files_cte: str,
    all_query_values: list[object],
    order_by_clause: str,
    params: SearchQueryParams,
    normalized_target_path: str,
    highlight_terms: list[str],
) -> SearchResponse:
    """
    高速ページングモード: 総件数と表示ページ分だけを 1 クエリで取得する。
    """
    paged_order_by_clause = search_sql.build_paged_order_by_clause(
        sort_by=params.sort_by,
        sort_order=params.sort_order,
        table_alias="paged_matches",
    )
    exec_start = time_module.perf_counter()
    paged_query_values = [*all_query_values, params.limit + 1, params.offset]

    db_start = time_module.perf_counter()
    rows = connection.execute(
        f"""
        {matched_files_cte},
        total_count AS (
            SELECT COUNT(*) AS total
            FROM filtered
        ),
        paged_matches AS (
            SELECT
                scoped_files.id AS file_id,
                'file' AS result_kind,
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
                filtered.snippet,
                filtered.segment_type,
                filtered.body_segment_id,
                filtered.filename_match_level,
                filtered.relevance_bucket,
                {search_sql.build_utility_score_expression('scoped_files')} AS utility_score,
                COALESCE(query_affinity.query_click_score, 0.0) AS query_click_score,
                filtered.match_rank,
                filtered.score
            FROM filtered
            JOIN scoped_files ON scoped_files.id = filtered.file_id
            LEFT JOIN query_affinity ON query_affinity.file_id = scoped_files.id
            ORDER BY {order_by_clause}
            LIMIT ? OFFSET ?
        )
        SELECT
            paged_matches.file_id,
            paged_matches.result_kind,
            paged_matches.file_name,
            paged_matches.normalized_path,
            paged_matches.file_ext,
            paged_matches.created_at,
            paged_matches.mtime,
            paged_matches.click_count,
            paged_matches.obsidian_click_count,
            paged_matches.obsidian_rank_score,
            paged_matches.has_obsidian_top_tag,
            paged_matches.source_type,
            paged_matches.snippet,
            paged_matches.segment_type,
            paged_matches.body_segment_id,
            paged_matches.filename_match_level,
            paged_matches.relevance_bucket,
            paged_matches.utility_score,
            paged_matches.query_click_score,
            total_count.total
        FROM total_count
            LEFT JOIN paged_matches ON 1 = 1
        ORDER BY {paged_order_by_clause}
        """,
        tuple(paged_query_values),
    ).fetchall()
    db_elapsed = time_module.perf_counter() - db_start
    logger.info("FTS: SQL execution time (count + paged file search): %.3fs", db_elapsed)

    proc_start = time_module.perf_counter()
    total = int(rows[0]["total"]) if rows else 0
    page_rows = [row for row in rows if row["file_id"] is not None]
    has_more = len(page_rows) > params.limit
    visible_rows = page_rows[: params.limit]
    items = [
        search_result_items.build_search_result_item(row=row, normalized_target_path=normalized_target_path)
        for row in visible_rows
    ]
    if params.include_snippets:
        pending_snippets = {int(row["file_id"]): _pending_snippet(row) for row in visible_rows}
        _fill_snippets(connection, items, pending_snippets, highlight_terms)
    proc_elapsed = time_module.perf_counter() - proc_start
    logger.info(
        "FTS: Result processing time: %.3fs (rows=%d, visible=%d, total=%d)",
        proc_elapsed,
        len(page_rows),
        len(visible_rows),
        total,
    )

    exec_elapsed = time_module.perf_counter() - exec_start
    logger.info("FTS: Total execution and fetching time (paged): %.3fs", exec_elapsed)

    return SearchResponse(
        total=total,
        items=items,
        has_more=has_more,
        next_offset=params.offset + len(items) if has_more else None,
    )


def _collect_exclude_only_file_items(
    connection: Connection,
    *,
    scoped_files_cte_sql: str,
    scoped_file_values: list[object],
    params: SearchQueryParams,
    normalized_target_path: str,
    excluded_keywords: list[str],
    scope_roots: Sequence[str],
    exclude_terms: list[str],
) -> tuple[list[SearchResultItem], dict[int, _PendingSnippet]]:
    """
    検索語が除外語（`-keyword`）だけのとき、スコープ内の全ファイルから除外語に該当しないものを返す。
    """
    file_items: list[SearchResultItem] = []
    pending_snippets: dict[int, _PendingSnippet] = {}
    cursor = connection.execute(
        f"""
        {scoped_files_cte_sql}
        SELECT
            scoped_files.id AS file_id,
            'file' AS result_kind,
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
            '' AS snippet,
            'filename' AS segment_type,
            file_segments.id AS body_segment_id,
            0 AS filename_match_level,
            10 AS relevance_bucket,
            {search_sql.build_utility_score_expression('scoped_files')} AS utility_score,
            0.0 AS query_click_score
        FROM scoped_files
        LEFT JOIN file_segments
          ON file_segments.file_id = scoped_files.id
         AND file_segments.segment_type = 'body'
        ORDER BY {search_sql.build_scan_order_by_clause(sort_by=params.sort_by, sort_order=params.sort_order, table_alias='scoped_files')}
        """,
        tuple(scoped_file_values),
    )
    seen_ids = set()
    for row in cursor:
        fid = int(row["file_id"])
        if fid in seen_ids:
            continue
        seen_ids.add(fid)
        if search_result_items.should_exclude_search_result(
            target_path=normalized_target_path,
            candidate_path=str(row["normalized_path"]),
            excluded_keywords=excluded_keywords,
            scope_roots=scope_roots,
        ):
            continue
        if _matches_excluded_terms(connection, row, exclude_terms):
            continue
        file_items.append(
            search_result_items.build_search_result_item(row=row, normalized_target_path=normalized_target_path)
        )
        pending_snippets[int(row["file_id"])] = _pending_snippet(row)
    return file_items, pending_snippets


def _search_folder_results(
    connection: Connection,
    *,
    scoped_files_cte_sql: str,
    scoped_file_values: list[object],
    normalized_target_path: str,
    excluded_keywords: list[str],
    scope_roots: Sequence[str],
    expanded_include_terms: list[list[str]],
    exclude_terms: list[str],
    sort_by: str,
    sort_order: str,
) -> list[SearchResultItem]:
    """
    フォルダ名検索は SQL 側で親フォルダを集約し、Python 側の全件一意化を避ける。
    """
    if not expanded_include_terms:
        return []

    lowered_exclude_terms = [term.lower() for term in exclude_terms if term]
    folder_path_expression = search_sql.build_folder_path_sql_expression("scoped_files")
    filters: list[str] = []
    values: list[object] = [*scoped_file_values]

    for term_group in expanded_include_terms:
        group_filters: list[str] = []
        for term in term_group:
            if term:
                group_filters.append(f"lower({folder_path_expression}) LIKE ? ESCAPE '\\'")
                values.append(f"%{search_query.escape_like_pattern(term.lower())}%")
        if group_filters:
            filters.append(f"({' OR '.join(group_filters)})")

    for term in lowered_exclude_terms:
        filters.append(f"lower({folder_path_expression}) NOT LIKE ? ESCAPE '\\'")
        values.append(f"%{search_query.escape_like_pattern(term)}%")

    where_clause = " AND ".join(filters) if filters else "1 = 1"
    folder_sql_start = time_module.perf_counter()
    try:
        rows = connection.execute(
            f"""
            {scoped_files_cte_sql}
            SELECT
                {folder_path_expression} AS folder_path,
                MAX(scoped_files.created_at) AS created_at,
                MAX(scoped_files.mtime) AS mtime
            FROM scoped_files
            WHERE {where_clause}
            GROUP BY folder_path
            """,
            tuple(values),
        ).fetchall()
    finally:
        folder_sql_elapsed = time_module.perf_counter() - folder_sql_start
        logger.info("FTS: SQL execution time (folder search): %.3fs", folder_sql_elapsed)

    flat_highlight_terms = search_query.flatten_highlight_terms(expanded_include_terms)
    items: list[SearchResultItem] = []
    for index, row in enumerate(rows):
        folder_path = str(row["folder_path"])
        if search_result_items.should_exclude_search_result(
            target_path=normalized_target_path,
            candidate_path=folder_path,
            excluded_keywords=excluded_keywords,
            scope_roots=scope_roots,
        ):
            continue
        display_name = search_result_items.resolve_result_display_name("folder", folder_path, folder_path)
        items.append(
            SearchResultItem(
                # フォルダ結果は files に行が無いため、負の連番を割り当てる
                file_id=-(index + 1),
                result_kind="folder",
                target_path=normalized_target_path,
                file_name=display_name,
                full_path=folder_path,
                file_ext="",
                created_at=utc_datetime(float(row["created_at"])),
                mtime=utc_datetime(float(row["mtime"])),
                click_count=0,
                snippet=search_snippets.resolve_snippet(
                    snippet=None,
                    file_name=display_name,
                    segment_type="folder",
                    folder_path=folder_path,
                    highlight_terms=flat_highlight_terms,
                ),
            )
        )
    return search_result_items.sort_search_result_items(items, sort_by=sort_by, sort_order=sort_order)
