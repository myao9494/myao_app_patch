"""
全文検索の SQL 組み立て（DB へは接続しない）。

- 候補の絞り込み（フォルダ・階層・拡張子・日付・ソース種別）は scoped_files CTE に 1 回だけ書く。
  検索語ごとのクエリへ同じ条件を重ねない。
- 検索語ごとの一致（本文 FTS・日本語 bigram・ファイル名・Obsidian title / alias）を UNION ALL でまとめ、
  全 OR グループに一致したファイルだけを残す。
- 利用者の入力は必ずプレースホルダーで渡す。SQL へ埋め込むのは、ここで決めた固定の列名・定数だけ。
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import date, datetime, time, timedelta

from app.extractors.text_extractor import parse_extension_filter
from app.services import app_settings_store, search_query
from app.services.cjk_bigram import build_cjk_bigram_match_query
from app.services.path_service import get_descendant_path_prefix, get_descendant_path_range


def build_common_filters(
    *,
    normalized_target_path: str,
    search_all_enabled: bool,
    path_depth_limit: int | None,
    types: str | None,
    date_field: str = "created",
    created_from: date | None = None,
    created_to: date | None = None,
    custom_content_extensions: str = "",
    custom_filename_extensions: str = "",
    source_type: str = "local",
    resolve_default_target_paths: Callable[[str], list[str]] | None = None,
) -> tuple[str, list[object]]:
    """
    検索モード共通のパス・階層・拡張子・日付フィルタを組み立てる。
    """
    filters: list[str] = []
    normalized_source_type = "web" if source_type == "web" else "local"
    if source_type == "local_web":
        filters.append("files.source_type IN ('local', 'web')")
    else:
        filters.append(f"files.source_type = '{normalized_source_type}'")
    values: list[object] = []
    date_column = "files.created_at" if date_field == "created" else "files.mtime"

    if normalized_target_path:
        prefix_start, prefix_end = get_descendant_path_range(normalized_target_path)
        if normalized_source_type == "web":
            filters.append("(files.normalized_path = ? OR (files.normalized_path >= ? AND files.normalized_path < ?))")
            values.extend([normalized_target_path, prefix_start, prefix_end])
        else:
            filters.extend(["files.normalized_path >= ?", "files.normalized_path < ?"])
            values.extend([prefix_start, prefix_end])

        if path_depth_limit is not None:
            descendant_prefix = get_descendant_path_prefix(normalized_target_path)
            depth_expression = (
                "(length(files.normalized_path) - length(replace(files.normalized_path, '/', '')))"
                " - (length(?) - length(replace(?, '/', '')))"
            )
            filters.append(f"{depth_expression} <= ?")
            values.extend([descendant_prefix, descendant_prefix, path_depth_limit])
    elif not search_all_enabled:
        # フォルダ未指定のときは、登録済みの検索対象の配下だけを候補にする
        target_paths = resolve_default_target_paths(source_type) if resolve_default_target_paths else []
        if not target_paths:
            return "0 = 1", values

        target_filters: list[str] = []
        for target_path in target_paths:
            prefix_start, prefix_end = get_descendant_path_range(target_path)
            target_filters.append("(files.normalized_path >= ? AND files.normalized_path < ?)")
            values.extend([prefix_start, prefix_end])
        filters.append(f"({' OR '.join(target_filters)})")

    if types:
        include_exts, exclude_exts = parse_extension_filter(
            types,
            extra_content_extensions=tuple(app_settings_store.parse_extension_entries(custom_content_extensions)),
            extra_filename_extensions=tuple(app_settings_store.parse_extension_entries(custom_filename_extensions)),
        )
        if include_exts:
            sorted_include = sorted(include_exts)
            placeholders = ", ".join("?" for _ in sorted_include)
            filters.append(f"files.file_ext IN ({placeholders})")
            values.extend(sorted_include)
        if exclude_exts:
            sorted_exclude = sorted(exclude_exts)
            placeholders = ", ".join("?" for _ in sorted_exclude)
            filters.append(f"files.file_ext NOT IN ({placeholders})")
            values.extend(sorted_exclude)

    if created_from is not None:
        filters.append(f"{date_column} >= ?")
        values.append(resolve_local_day_start_timestamp(created_from))

    if created_to is not None:
        filters.append(f"{date_column} < ?")
        values.append(resolve_local_day_end_exclusive_timestamp(created_to))

    if not filters:
        return "1 = 1", values

    return " AND ".join(filters), values


def build_scoped_files_cte(
    *,
    normalized_target_path: str,
    search_all_enabled: bool,
    path_depth_limit: int | None,
    types: str | None,
    date_field: str = "created",
    created_from: date | None = None,
    created_to: date | None = None,
    custom_content_extensions: str = "",
    custom_filename_extensions: str = "",
    source_type: str = "local",
    resolve_default_target_paths: Callable[[str], list[str]] | None = None,
    restrict_file_ids: Sequence[int] | None = None,
    include_relative_path: bool = False,
) -> tuple[str, list[object]]:
    """
    フォルダ・階層・拡張子・日付の候補絞り込みを1回だけ行う scoped_files CTE を組み立てる。
    restrict_file_ids を渡すと、候補をその files.id だけに限定する（特定のファイルが検索条件に一致するかの確認用）。
    include_relative_path が真のときは、登録済み検索対象フォルダからの相対パスを relative_path 列として加える
    （ファイル名検索でフォルダ名も対象にするため）。
    """
    where_clause, values = build_common_filters(
        normalized_target_path=normalized_target_path,
        search_all_enabled=search_all_enabled,
        path_depth_limit=path_depth_limit,
        types=types,
        date_field=date_field,
        created_from=created_from,
        created_to=created_to,
        custom_content_extensions=custom_content_extensions,
        custom_filename_extensions=custom_filename_extensions,
        source_type=source_type,
        resolve_default_target_paths=resolve_default_target_paths,
    )
    if restrict_file_ids is not None:
        placeholders = ", ".join("?" for _ in restrict_file_ids)
        where_clause = f"({where_clause}) AND files.id IN ({placeholders})"
        values = [*values, *restrict_file_ids]
    relative_path_select = ""
    select_values: list[object] = []
    if include_relative_path:
        roots = resolve_default_target_paths(source_type) if resolve_default_target_paths else []
        expression, select_values = build_relative_path_expression(roots if source_type != "web" else [])
        relative_path_select = f"{expression} AS relative_path,"
    return (
        f"""
        WITH scoped_files AS (
            SELECT
                {relative_path_select}
                files.id,
                files.file_name,
                files.normalized_path,
                files.file_ext,
                files.created_at,
                files.mtime,
                files.click_count,
                files.obsidian_click_count,
                files.obsidian_rank_score,
                files.has_obsidian_top_tag,
                files.obsidian_title,
                files.obsidian_aliases,
                files.source_type
            FROM files
            WHERE {where_clause}
        )
        """,
        [*select_values, *values],
    )


# フォルダ名（相対パス）だけで一致した行の match_rank。
# 「他の語がファイル名・本文に一致していること」の判定（matching_files）で、パス一致だけの行を区別する。
PATH_MATCH_RANK = 5


def build_relative_path_expression(root_paths: Sequence[str]) -> tuple[str, list[object]]:
    """
    files.normalized_path から、登録済み検索対象フォルダ（最も深く一致するもの）より下の相対パスを取り出す式を返す。
    どの対象にも属さないとき（Web ページや対象外のパス）は normalized_path そのものを返す。
    """
    unique_roots = sorted({root for root in root_paths if root}, key=len, reverse=True)
    if not unique_roots:
        return "files.normalized_path", []
    branches: list[str] = []
    values: list[object] = []
    for root in unique_roots:
        prefix_start, prefix_end = get_descendant_path_range(root)
        branches.append(
            "WHEN files.normalized_path >= ? AND files.normalized_path < ? THEN substr(files.normalized_path, ?)"
        )
        values.extend([prefix_start, prefix_end, len(prefix_start) + 1])
    return f"(CASE {' '.join(branches)} ELSE files.normalized_path END)", values


def build_term_match_queries(
    expanded_include_terms: list[list[str]],
    *,
    search_body: bool,
    search_filename: bool,
    search_path: bool = False,
) -> tuple[list[str], list[object]]:
    """
    search_path が真のときは、ファイル名の一致に加えて、対象フォルダからの相対パス（relative_path 列）の
    部分一致もファイル名一致として扱う（scoped_files に relative_path 列が必要）。
    ただしパスだけで全語が一致したファイルは対象にしない（フォルダ名だけの一致はフォルダ結果として返すため）。
    少なくとも 1 語はファイル名・本文などで一致している必要がある。
    検索語ごとに「どのファイルがどの種類（本文・ファイル名・Obsidian title / alias）で一致したか」を返す
    SELECT 文の一覧と、そのプレースホルダー値を組み立てる。
    同じ OR グループの語は同じ term_index を持ち、後段で「全グループに一致したファイル」へ絞り込む。
    """
    matched_queries: list[str] = []
    query_values: list[object] = []
    for term_index, term_group in enumerate(expanded_include_terms):
        for term in term_group:
            escaped_term = search_query.escape_like_pattern(term.lower())
            if search_body and search_query.should_use_literal_term_search(term):
                matched_queries.append(
                    f"""
                    SELECT
                        scoped_files.id AS file_id,
                        {term_index} AS term_index,
                        0 AS match_rank,
                        0.0 AS score,
                        NULL AS snippet,
                        file_segments.segment_type AS segment_type,
                        file_segments.content AS body_content
                    FROM scoped_files
                    JOIN file_segments ON file_segments.file_id = scoped_files.id
                    WHERE file_segments.segment_type = 'body'
                      AND lower(file_segments.content) LIKE ? ESCAPE '\\'
                    """
                )
                query_values.append(f"%{escaped_term}%")
            elif search_body:
                body_fts_query = search_query.build_fts_content_query(search_query.quote_fts_term(term))
                matched_queries.append(
                    f"""
                    SELECT
                        scoped_files.id AS file_id,
                        {term_index} AS term_index,
                        0 AS match_rank,
                        bm25(file_segments_fts) AS score,
                        NULL AS snippet,
                        file_segments.segment_type AS segment_type,
                        file_segments.content AS body_content
                    FROM scoped_files
                    JOIN file_segments ON file_segments.file_id = scoped_files.id
                    JOIN file_segments_fts ON file_segments_fts.rowid = file_segments.id
                    WHERE file_segments.segment_type = 'body'
                      AND file_segments_fts MATCH ?
                    """
                )
                query_values.append(body_fts_query)

                cjk_bigram_query = build_cjk_bigram_match_query(term)
                if cjk_bigram_query is not None:
                    cjk_bigram_query = search_query.build_fts_content_query(cjk_bigram_query)
                    matched_queries.append(
                        f"""
                        SELECT
                            scoped_files.id AS file_id,
                            {term_index} AS term_index,
                            1 AS match_rank,
                            bm25(file_segments_fts) AS score,
                            NULL AS snippet,
                            file_segments.segment_type AS segment_type,
                            body_segments.content AS body_content
                        FROM scoped_files
                        JOIN file_segments ON file_segments.file_id = scoped_files.id
                        JOIN file_segments_fts ON file_segments_fts.rowid = file_segments.id
                        JOIN file_segments AS body_segments
                          ON body_segments.file_id = scoped_files.id
                         AND body_segments.segment_type = 'body'
                        WHERE file_segments.segment_type = 'cjk_bigram'
                          AND file_segments_fts MATCH ?
                        """
                    )
                    query_values.append(cjk_bigram_query)

            if search_filename:
                if search_query.should_use_filename_fts(term):
                    matched_queries.append(
                        f"""
                        SELECT
                            scoped_files.id AS file_id,
                            {term_index} AS term_index,
                            2 AS match_rank,
                            1000000.0 AS score,
                            NULL AS snippet,
                            'filename' AS segment_type,
                            body_segments.content AS body_content
                        FROM scoped_files
                        JOIN files_name_fts ON files_name_fts.rowid = scoped_files.id
                        LEFT JOIN file_segments AS body_segments
                          ON body_segments.file_id = scoped_files.id
                         AND body_segments.segment_type = 'body'
                        WHERE files_name_fts MATCH ?
                        """
                    )
                    query_values.append(search_query.quote_fts_term(term))
                else:
                    matched_queries.append(
                        f"""
                        SELECT
                            scoped_files.id AS file_id,
                            {term_index} AS term_index,
                            2 AS match_rank,
                            1000000.0 AS score,
                            NULL AS snippet,
                            'filename' AS segment_type,
                            body_segments.content AS body_content
                        FROM scoped_files
                        LEFT JOIN file_segments AS body_segments
                          ON body_segments.file_id = scoped_files.id
                         AND body_segments.segment_type = 'body'
                        WHERE lower(scoped_files.file_name) LIKE ? ESCAPE '\\'
                        """
                    )
                    query_values.append(f"%{escaped_term}%")

                if search_path:
                    matched_queries.append(
                        f"""
                        SELECT
                            scoped_files.id AS file_id,
                            {term_index} AS term_index,
                            {PATH_MATCH_RANK} AS match_rank,
                            1000000.0 AS score,
                            NULL AS snippet,
                            'filename' AS segment_type,
                            body_segments.content AS body_content
                        FROM scoped_files
                        LEFT JOIN file_segments AS body_segments
                          ON body_segments.file_id = scoped_files.id
                         AND body_segments.segment_type = 'body'
                        WHERE lower(scoped_files.relative_path) LIKE ? ESCAPE '\\'
                        """
                    )
                    query_values.append(f"%{escaped_term}%")

                for metadata_column, segment_type, match_rank in (
                    ("obsidian_title", "obsidian_title", 3),
                    ("obsidian_aliases", "obsidian_alias", 4),
                ):
                    matched_queries.append(
                        f"""
                        SELECT
                            scoped_files.id AS file_id,
                            {term_index} AS term_index,
                            {match_rank} AS match_rank,
                            1000000.0 AS score,
                            NULL AS snippet,
                            '{segment_type}' AS segment_type,
                            body_segments.content AS body_content
                        FROM scoped_files
                        LEFT JOIN file_segments AS body_segments
                          ON body_segments.file_id = scoped_files.id
                         AND body_segments.segment_type = 'body'
                        WHERE lower(scoped_files.{metadata_column}) LIKE ? ESCAPE '\\'
                        """
                    )
                    query_values.append(f"%{escaped_term}%")
    return matched_queries, query_values


def build_matched_files_cte(
    *,
    scoped_files_cte_sql: str,
    matched_queries: list[str],
    expanded_include_terms: list[list[str]],
) -> str:
    """
    一致行（matched_terms）から、全 OR グループに一致したファイルを選び、ファイル名一致レベルと
    関連度バケットを付けた `filtered` までの共通 CTE を返す。
    """
    matched_files_cte = f"""
        {scoped_files_cte_sql},
        query_affinity AS (
            SELECT
                file_id,
                (1.0 * click_count / (click_count + 2.0))
                * (1.0 / (1.0 + MAX(strftime('%s', 'now') - strftime('%s', last_clicked_at), 0.0) / 2592000.0))
                AS query_click_score
            FROM search_query_clicks
            WHERE normalized_query = ?
        ),
        matched_terms AS (
            {" UNION ALL ".join(matched_queries)}
        ),
        matching_files AS (
            SELECT
                matched_terms.file_id,
                CASE
                    WHEN COUNT(DISTINCT CASE WHEN segment_type = 'filename' THEN term_index END) = {len(expanded_include_terms)}
                         AND lower(substr(scoped_files.file_name, 1, length(scoped_files.file_name) - length(scoped_files.file_ext))) = ?
                    THEN 8
                    WHEN COUNT(DISTINCT CASE WHEN segment_type = 'filename' THEN term_index END) = {len(expanded_include_terms)}
                         AND lower(scoped_files.file_name) LIKE ? ESCAPE '\\'
                    THEN 7
                    WHEN COUNT(DISTINCT CASE WHEN segment_type = 'filename' THEN term_index END) = {len(expanded_include_terms)}
                    THEN 6
                    WHEN COUNT(DISTINCT CASE WHEN segment_type = 'obsidian_title' THEN term_index END) = {len(expanded_include_terms)}
                         AND lower(scoped_files.obsidian_title) = ?
                    THEN 5
                    WHEN COUNT(DISTINCT CASE WHEN segment_type = 'obsidian_title' THEN term_index END) = {len(expanded_include_terms)}
                    THEN 4
                    WHEN COUNT(DISTINCT CASE WHEN segment_type = 'obsidian_alias' THEN term_index END) = {len(expanded_include_terms)}
                    THEN 3
                    WHEN COUNT(DISTINCT CASE WHEN segment_type = 'filename' THEN term_index END) > 0
                    THEN 2
                    WHEN COUNT(DISTINCT CASE WHEN segment_type IN ('obsidian_title', 'obsidian_alias') THEN term_index END) > 0
                    THEN 1
                    ELSE 0
                END AS filename_match_level
            FROM matched_terms
            JOIN scoped_files ON scoped_files.id = matched_terms.file_id
            GROUP BY matched_terms.file_id
            HAVING COUNT(DISTINCT term_index) = {len(expanded_include_terms)}
               AND COUNT(CASE WHEN matched_terms.match_rank != {PATH_MATCH_RANK} THEN 1 END) > 0
        ),
        ranked_matches AS (
            SELECT
                matched_terms.file_id,
                matched_terms.match_rank,
                matched_terms.score,
                matched_terms.snippet,
                matched_terms.segment_type,
                matched_terms.body_content,
                matching_files.filename_match_level,
                ROW_NUMBER() OVER (
                    PARTITION BY matched_terms.file_id
                    ORDER BY matched_terms.match_rank, matched_terms.score, matched_terms.file_id
                ) AS rn
            FROM matched_terms
            JOIN matching_files ON matching_files.file_id = matched_terms.file_id
        ),
        filtered AS (
            SELECT
                ranked_matches.*,
                11 - CAST(
                    CUME_DIST() OVER (ORDER BY match_rank, score) * 10 + 0.999999
                    AS INTEGER
                ) AS relevance_bucket
            FROM ranked_matches
            WHERE rn = 1
        )
    """
    return matched_files_cte


def build_order_by_clause(*, sort_by: str, sort_order: str, table_alias: str = "files") -> str:
    """
    FTS 検索は一致品質を優先しつつ、同順位内で指定列へ並び替える。
    """
    if sort_by == "default":
        return f"filtered.filename_match_level DESC, {table_alias}.has_obsidian_top_tag DESC, query_click_score DESC, filtered.relevance_bucket DESC, {build_utility_score_expression(table_alias)} DESC, {table_alias}.mtime DESC, {table_alias}.id DESC"
    direction = "ASC" if sort_order == "asc" else "DESC"
    sort_column = resolve_sort_column(sort_by, table_alias=table_alias)
    return f"filtered.match_rank, filtered.score, {table_alias}.obsidian_rank_score DESC, {sort_column} {direction}, {table_alias}.id DESC"


def build_paged_order_by_clause(*, sort_by: str, sort_order: str, table_alias: str) -> str:
    """
    ページング CTE の結果を、内部 LIMIT 適用時と同じ優先順位で返す。
    """
    if sort_by == "default":
        return f"{table_alias}.filename_match_level DESC, {table_alias}.has_obsidian_top_tag DESC, {table_alias}.query_click_score DESC, {table_alias}.relevance_bucket DESC, {table_alias}.utility_score DESC, {table_alias}.mtime DESC, {table_alias}.file_id DESC"
    direction = "ASC" if sort_order == "asc" else "DESC"
    sort_column = resolve_sort_column(sort_by, table_alias=table_alias)
    return f"{table_alias}.match_rank, {table_alias}.score, {table_alias}.obsidian_rank_score DESC, {sort_column} {direction}, {table_alias}.file_id DESC"


def build_scan_order_by_clause(*, sort_by: str, sort_order: str, table_alias: str = "files") -> str:
    """
    正規表現検索は DB 側で指定列順に走査し、結果の表示順と一致させる。
    """
    if sort_by == "default":
        return f"{table_alias}.has_obsidian_top_tag DESC, ({table_alias}.click_count + {table_alias}.obsidian_click_count) DESC, {table_alias}.mtime DESC, {table_alias}.id DESC"
    direction = "ASC" if sort_order == "asc" else "DESC"
    sort_column = resolve_sort_column(sort_by, table_alias=table_alias)
    return f"{table_alias}.obsidian_rank_score DESC, {sort_column} {direction}, {table_alias}.id DESC"


def resolve_sort_column(sort_by: str, *, table_alias: str = "files") -> str:
    """
    並び替えキーを SQL の安全な固定列へ解決する。
    """
    if sort_by == "created":
        return f"{table_alias}.created_at"
    if sort_by == "click_count":
        return f"({table_alias}.click_count + {table_alias}.obsidian_click_count)"
    return f"{table_alias}.mtime"


def build_utility_score_expression(table_alias: str) -> str:
    """
    アクセス数を飽和させ、Obsidian重要度と90日半減相当の更新鮮度を合成する。
    """
    clicks = f"({table_alias}.click_count + {table_alias}.obsidian_click_count)"
    popularity = f"(1.0 * {clicks} / ({clicks} + 10.0))"
    obsidian_importance = f"MIN(MAX({table_alias}.obsidian_rank_score / 1000.0, 0.0), 1.0)"
    recency = f"(1.0 / (1.0 + MAX(strftime('%s', 'now') - {table_alias}.mtime, 0.0) / 7776000.0))"
    return f"(0.55 * {popularity} + 0.25 * {obsidian_importance} + 0.20 * {recency})"


def build_folder_path_sql_expression(table_alias: str) -> str:
    """
    SQL 上で、ファイル自身を除いた親フォルダーパス部分を取り出す。
    """
    return (
        f"rtrim(substr({table_alias}.normalized_path, 1, "
        f"length({table_alias}.normalized_path) - length({table_alias}.file_name)), '/')"
    )


def resolve_local_day_start_timestamp(value: date) -> float:
    """
    日付フィルタの開始境界はローカルタイムゾーンの 00:00:00 を使う。
    """
    return datetime.combine(value, time.min).astimezone().timestamp()


def resolve_local_day_end_exclusive_timestamp(value: date) -> float:
    """
    終了日はその翌日の 00:00:00 未満として inclusive に扱う。
    """
    next_day = value + timedelta(days=1)
    return datetime.combine(next_day, time.min).astimezone().timestamp()
