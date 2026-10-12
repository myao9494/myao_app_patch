"""
キーワード検索の入口。

検索の流れ:
1. 検索対象のインデックスが古ければ更新する（search_refresh）。既存インデックスがあれば検索は待たせない。
2. 通常検索（fts_search）または正規表現検索（regex_search）を実行する。
3. 検索の完了後、Obsidian の利用状況をバックグラウンドで取り込む（obsidian_access_sync）。

gantt タスクの検索（gantt_search）は、インデックスを使わず gantt アプリへ問い合わせる。
利用者の入力は FTS5 の構文としてではなく、通常の検索語として安全に扱う。
ベクトル検索・ハイブリッド検索の振り分けは search_dispatcher が行う。
"""

from __future__ import annotations

import logging
import time as time_module
from collections.abc import Sequence
from dataclasses import dataclass
from sqlite3 import Connection

from fastapi import HTTPException, status

from app.db.connection import get_connection
from app.models.indexing import AppSettingsResponse
from app.models.search import IndexedSearchRequest, SearchQueryParams, SearchResponse
from app.services import (
    exclude_rules,
    fts_search,
    gantt_search,
    obsidian_access_sync,
    regex_search,
    search_query,
    search_result_items,
    web_pages,
)
from app.services.index_service import UNLIMITED_INDEX_DEPTH, IndexService
from app.services.path_service import normalize_path_str
from app.services.search_refresh import SearchRefresher

# gantt タスクと統合するとき、並び替えのために各検索から読み込む最大件数
GANTT_MERGE_FETCH_LIMIT = 1000
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _SearchScope:
    """検索 1 回分の対象範囲（対象パス・除外キーワード・階層数）。"""

    normalized_target_path: str
    exclude_keywords: str
    index_depth: int


