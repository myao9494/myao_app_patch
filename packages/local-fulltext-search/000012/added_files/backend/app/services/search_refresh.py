"""
検索前のインデックス更新。

- フォルダ未指定の検索: 登録済みの検索対象のうち、更新が必要なものを順に走査してから検索する。
- フォルダ指定の検索: 既にインデックスがあれば検索は待たせず、更新はバックグラウンドへ回す。
  まだインデックスが無いフォルダは、その場で走査してから検索する。
- 到達できないフォルダや、別の走査が実行中の場合は、更新を諦めて既存のインデックスで検索する。
"""

from __future__ import annotations

import logging
import threading
import time as time_module
from sqlite3 import Connection

from fastapi import HTTPException, status

from app.db.connection import get_connection
from app.services import app_settings_store, exclude_rules, web_pages
from app.services.background_tasks import start_background_thread
from app.services.index_service import IndexService

# 同じ条件のバックグラウンド更新を、連続して予約しない間隔
BACKGROUND_REFRESH_RETRY_COOLDOWN_SECONDS = 30.0
logger = logging.getLogger(__name__)

_BACKGROUND_REFRESH_LOCK = threading.Lock()
_BACKGROUND_REFRESH_KEYS: set[tuple[str, str, int, str]] = set()
_BACKGROUND_REFRESH_LAST_SCHEDULED_AT: dict[tuple[str, str, int, str], float] = {}


