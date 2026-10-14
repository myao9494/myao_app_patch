"""
ローカルフォルダの検索対象を走査して全文インデックスへ反映する。

走査は os.scandir、本文抽出はスレッド並列、SQLite への書き込みは直列で行う。
- 除外フォルダへは再帰しない。エントリ名だけで除外判定する（親フォルダは再帰の途中で判定済み）。
- 更新されていない成功済みファイルと、最近失敗して更新されていないファイルは再抽出しない。
- 走査後、今回の走査範囲（階層・拡張子・除外条件）に含まれるのに見つからなかった行だけを削除する。
"""

from __future__ import annotations

import logging
import os
import time as time_module
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass

from app.extractors.text_extractor import (
    extract_text,
    normalize_extension_filter,
    resolve_supported_extension,
    supports_content_extraction,
)
from app.services import app_settings_store, exclude_rules
from app.services.file_walker import walk_indexable_files
from app.services.index_run_state import IndexingCancelledError, IndexRunState, TargetIndexResult
from app.services.indexed_file_store import IndexedFileCandidate, IndexedFileStore
from app.services.path_service import normalize_path

# 抽出に失敗し、その後も更新されていないファイルを再試行するまでの間隔。
# 走査のたびに同じ壊れたファイルを解析し直さないための間隔で、一時的な失敗（他アプリによるロック等）は
# この時間が過ぎれば次の走査で自動的に再試行される。画面からの再インデックスでは間隔に関係なく再試行する。
FAILED_FILE_RETRY_INTERVAL_SECONDS = 60 * 60
# 抽出済みファイルをまとめて commit する件数
WRITE_BATCH_SIZE = 100
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class IndexDrainStats:
    """
    抽出完了待ちの結果と、待機時間・DB反映時間をまとめて返す。
    """

    file_count: int
    error_count: int
    write_count: int
    wait_seconds: float
    db_write_seconds: float


def resolve_extract_worker_count() -> int:
    """
    本文抽出スレッド数を CPU 数に応じて上限付きで決める。
    I/Oバウンドタスクが支配的なため、CPU数の2倍（上限16）を使用する。
    """
    cpu_count = os.cpu_count() or 4
    return max(2, min(16, cpu_count * 2))


def can_skip_recently_failed_file(failed_at: float | None, stat: os.stat_result, *, now: float) -> bool:
    """
    前回の失敗以降に更新されておらず、再試行間隔も過ぎていない失敗ファイルは再抽出を省略する。
    """
    if failed_at is None:
        return False
    if stat.st_mtime > failed_at:
        return False
    return now - failed_at < FAILED_FILE_RETRY_INTERVAL_SECONDS


def can_skip_existing_file(existing: dict[str, object] | None, stat: os.stat_result) -> bool:
    """
    変更のない成功済みファイルは再抽出を省略する。
    """
    if existing is None:
        return False
    if existing.get("last_error"):
        return False
    return float(existing["mtime"]) == stat.st_mtime and int(existing["size"]) == stat.st_size


def resolve_created_at(stat: os.stat_result) -> float:
    """
    作成日時が取得できる環境では birth time を優先し、未対応環境では ctime へフォールバックする。
    Linux では ctime が inode 変更時刻のため厳密な作成日ではないが、列を常に埋めて検索条件を維持する。
    """
    birth_time = getattr(stat, "st_birthtime", None)
    if isinstance(birth_time, (int, float)):
        return float(birth_time)
    return float(stat.st_ctime)