class SearchService:
    """全文検索・ファイル名検索・フォルダ名検索をまとめて提供する。"""

    def __init__(self, connection: Connection | None = None) -> None:
        self.connection = connection or get_connection()
        self.index_service = IndexService(connection=self.connection)
        self.refresher = SearchRefresher(self.index_service)

    def search(self, params: SearchQueryParams) -> SearchResponse:
        """
        必要ならインデックスを更新してから検索する。
        全DB検索（search_all_enabled）と skip_refresh のときは、インデックスを更新しない。
        """
        app_settings = self.index_service.get_app_settings()
        if params.source_type == "gantt":
            return gantt_search.search_gantt_tasks(params, synonym_groups=app_settings.synonym_groups)
        if params.include_gantt_tasks:
            return self._search_with_gantt_tasks(params, synonym_groups=app_settings.synonym_groups)

        scope = self._resolve_scope(params, app_settings)
        normalized_target_path = scope.normalized_target_path
        effective_exclude_keywords = scope.exclude_keywords
        index_depth = scope.index_depth

        refresh_flags = {"used_existing_index": False, "background_refresh_scheduled": False}
        if not params.search_all_enabled and not params.skip_refresh:
            if normalized_target_path:
                refresh_flags = self.refresher.refresh_target(
                    normalized_target_path=normalized_target_path,
                    refresh_window_minutes=params.refresh_window_minutes,
                    effective_exclude_keywords=effective_exclude_keywords,
                    index_depth=index_depth,
                    index_types=params.index_types,
                    custom_content_extensions=app_settings.custom_content_extensions,
                    custom_filename_extensions=app_settings.custom_filename_extensions,
                )
            else:
                self.refresher.refresh_registered_targets(
                    refresh_window_minutes=params.refresh_window_minutes,
                    effective_exclude_keywords=effective_exclude_keywords,
                    index_depth=index_depth,
                    index_types=params.index_types,
                    custom_content_extensions=app_settings.custom_content_extensions,
                    custom_filename_extensions=app_settings.custom_filename_extensions,
                    source_type=params.source_type,
                )

        start_time = time_module.perf_counter()
        response = self._execute_search(
            params=params,
            normalized_target_path=normalized_target_path,
            excluded_keywords=exclude_rules.parse_exclude_keywords(effective_exclude_keywords),
            app_settings=app_settings,
            path_depth_limit=index_depth,
        )
        elapsed = time_module.perf_counter() - start_time
        logger.info("Search total time: %.3fs (q=%s, search_all=%s)", elapsed, params.q, params.search_all_enabled)

        obsidian_access_sync.schedule_obsidian_access_sync(app_settings.obsidian_sidebar_explorer_data_path)
        return response.model_copy(update=refresh_flags)

    def _resolve_scope(self, params: SearchQueryParams, app_settings: AppSettingsResponse) -> _SearchScope:
        """リクエストと保存済みの設定から、検索の対象範囲を決める。"""
        normalized_target_path = ""
        if params.full_path:
            normalized_target_path = (
                web_pages.normalize_web_url(params.full_path)
                if params.source_type == "web"
                else normalize_path_str(params.full_path)
            )
        default_exclude_keywords = (
            app_settings.web_exclude_keywords if params.source_type == "web" else app_settings.exclude_keywords
        )
        return _SearchScope(
            normalized_target_path=normalized_target_path,
            exclude_keywords=(
                params.exclude_keywords if params.exclude_keywords is not None else default_exclude_keywords
            ),
            index_depth=params.index_depth if params.index_depth is not None else UNLIMITED_INDEX_DEPTH,
        )

    def _search_with_gantt_tasks(self, params: SearchQueryParams, *, synonym_groups: str) -> SearchResponse:
        """
        通常検索の結果に gantt タスク検索結果を追加し、同じ並び替え・ページングで返す。
        """
        fetch_all = {"limit": GANTT_MERGE_FETCH_LIMIT, "offset": 0}
        base_response = self.search(params.model_copy(update={"include_gantt_tasks": False, **fetch_all}))
        gantt_response = gantt_search.search_gantt_tasks(
            params.model_copy(update=fetch_all), synonym_groups=synonym_groups
        )
        merged_items = search_result_items.sort_search_result_items(
            [*base_response.items, *gantt_response.items],
            sort_by=params.sort_by,
            sort_order=params.sort_order,
        )
        return search_result_items.paginate_search_items(merged_items, params).model_copy(
            update={
                "used_existing_index": base_response.used_existing_index,
                "background_refresh_scheduled": base_response.background_refresh_scheduled,
            }
        )

    def search_existing_index(self, params: IndexedSearchRequest) -> SearchResponse:
        """
        既存 DB だけを使って検索する。
        対象フォルダ配下を深さ無制限で絞り込むが、インデックス更新は行わない。
        """
        app_settings = self.index_service.get_app_settings()
        return self._execute_search(
            params=_to_existing_index_query(params),
            normalized_target_path=normalize_path_str(params.folder_path) if params.folder_path else "",
            excluded_keywords=exclude_rules.parse_exclude_keywords(app_settings.exclude_keywords),
            app_settings=app_settings,
            path_depth_limit=None,
        )

    def find_matching_file_ids(
        self, params: SearchQueryParams | IndexedSearchRequest, file_ids: Sequence[int]
    ) -> set[int]:
        """
        file_ids（files.id）のうち、params のキーワード検索に一致するものを返す。
        search / search_existing_index と同じ条件で判定し、インデックスは更新しない。
        ハイブリッド検索が、取得済みのページの外にあるキーワード結果との重なりを数えるために使う。
        """
        if not file_ids:
            return set()
        app_settings = self.index_service.get_app_settings()
        if isinstance(params, IndexedSearchRequest):
            query_params = _to_existing_index_query(params)
            normalized_target_path = normalize_path_str(params.folder_path) if params.folder_path else ""
            exclude_keywords = app_settings.exclude_keywords
            path_depth_limit = None
        else:
            if params.source_type == "gantt":
                return set()
            scope = self._resolve_scope(params, app_settings)
            query_params = params
            normalized_target_path = scope.normalized_target_path
            exclude_keywords = scope.exclude_keywords
            path_depth_limit = scope.index_depth
        response = self._execute_search(
            params=query_params.model_copy(update={"offset": 0, "limit": len(file_ids), "include_snippets": False}),
            normalized_target_path=normalized_target_path,
            excluded_keywords=exclude_rules.parse_exclude_keywords(exclude_keywords),
            app_settings=app_settings,
            path_depth_limit=path_depth_limit,
            restrict_file_ids=file_ids,
        )
        return {item.file_id for item in response.items if item.result_kind == "file"}

    def _execute_search(
        self,
        *,
        params: SearchQueryParams,
        normalized_target_path: str,
        excluded_keywords: list[str],
        app_settings: AppSettingsResponse,
        path_depth_limit: int | None,
        restrict_file_ids: Sequence[int] | None = None,
    ) -> SearchResponse:
        """通常検索（FTS）か正規表現検索かを選んで実行する。"""
        search = regex_search.search_with_regex if params.regex_enabled else fts_search.search_with_fts
        return search(
            self.connection,
            params=params,
            normalized_target_path=normalized_target_path,
            excluded_keywords=excluded_keywords,
            app_settings=app_settings,
            path_depth_limit=path_depth_limit,
            resolve_default_target_paths=lambda source_type: self.index_service.list_search_scope_paths(
                source_type=source_type
            ),
            restrict_file_ids=restrict_file_ids,
        )

    def record_click(self, file_id: int, query: str = "") -> int:
        """
        検索結果を開いたときのアクセス数を 1 件加算して返す。
        検索語があれば、その検索語で開かれた回数も記録する（同じ検索語での順位付けに使う）。
        """
        row = self.connection.execute(
            """
            UPDATE files
            SET click_count = click_count + 1
            WHERE id = ?
            RETURNING click_count
            """,
            (file_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="検索結果が見つかりません。")
        normalized_query = search_query.normalize_query_for_history(query)
        if normalized_query:
            self.connection.execute(
                """
                INSERT INTO search_query_clicks(normalized_query, file_id, click_count, last_clicked_at)
                VALUES (?, ?, 1, CURRENT_TIMESTAMP)
                ON CONFLICT(normalized_query, file_id) DO UPDATE SET
                    click_count = click_count + 1,
                    last_clicked_at = CURRENT_TIMESTAMP
                """,
                (normalized_query, file_id),
            )
        self.connection.commit()
        return int(row["click_count"])

    def open_gantt_task_input(self, task_id: int) -> None:
        """gantt アプリの入力画面を、開いているガント画面上で表示する。"""
        gantt_search.open_gantt_task_input(task_id)


def _to_existing_index_query(params: IndexedSearchRequest) -> SearchQueryParams:
    """既存DB検索のリクエストを、全DB・深さ無制限・更新なしの検索条件へ変換する。"""
    return SearchQueryParams(
        q=params.q,
        full_path=params.folder_path,
        search_all_enabled=True,
        index_depth=0,
        refresh_window_minutes=0,
        limit=params.limit,
        offset=params.offset,
        types=params.types,
        source_type=params.source_type,
    )
