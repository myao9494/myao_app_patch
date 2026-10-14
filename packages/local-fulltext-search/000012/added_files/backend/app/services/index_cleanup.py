"""
検索ルール（除外キーワード・対象拡張子）の変更で対象外になったファイルを、インデックスから取り除く。

全文検索DB（files / file_segments / failed_files）と、全モデル分のベクトルDBの両方を掃除する。
掃除の失敗（DB ロック等）で設定の保存そのものを失敗させないよう、失敗は警告ログに残して続行する。
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path
from sqlite3 import Error as SQLiteError

from app.config import settings
from app.services import app_settings_store, exclude_rules
from app.services.indexed_file_store import IndexedFileStore

logger = logging.getLogger(__name__)


def cleanup_excluded_extension_files(files: IndexedFileStore, *, allowed_extensions_text: str) -> None:
    """
    検索ルール管理で除外された拡張子を持つローカルファイルを、
    DB（files, file_segments, failed_files）および全モデル分のベクトルDBからクリーンアップする。
    """
    allowed_set = set(app_settings_store.parse_extension_entries(allowed_extensions_text))
    if not allowed_set:
        return
    sorted_allowed = tuple(sorted(allowed_set, key=len, reverse=True))

    def has_allowed_extension(path: str) -> bool:
        return path.lower().endswith(sorted_allowed)

    try:
        rows = files.connection.execute(
            "SELECT id, normalized_path, file_ext FROM files WHERE source_type = 'local'"
        ).fetchall()
        files.delete_file_rows(
            int(row["id"])
            for row in rows
            if str(row["file_ext"] or "").lower() not in allowed_set
            and not has_allowed_extension(str(row["normalized_path"]))
        )
        files.delete_failed_file_rows(
            lambda path: not path.lower().startswith(("http://", "https://")) and not has_allowed_extension(path)
        )
    except SQLiteError:
        # クリーンアップの失敗（DB ロック等）で設定保存そのものを失敗させない
        files.rollback()
        logger.warning("Failed to clean up index rows for excluded extensions.", exc_info=True)
    purge_vector_documents(lambda path: not has_allowed_extension(path))


def cleanup_excluded_keyword_files(files: IndexedFileStore, *, new_exclude_keywords: str) -> None:
    """
    検索ルール管理で追加された除外キーワードに合致するファイルを、
    DB（files, file_segments, failed_files）および全モデル分のベクトルDBからクリーンアップする。
    """
    raw_keywords = exclude_rules.parse_exclude_keywords(new_exclude_keywords)
    if not raw_keywords:
        return
    keyword_set, substring_keywords, excluded_path_prefixes = exclude_rules.compile_exclude_keywords(raw_keywords)

    def is_excluded(path: str) -> bool:
        return exclude_rules.should_exclude_path_with_keywords(
            Path(path), keyword_set, substring_keywords, excluded_path_prefixes
        )

    try:
        rows = files.connection.execute("SELECT id, normalized_path FROM files").fetchall()
        files.delete_file_rows(int(row["id"]) for row in rows if is_excluded(str(row["normalized_path"])))
        files.delete_failed_file_rows(is_excluded)
    except SQLiteError:
        # クリーンアップの失敗（DB ロック等）で設定保存そのものを失敗させない
        files.rollback()
        logger.warning("Failed to clean up index rows for excluded keywords.", exc_info=True)
    purge_vector_documents(is_excluded)


def purge_vector_documents(should_delete: Callable[[str], bool]) -> None:
    """
    全モデル分のベクトルDB（data_dir 内の vector_index_*.db）から、条件に合致する文書を削除する。
    ベクトル側の失敗で設定保存全体を止めないよう、失敗は警告ログに残して継続する。
    """
    try:
        from app.vector.db import delete_documents, get_all_documents_metadata, list_vector_db_paths
        from app.vector.state import vector_state

        deleted_count = 0
        for db_path in list_vector_db_paths(settings.data_dir):
            target_paths = [path for path in get_all_documents_metadata(db_path) if should_delete(path)]
            deleted_count += delete_documents(db_path, target_paths)
        if deleted_count and vector_state.searcher:
            vector_state.searcher.reset_index()
    except Exception:
        logger.warning("Failed to clean up vector index documents.", exc_info=True)