class LocalTargetIndexer:
    """ローカルフォルダ 1 件分の走査と DB 反映を行う。"""

    def __init__(self, files: IndexedFileStore, run_state: IndexRunState) -> None:
        self.files = files
        self.run_state = run_state

    def index(
        self,
        target: dict[str, object],
        exclude_keywords: str,
        *,
        index_depth: int,
        cleanup_root_path: str,
        cleanup_index_depth: int,
        selected_extensions: str,
        custom_content_extensions: str,
        custom_filename_extensions: str,
        retry_failed_files: bool = False,
    ) -> TargetIndexResult:
        """
        指定ターゲット配下を高速に再走査する。
        走査は os.scandir、本文抽出はスレッド並列、DB 書き込みは直列でまとめる。
        前回抽出に失敗してから更新されていないファイルは、再試行間隔が過ぎるまで再抽出しない
        （retry_failed_files=True のときは常に再試行する）。
        """
        total_start = time_module.perf_counter()
        folder_path = normalize_path(str(target["full_path"]))
        normalized_paths: set[str] = set()
        failed_paths: set[str] = set()
        auto_excluded_paths: set[str] = set()
        file_count = 0
        error_count = 0
        write_count = 0
        skipped_count = 0
        submitted_extract_count = 0
        filename_only_count = 0
        batch_commit_count = 0
        extraction_wait_seconds = 0.0
        db_write_seconds = 0.0

        setup_start = time_module.perf_counter()
        keywords = exclude_rules.parse_exclude_keywords(exclude_keywords)
        keyword_set, substring_keywords, excluded_path_prefixes = exclude_rules.compile_exclude_keywords(keywords)
        custom_content_extension_list = tuple(app_settings_store.parse_extension_entries(custom_content_extensions))
        custom_filename_extension_list = tuple(app_settings_store.parse_extension_entries(custom_filename_extensions))
        allowed_extensions = normalize_extension_filter(
            selected_extensions,
            extra_content_extensions=custom_content_extension_list,
            extra_filename_extensions=custom_filename_extension_list,
        )
        setup_elapsed = time_module.perf_counter() - setup_start
        logger.info(
            "Index: setup time: %.3fs (target=%s, keywords=%d, extensions=%d)",
            setup_elapsed,
            folder_path.as_posix(),
            len(keywords),
            len(allowed_extensions),
        )
        existing_start = time_module.perf_counter()
        existing_files = self.files.load_existing_files(folder_path.as_posix())
        failed_file_times = {} if retry_failed_files else self.files.load_failed_file_times(folder_path.as_posix())
        scan_started_at = time_module.time()
        existing_elapsed = time_module.perf_counter() - existing_start
        logger.info(
            "Index: existing metadata load time: %.3fs (target=%s, existing=%d)",
            existing_elapsed,
            folder_path.as_posix(),
            len(existing_files),
        )
        sorted_allowed_extensions = tuple(sorted(allowed_extensions, key=len, reverse=True))
        max_workers = resolve_extract_worker_count()
        max_pending = max_workers * 4
        pending: dict[Future[str], IndexedFileCandidate] = {}

        executor = ThreadPoolExecutor(max_workers=max_workers)
        cancelled = False
        scan_start = time_module.perf_counter()
        try:
            for path in walk_indexable_files(
                folder_path,
                keyword_set,
                substring_keywords,
                excluded_path_prefixes=excluded_path_prefixes,
                auto_excluded_paths=auto_excluded_paths,
                allowed_extensions=allowed_extensions,
                sorted_allowed_extensions=sorted_allowed_extensions,
                max_depth=index_depth,
            ):
                self.run_state.raise_if_cancel_requested()
                try:
                    stat = path.stat()
                    normalized_path = path.resolve().as_posix()
                except FileNotFoundError:
                    # 走査中に削除されたファイル（一時ファイルなど）。存在しないものとして扱う。
                    continue
                normalized_paths.add(normalized_path)
                existing = existing_files.get(normalized_path)

                if can_skip_existing_file(existing, stat):
                    file_count += 1
                    skipped_count += 1
                    continue

                if can_skip_recently_failed_file(
                    failed_file_times.get(normalized_path), stat, now=scan_started_at
                ):
                    # 失敗記録を保持したまま再抽出だけを省く（件数上は従来どおり失敗として数える）
                    failed_paths.add(normalized_path)
                    error_count += 1
                    continue

                candidate = IndexedFileCandidate(
                    path=path,
                    normalized_path=normalized_path,
                    created_at=resolve_created_at(stat),
                    mtime=stat.st_mtime,
                    size=stat.st_size,
                    file_ext=resolve_supported_extension(
                        path,
                        extra_content_extensions=custom_content_extension_list,
                        extra_filename_extensions=custom_filename_extension_list,
                    )
                    or path.suffix.lower(),
                    existing_id=int(existing["id"]) if existing is not None else None,
                )

                if supports_content_extraction(
                    path,
                    extra_content_extensions=custom_content_extension_list,
                    extra_filename_extensions=custom_filename_extension_list,
                ):
                    pending[
                        executor.submit(
                            extract_text,
                            path,
                            extra_content_extensions=custom_content_extension_list,
                            extra_filename_extensions=custom_filename_extension_list,
                        )
                    ] = candidate
                    submitted_extract_count += 1
                    if len(pending) >= max_pending:
                        result = self._drain_pending_futures(
                            pending,
                            failed_paths,
                            drain_all=False,
                        )
                        file_count += result.file_count
                        error_count += result.error_count
                        write_count += result.write_count
                        extraction_wait_seconds += result.wait_seconds
                        db_write_seconds += result.db_write_seconds
                else:
                    write_start = time_module.perf_counter()
                    self.files.upsert_file(candidate=candidate, content=None)
                    db_write_seconds += time_module.perf_counter() - write_start
                    file_count += 1
                    write_count += 1
                    filename_only_count += 1
                    if write_count % WRITE_BATCH_SIZE == 0:
                        commit_start = time_module.perf_counter()
                        self.files.commit()
                        db_write_seconds += time_module.perf_counter() - commit_start
                        batch_commit_count += 1

            result = self._drain_pending_futures(
                pending,
                failed_paths,
                drain_all=True,
            )
            file_count += result.file_count
            error_count += result.error_count
            write_count += result.write_count
            extraction_wait_seconds += result.wait_seconds
            db_write_seconds += result.db_write_seconds
            scan_elapsed = time_module.perf_counter() - scan_start - extraction_wait_seconds - db_write_seconds
            logger.info(
                "Index: scan/dispatch time: %.3fs (target=%s, scanned=%d, skipped=%d, submitted=%d, filename_only=%d, workers=%d, max_pending=%d)",
                max(scan_elapsed, 0.0),
                folder_path.as_posix(),
                len(normalized_paths),
                skipped_count,
                submitted_extract_count,
                filename_only_count,
                max_workers,
                max_pending,
            )
            logger.info(
                "Index: extraction wait time: %.3fs (target=%s, submitted=%d, errors=%d)",
                extraction_wait_seconds,
                folder_path.as_posix(),
                submitted_extract_count,
                error_count,
            )
            logger.info(
                "Index: DB write time: %.3fs (target=%s, writes=%d, batch_commits=%d)",
                db_write_seconds,
                folder_path.as_posix(),
                write_count,
                batch_commit_count,
            )
        except IndexingCancelledError:
            cancelled = True
            commit_start = time_module.perf_counter()
            self.files.commit()
            db_write_seconds += time_module.perf_counter() - commit_start
            raise
        finally:
            executor.shutdown(wait=False, cancel_futures=True)

        if not cancelled:
            final_commit_start = time_module.perf_counter()
            self.files.commit()
            final_commit_elapsed = time_module.perf_counter() - final_commit_start
            db_write_seconds += final_commit_elapsed
            logger.info(
                "Index: final commit time: %.3fs (target=%s, writes=%d)",
                final_commit_elapsed,
                folder_path.as_posix(),
                write_count,
            )
            cleanup_start = time_module.perf_counter()
            self.files.remove_deleted_files(
                normalized_paths,
                root_path=cleanup_root_path,
                index_depth=cleanup_index_depth,
                allowed_extensions=allowed_extensions,
                preloaded_existing_files=existing_files,
                keyword_set=keyword_set,
                substring_keywords=substring_keywords,
                excluded_path_prefixes=(*excluded_path_prefixes, *tuple(sorted(auto_excluded_paths))),
            )
            self.files.clear_resolved_failed_files(
                root_path=cleanup_root_path,
                failed_paths=failed_paths,
                index_depth=cleanup_index_depth,
                allowed_extensions=allowed_extensions,
                keyword_set=keyword_set,
                substring_keywords=substring_keywords,
                excluded_path_prefixes=(*excluded_path_prefixes, *tuple(sorted(auto_excluded_paths))),
            )
            cleanup_elapsed = time_module.perf_counter() - cleanup_start
            total_elapsed = time_module.perf_counter() - total_start
            logger.info(
                "Index: cleanup time: %.3fs (target=%s, failed_remaining=%d, auto_excluded=%d)",
                cleanup_elapsed,
                folder_path.as_posix(),
                len(failed_paths),
                len(auto_excluded_paths),
            )
            logger.info(
                "Index: total time: %.3fs (target=%s, files=%d, writes=%d, skipped=%d, errors=%d)",
                total_elapsed,
                folder_path.as_posix(),
                file_count,
                write_count,
                skipped_count,
                error_count,
            )

        return TargetIndexResult(
            file_count=file_count,
            error_count=error_count,
            exclude_keywords=exclude_rules.normalize_keyword_list([*keywords, *sorted(auto_excluded_paths)]),
        )

    def _drain_pending_futures(
        self,
        pending: dict[Future[str], IndexedFileCandidate],
        failed_paths: set[str],
        *,
        drain_all: bool,
    ) -> IndexDrainStats:
        """
        完了した抽出タスクだけを取り出して DB へ反映する。
        """
        if not pending:
            return IndexDrainStats(
                file_count=0,
                error_count=0,
                write_count=0,
                wait_seconds=0.0,
                db_write_seconds=0.0,
            )

        wait_start = time_module.perf_counter()
        # ``extract_text`` は外部ファイル（特に破損・巨大PDF）の解析で長時間戻らない
        # 場合がある。無期限の wait はキャンセル要求を確認できず、index_runs が実行中の
        # まま残るため、短い待機ごとにDBの中止フラグを確認する。
        remaining = set(pending)
        done: set[Future[str]] = set()
        while remaining:
            completed, not_done = wait(
                remaining,
                timeout=0.25,
                return_when=FIRST_COMPLETED,
            )
            if not completed:
                self.run_state.raise_if_cancel_requested()
                continue
            done.update(completed)
            remaining = not_done
            if not drain_all:
                break
            self.run_state.raise_if_cancel_requested()
        wait_seconds = time_module.perf_counter() - wait_start

        file_count = 0
        error_count = 0
        write_count = 0
        db_write_seconds = 0.0
        for future in done:
            self.run_state.raise_if_cancel_requested()
            candidate = pending.pop(future)
            try:
                content = future.result()
                write_start = time_module.perf_counter()
                self.files.upsert_file(candidate=candidate, content=content)
                db_write_seconds += time_module.perf_counter() - write_start
                file_count += 1
                write_count += 1
            except Exception as error:
                error_count += 1
                failed_paths.add(candidate.normalized_path)
                write_start = time_module.perf_counter()
                self.files.record_file_error(candidate.path, error)
                db_write_seconds += time_module.perf_counter() - write_start

        return IndexDrainStats(
            file_count=file_count,
            error_count=error_count,
            write_count=write_count,
            wait_seconds=wait_seconds,
            db_write_seconds=db_write_seconds,
        )