class SearchRefresher:
    """検索の直前に、対象のインデックスを必要な分だけ更新する。"""

    def __init__(self, index_service: IndexService) -> None:
        self.index_service = index_service


    def refresh_registered_targets(
        self,
        *,
        refresh_window_minutes: int,
        effective_exclude_keywords: str,
        index_depth: int,
        index_types: str | None,
        custom_content_extensions: str,
        custom_filename_extensions: str,
        source_type: str = "local",
    ) -> None:
        """
        フォルダ未指定かつ全 DB 検索 OFF のときは、検索対象フォルダを順次再インデックスする。
        有効対象があればそれを優先し、0 件なら登録済みフォルダ全体へフォールバックする。
        """
        target_paths = self.index_service.list_search_scope_paths(source_type=source_type)
        if not target_paths:
            return

        normalized_extensions = app_settings_store.normalize_selected_extensions(
            index_types,
            custom_content_extensions=custom_content_extensions,
            custom_filename_extensions=custom_filename_extensions,
        )
        for target_path in target_paths:
            try:
                target = self.index_service.targets.ensure_target(
                    full_path=target_path,
                    exclude_keywords=effective_exclude_keywords,
                    index_depth=index_depth,
                    selected_extensions=normalized_extensions,
                )
            except HTTPException as error:
                if error.status_code == status.HTTP_400_BAD_REQUEST:
                    continue
                raise
            effective_keywords = exclude_rules.merge_exclude_keyword_strings(
                effective_exclude_keywords,
                str(target.get("exclude_keywords") or ""),
            )
            if not self.index_service.targets.needs_refresh(
                target,
                refresh_window_minutes,
                effective_keywords,
                index_depth,
                normalized_extensions,
            ):
                continue
            try:
                self.index_service.ensure_fresh_target(
                    full_path=target_path,
                    refresh_window_minutes=refresh_window_minutes,
                    exclude_keywords=effective_keywords,
                    index_depth=index_depth,
                    types=index_types,
                )
            except HTTPException as error:
                # 無効なパスや、バックグラウンド更新中（409 Conflict）は同期更新をスキップして既存インデックスで検索する
                if error.status_code in (status.HTTP_400_BAD_REQUEST, status.HTTP_409_CONFLICT):
                    continue
                raise

    def refresh_target(
        self,
        *,
        normalized_target_path: str,
        refresh_window_minutes: int,
        effective_exclude_keywords: str,
        index_depth: int,
        index_types: str | None,
        custom_content_extensions: str,
        custom_filename_extensions: str,
    ) -> dict[str, bool]:
        """
        既存インデックスがあるフォルダは既存結果を優先し、必要な再更新だけをバックグラウンドへ回す。
        初回検索や未インデックス状態では従来どおり同期インデックスを行う。
        """
        normalized_extensions = app_settings_store.normalize_selected_extensions(
            index_types,
            custom_content_extensions=custom_content_extensions,
            custom_filename_extensions=custom_filename_extensions,
        )
        effective_target_path = (
            self.index_service.targets.resolve_enabled_covering_path(
                normalized_target_path,
                source_type="web" if web_pages.is_web_url(normalized_target_path) else "local",
            )
            or normalized_target_path
        )
        try:
            target = self.index_service.targets.ensure_target(
                full_path=effective_target_path,
                exclude_keywords=effective_exclude_keywords,
                index_depth=index_depth,
                selected_extensions=normalized_extensions,
            )
        except HTTPException as error:
            # 既存インデックスだけでも検索できるよう、到達不能/未接続パスでは再更新を諦めて現在の DB を使う。
            if error.status_code == status.HTTP_400_BAD_REQUEST:
                return {"used_existing_index": True, "background_refresh_scheduled": False}
            raise
        effective_keywords = exclude_rules.merge_exclude_keyword_strings(
            effective_exclude_keywords,
            str(target.get("exclude_keywords") or ""),
        )
        needs_refresh = self.index_service.targets.needs_refresh(
            target,
            refresh_window_minutes,
            effective_keywords,
            index_depth,
            normalized_extensions,
        )
        has_existing_index = target.get("last_indexed_at") is not None
        if not needs_refresh:
            return {"used_existing_index": False, "background_refresh_scheduled": False}
        if not has_existing_index:
            try:
                self.index_service.ensure_fresh_target(
                    full_path=effective_target_path,
                    refresh_window_minutes=refresh_window_minutes,
                    exclude_keywords=effective_keywords,
                    index_depth=index_depth,
                    types=index_types,
                )
            except HTTPException as error:
                if error.status_code != status.HTTP_409_CONFLICT:
                    raise
            return {"used_existing_index": False, "background_refresh_scheduled": False}

        scheduled = self.schedule_background_refresh(
            normalized_target_path=effective_target_path,
            effective_exclude_keywords=effective_keywords,
            index_depth=index_depth,
            index_types=index_types,
        )
        return {"used_existing_index": True, "background_refresh_scheduled": scheduled}

    def schedule_background_refresh(
        self,
        *,
        normalized_target_path: str,
        effective_exclude_keywords: str,
        index_depth: int,
        index_types: str | None,
    ) -> bool:
        """
        同一条件の再インデックスは1本だけ裏で実行し、検索レスポンス自体は待たない。
        """
        normalized_index_types = index_types or ""
        refresh_key = (
            normalized_target_path,
            effective_exclude_keywords,
            index_depth,
            normalized_index_types,
        )
        with _BACKGROUND_REFRESH_LOCK:
            if refresh_key in _BACKGROUND_REFRESH_KEYS:
                return False
            last_scheduled_at = _BACKGROUND_REFRESH_LAST_SCHEDULED_AT.get(refresh_key)
            now = time_module.monotonic()
            if last_scheduled_at is not None and now - last_scheduled_at < BACKGROUND_REFRESH_RETRY_COOLDOWN_SECONDS:
                return False
            _BACKGROUND_REFRESH_KEYS.add(refresh_key)
            _BACKGROUND_REFRESH_LAST_SCHEDULED_AT[refresh_key] = now

        def run_refresh() -> None:
            connection: Connection | None = None
            try:
                connection = get_connection()
                index_service = IndexService(connection=connection)
                if index_service.is_running():
                    return
                index_service.ensure_fresh_target(
                    full_path=normalized_target_path,
                    refresh_window_minutes=0,
                    exclude_keywords=effective_exclude_keywords,
                    index_depth=index_depth,
                    types=normalized_index_types,
                )
            except HTTPException:
                pass
            except Exception:
                logger.warning(
                    "Background refresh failed: target=%s", normalized_target_path, exc_info=True
                )
            finally:
                if connection is not None:
                    connection.close()
                with _BACKGROUND_REFRESH_LOCK:
                    _BACKGROUND_REFRESH_KEYS.discard(refresh_key)

        start_background_thread(run_refresh, name="search-background-refresh")
        return True
