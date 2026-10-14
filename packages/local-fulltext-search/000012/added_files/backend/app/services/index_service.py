"""
インデックス更新の入口。API・検索前更新・変更追跡・スケジューラーから呼ばれる。

ここは「いつ・どの条件で走査するか」を決めるだけで、実際の処理は次の部品へ任せる。
- index_run_state     : 実行中フラグと中止要求（index_runs テーブル）
- search_target_store : 検索対象の登録と更新要否の判定（targets テーブル）
- indexed_file_store  : インデックス済みファイルの読み書き（files / file_segments / failed_files テーブル）
- local_target_indexer: ローカルフォルダの走査と本文抽出
- web_target_indexer  : Web ページの巡回
- index_cleanup       : 検索ルール変更で対象外になったファイルの掃除
- app_settings_store  : 設定ファイルの読み書き
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from sqlite3 import Connection

from fastapi import HTTPException, status

from app.db.connection import get_connection
from app.db.schema import reclaim_free_pages, reset_schema
from app.models.indexing import (
    AppSettingsResponse,
    DeleteIndexedFoldersResponse,
    DeleteSearchTargetsResponse,
    FailedFileListResponse,
    IndexedTargetListResponse,
    IndexStatusResponse,
    ReindexSearchTargetsResponse,
    SearchTargetCoverageResponse,
    SearchTargetListResponse,
    SynonymEntryItem,
    SynonymListResponse,
)
from app.services import app_settings_store, exclude_rules, index_cleanup, index_scope
from app.services.app_settings_store import AppSettingsStore
from app.services.index_run_state import (
    IndexAlreadyRunningError,
    IndexingCancelledError,
    IndexRunState,
    TargetIndexResult,
)
from app.services.indexed_file_store import IndexedFileStore
from app.services.local_target_indexer import LocalTargetIndexer
from app.services.search_target_store import SearchTargetStore, normalize_target_identifier_or_raise
from app.services.web_target_indexer import WebTargetIndexer

# 階層数が未指定（無制限）のときに使う値
UNLIMITED_INDEX_DEPTH = 99999
logger = logging.getLogger(__name__)


class IndexService:
    def __init__(
        self,
        connection: Connection | None = None,
        enable_vector_sync: bool | None = None,
    ) -> None:
        """
        connection を渡さないときは既定の検索DBへ接続する。
        ベクトルインデックスの連動更新は、明示されていればその値に従う。未指定なら、既定の接続のときだけ行う
        （接続を差し替えるユニットテスト等で、意図せずベクトル側を更新しないため）。
        """
        self.connection = connection or get_connection()
        self.run_state = IndexRunState(self.connection)
        self.targets = SearchTargetStore(self.connection)
        self.files = IndexedFileStore(self.connection)
        self.settings_store = AppSettingsStore(self._read_legacy_exclude_keywords_from_db)
        self.local_indexer = LocalTargetIndexer(self.files, self.run_state)
        self._vector_sync_enabled = enable_vector_sync if enable_vector_sync is not None else connection is None
        self.web_indexer = WebTargetIndexer(self.files, self.run_state)

    # ------------------------------------------------------------------ 実行状態

    def is_running(self) -> bool:
        """インデックス処理が実行中かを返す。"""
        return self.run_state.is_running()

    def get_status(self) -> IndexStatusResponse:
        return self.run_state.get_status()

    def cancel_indexing(self) -> None:
        """実行中インデックスへ中止要求を送る。"""
        self.run_state.request_cancel()

    def recover_interrupted_indexing(self) -> bool:
        """前回プロセスの終了で残った実行中状態を、起動時に安全に解除する。"""
        return self.run_state.recover_interrupted()

    def reset_database(self) -> None:
        """
        インデックス DB を空の初期状態へ戻す。
        検索結果・対象キャッシュ・失敗履歴をすべて削除し、スキーマだけを再作成する。
        """
        self._raise_if_running()
        reset_schema(self.connection)

    def _raise_if_running(self) -> None:
        if self.run_state.is_running():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Indexing is already running.")

    # ------------------------------------------------------------------ 走査

    def ensure_fresh_target(
        self,
        *,
        full_path: str,
        refresh_window_minutes: int,
        exclude_keywords: str | None = None,
        index_depth: int | None = 1,
        types: str | None = None,
        retry_failed_files: bool = False,
    ) -> None:
        """
        指定パス（フォルダまたは Web URL）のインデックスが古ければ走査し直す。
        - 有効な検索対象の配下が指定されたときは、その検索対象の条件で配下だけを走査する（部分更新）。
        - 条件（除外キーワード・階層・拡張子）が前回と同じで、更新間隔内かつ変更通知も無ければ何もしない。
        - 別の走査が実行中なら 409 を返す。
        """
        self._raise_if_running()

        normalized_full_path, source_type = normalize_target_identifier_or_raise(full_path)
        self.targets.assert_indexing_allowed(normalized_full_path, source_type=source_type)
        effective_full_path = (
            self.targets.resolve_enabled_covering_path(normalized_full_path, source_type=source_type)
            or normalized_full_path
        )
        is_partial_target_refresh = normalized_full_path != effective_full_path
        effective_depth = index_depth if index_depth is not None else UNLIMITED_INDEX_DEPTH
        scan_depth = effective_depth + index_scope.relative_directory_depth(effective_full_path, normalized_full_path)
        app_settings = self.get_app_settings()
        default_exclude_keywords = (
            app_settings.web_exclude_keywords if source_type == "web" else app_settings.exclude_keywords
        )
        normalized_keywords = app_settings_store.normalize_exclude_keywords(
            exclude_keywords if exclude_keywords is not None else default_exclude_keywords
        )
        normalized_extensions = self._resolve_scan_extensions(types, app_settings)

        total_files = 0
        error_count = 0
        try:
            target = self.targets.ensure_target(
                full_path=effective_full_path,
                exclude_keywords=normalized_keywords,
                index_depth=effective_depth,
                selected_extensions=normalized_extensions,
            )
            effective_keywords = exclude_rules.merge_exclude_keyword_strings(
                normalized_keywords,
                str(target.get("exclude_keywords") or ""),
            )
            if not self.targets.needs_refresh(
                target,
                refresh_window_minutes,
                effective_keywords,
                effective_depth,
                normalized_extensions,
            ):
                return

            self.run_state.controller.reset()
            if not self.run_state.try_begin(started_at=datetime.now(UTC).isoformat()):
                raise IndexAlreadyRunningError()

            result = self._index_target(
                target,
                effective_keywords,
                app_settings,
                index_depth=scan_depth,
                cleanup_root_path=normalized_full_path,
                cleanup_index_depth=index_depth,
                selected_extensions=normalized_extensions,
                retry_failed_files=retry_failed_files,
            )
            total_files = result.file_count
            error_count = result.error_count
            if not is_partial_target_refresh:
                self.targets.mark_indexed(
                    int(target["id"]),
                    exclude_keywords=result.exclude_keywords,
                    index_depth=index_depth,
                    selected_extensions=normalized_extensions,
                    indexed_file_count=total_files,
                )
        except IndexAlreadyRunningError as error:
            # 別の契機が先に走査を開始した。実行中フラグはその走査のものなので、ここでは触らない。
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Indexing is already running.") from error
        except IndexingCancelledError as error:
            self._finish_run(total_files=total_files, error_count=error_count, last_error=None)
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        except Exception as error:
            self._finish_run(total_files=total_files, error_count=error_count + 1, last_error=str(error))
            raise

        self._finish_run(total_files=total_files, error_count=error_count, last_error=None)
        if source_type == "local":
            self._sync_vector_index(effective_full_path, exclude_keywords=result.exclude_keywords, index_depth=scan_depth)

    def _sync_vector_index(self, folder_path: str, *, exclude_keywords: str, index_depth: int) -> None:
        """
        走査したフォルダのベクトルインデックスを、全文インデックスと同じ範囲で差分更新する。
        Embedding の生成は時間がかかるため、「インデックス実行中」を解除したあとに行う
        （その間も、他のフォルダの再インデックス要求を受け付けられる）。
        """
        if not self._vector_sync_enabled:
            return
        try:
            from app.vector.state import vector_state

            vector_state.sync_index(
                [folder_path],
                force=False,
                exclude_keywords=exclude_keywords,
                folder_depths={folder_path: index_depth},
            )
        except Exception as error:
            # ベクトル同期の失敗で全文インデックスの結果を失わせない。次回の走査で再試行される。
            logger.warning("Vector index sync failed for %s: %s", folder_path, error)

    def _resolve_scan_extensions(self, types: str | None, app_settings: AppSettingsResponse) -> str:
        """
        今回の走査で対象にする拡張子を決める。
        指定された拡張子のうち、検索ルールで有効な拡張子だけを残す。1 つも残らなければ有効な拡張子すべてを使う。
        """
        requested_types = types if types is not None and types.strip() else app_settings.index_selected_extensions
        normalized_extensions = app_settings_store.normalize_selected_extensions(
            requested_types,
            custom_content_extensions=app_settings.custom_content_extensions,
            custom_filename_extensions=app_settings.custom_filename_extensions,
        )
        allowed_extensions = set(app_settings_store.parse_extension_entries(app_settings.index_selected_extensions))
        if not allowed_extensions:
            return normalized_extensions
        requested_extensions = set(app_settings_store.parse_extension_entries(normalized_extensions))
        return "\n".join(sorted(requested_extensions & allowed_extensions or allowed_extensions))

    def _index_target(
        self,
        target: dict[str, object],
        exclude_keywords: str,
        app_settings: AppSettingsResponse,
        *,
        index_depth: int,
        cleanup_root_path: str,
        cleanup_index_depth: int | None,
        selected_extensions: str,
        retry_failed_files: bool,
    ) -> TargetIndexResult:
        """検索対象の種類（Web / ローカル）に応じた走査を行う。"""
        if str(target.get("source_type") or "local") == "web":
            return self.web_indexer.index(
                target,
                exclude_keywords,
                index_depth=index_depth,
                fetch_mode=app_settings.web_fetch_mode,
            )
        return self.local_indexer.index(
            target,
            exclude_keywords,
            index_depth=index_depth,
            cleanup_root_path=cleanup_root_path,
            cleanup_index_depth=cleanup_index_depth,
            selected_extensions=selected_extensions,
            custom_content_extensions=app_settings.custom_content_extensions,
            custom_filename_extensions=app_settings.custom_filename_extensions,
            retry_failed_files=retry_failed_files,
        )

    def _finish_run(self, *, total_files: int, error_count: int, last_error: str | None) -> None:
        """実行中フラグを下ろし、走査結果を記録する。"""
        self.run_state.update(
            is_running=False,
            cancel_requested=False,
            last_finished_at=datetime.now(UTC).isoformat(),
            total_files=total_files,
            error_count=error_count,
            last_error=last_error,
        )

    def reindex_search_targets(self, folder_paths: list[str]) -> ReindexSearchTargetsResponse:
        """
        指定した検索対象を順に再インデックスする。有効な検索対象として登録されていないパスは飛ばす。
        利用者が明示的に実行した操作なので、最近失敗したファイルも再試行する。
        """
        self._raise_if_running()
        reindexed_count = 0
        for folder_path in folder_paths:
            normalized_folder_path, source_type = normalize_target_identifier_or_raise(folder_path)
            scan_settings = self.targets.get_enabled_scan_settings(normalized_folder_path, source_type=source_type)
            if scan_settings is None:
                continue
            index_depth, selected_extensions = scan_settings
            self.ensure_fresh_target(
                full_path=normalized_folder_path,
                refresh_window_minutes=0,
                index_depth=index_depth,
                types=selected_extensions,
                retry_failed_files=True,
            )
            reindexed_count += 1
        return ReindexSearchTargetsResponse(reindexed_count=reindexed_count)

    # ------------------------------------------------------------------ 設定

    def get_app_settings(self) -> AppSettingsResponse:
        """アプリ全体で共有する設定値を返す。"""
        return self.settings_store.load()

    def get_synonyms(self) -> SynonymListResponse:
        """構造化された同義語リストを返す。"""
        synonym_text = self.settings_store.read_synonym_groups()
        return SynonymListResponse(
            groups=app_settings_store.parse_synonym_groups(synonym_text),
            entries=[
                SynonymEntryItem(terms=entry["terms"], description=entry["description"])
                for entry in app_settings_store.parse_synonym_entries(synonym_text)
            ],
        )

    def update_app_settings(
        self,
        *,
        exclude_keywords: str | None = None,
        web_exclude_keywords: str | None = None,
        web_fetch_mode: str | None = None,
        hidden_indexed_targets: str | None = None,
        synonym_groups: str | None = None,
        obsidian_sidebar_explorer_data_path: str | None = None,
        gantt_parent: int | None = None,
        launcher_hotkey: str | None = None,
        index_selected_extensions: str | None = None,
        custom_content_extensions: str | None = None,
        custom_filename_extensions: str | None = None,
        confirm_index_deletion: bool | None = None,
        clean_excluded_files: bool = False,
    ) -> AppSettingsResponse:
        """
        アプリ全体で共有する設定値を更新し、保存後の値を返す。None の項目は変更しない。
        - 除外キーワードを変えたときは、登録済みのローカル検索対象へ反映し、除外に合致する既存インデックスを消す。
        - 対象拡張子を変えたときは、登録済みのローカル検索対象へ反映する。
          対象外になった拡張子の既存インデックスを消すのは clean_excluded_files=True のときだけ。
        """
        current = self.get_app_settings()
        updated = app_settings_store.merge_app_settings(
            current,
            exclude_keywords=exclude_keywords,
            web_exclude_keywords=web_exclude_keywords,
            web_fetch_mode=web_fetch_mode,
            hidden_indexed_targets=hidden_indexed_targets,
            synonym_groups=synonym_groups,
            obsidian_sidebar_explorer_data_path=obsidian_sidebar_explorer_data_path,
            gantt_parent=gantt_parent,
            launcher_hotkey=launcher_hotkey,
            index_selected_extensions=index_selected_extensions,
            custom_content_extensions=custom_content_extensions,
            custom_filename_extensions=custom_filename_extensions,
            confirm_index_deletion=confirm_index_deletion,
        )
        if exclude_keywords is not None:
            self.targets.sync_exclude_keywords(
                old_global_keywords=current.exclude_keywords,
                new_global_keywords=updated.exclude_keywords,
            )
            index_cleanup.cleanup_excluded_keyword_files(self.files, new_exclude_keywords=updated.exclude_keywords)
        if index_selected_extensions is not None:
            self.targets.sync_selected_extensions(new_selected_extensions=updated.index_selected_extensions)
            if clean_excluded_files:
                index_cleanup.cleanup_excluded_extension_files(
                    self.files,
                    allowed_extensions_text=updated.index_selected_extensions,
                )

        self.settings_store.save(updated)
        self._reload_vector_glossary()
        return updated

    def _reload_vector_glossary(self) -> None:
        """類似語の変更を、ベクトル検索のクエリ展開へ反映する。失敗しても設定の保存は成功として扱う。"""
        try:
            from app.vector.state import vector_state

            vector_state.reload_glossary()
        except Exception:
            logger.warning("Failed to reload the vector search glossary.", exc_info=True)

    def _read_legacy_exclude_keywords_from_db(self) -> str | None:
        """
        以前の SQLite 保存方式から 1 回だけ値を移行するための後方互換読み込み。
        """
        table_exists = self.connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'"
        ).fetchone()
        if table_exists is None:
            return None
        row = self.connection.execute("SELECT exclude_keywords FROM app_settings WHERE id = 1").fetchone()
        if row is None:
            return None
        return str(row["exclude_keywords"])

    # ------------------------------------------------------------------ 検索対象

    def list_search_targets(self) -> SearchTargetListResponse:
        """検索対象の一覧を返す。インデックス対象として有効かどうかも含める。"""
        return self.targets.list_all()

    def list_search_scope_paths(self, *, source_type: str = "local") -> list[str]:
        """フォルダ未指定の検索で対象にするパス一覧を返す（有効な検索対象。無ければ登録済みすべて）。"""
        return self.targets.list_search_scope_paths(source_type=source_type)

    def get_search_target_coverage(self, *, folder_path: str) -> SearchTargetCoverageResponse:
        """指定パスが有効な検索対象でカバーされるか判定する。"""
        normalized_path, source_type = normalize_target_identifier_or_raise(folder_path)
        covering_path = self.targets.resolve_enabled_covering_path(normalized_path, source_type=source_type)
        return SearchTargetCoverageResponse(
            normalized_path=normalized_path,
            source_type=source_type,
            is_covered=covering_path is not None,
            covering_path=covering_path,
        )

    def set_search_target_enabled(
        self,
        *,
        folder_path: str,
        is_enabled: bool,
        index_depth: int | None = None,
    ) -> SearchTargetListResponse:
        """検索対象の有効 / 無効を切り替える。未登録のパスは新規に登録してから切り替える。"""
        app_settings = self.get_app_settings()
        target = self.targets.ensure_target(
            full_path=folder_path,
            exclude_keywords=app_settings.exclude_keywords,
            index_depth=index_depth if index_depth is not None else UNLIMITED_INDEX_DEPTH,
            selected_extensions=app_settings.index_selected_extensions,
        )
        self.targets.set_enabled(int(target["id"]), is_enabled=is_enabled, index_depth=index_depth)
        return self.list_search_targets()

    def add_search_target(self, *, folder_path: str, index_depth: int | None = 3) -> SearchTargetListResponse:
        """
        検索対象を新規に追加して有効にする。
        Web の検索対象は、追加と同時に巡回してインデックスを作る。
        """
        effective_depth = index_depth if index_depth is not None else UNLIMITED_INDEX_DEPTH
        response = self.set_search_target_enabled(
            folder_path=folder_path,
            is_enabled=True,
            index_depth=effective_depth,
        )
        normalized_path, source_type = normalize_target_identifier_or_raise(folder_path)
        if source_type != "web":
            return response
        self.ensure_fresh_target(
            full_path=normalized_path,
            refresh_window_minutes=0,
            index_depth=effective_depth,
        )
        return self.list_search_targets()

    def delete_search_targets(self, folder_paths: list[str]) -> DeleteSearchTargetsResponse:
        """
        検索対象の一覧から指定パスを外す。
        インデックスデータ自体は削除せず、対象の登録だけを外す。
        """
        self._raise_if_running()
        return DeleteSearchTargetsResponse(deleted_count=self.targets.delete(_normalize_unique_targets(folder_paths)))

    # ------------------------------------------------------------------ インデックス済みデータ

    def get_failed_files(self) -> FailedFileListResponse:
        """直近のインデックス処理で取得に失敗したファイル一覧を返す。"""
        return self.files.list_failed_files()

    def list_indexed_targets(self, *, source_type: str = "local") -> IndexedTargetListResponse:
        """インデックス済みファイルが存在するフォルダ（Web は URL）の一覧を返す。"""
        return self.files.list_indexed_targets(source_type=source_type)

    def delete_indexed_targets(self, target_paths: list[str]) -> DeleteIndexedFoldersResponse:
        """
        選択したフォルダ群または Web URL のインデックスを削除し、重なる検索対象は次回再取得される状態へ戻す。
        """
        self._raise_if_running()
        normalized_paths = _normalize_unique_targets(target_paths)
        for target_path in normalized_paths:
            self.files.delete_rows_under(target_path)
            self.targets.mark_overlapping_stale(target_path)
        self.connection.commit()
        reclaim_free_pages(self.connection)
        return DeleteIndexedFoldersResponse(deleted_count=len(normalized_paths))


def _normalize_unique_targets(target_paths: list[str]) -> list[str]:
    """空文字を除き、正規化した検索対象識別子を重複なしの昇順で返す。"""
    return sorted(
        {
            normalize_target_identifier_or_raise(target_path)[0]
            for target_path in target_paths
            if str(target_path).strip()
        }
    )
