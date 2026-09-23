"""
OSごとの変更通知（macOS: FSEvents, Windows: USN / ReadDirectoryChangesW）を利用して、
変更された検索対象だけを dirty 状態として永続化し、バックグラウンド差分更新を行う。

通知はファイル単位で届かない場合や集約される場合があるため、イベントを受けた検索対象フォルダを
dirty として記録する。インデックス更新は既存の安全な差分走査を使うため、
削除・リネーム・イベント集約・USN履歴欠落があっても検索DBの整合性を保てる。
"""

from __future__ import annotations

import logging
import os
import platform
import threading
from collections.abc import Callable
from pathlib import Path
from sqlite3 import Connection

from app.db.connection import get_connection
from app.config import BACKEND_DIR, settings
from app.services.path_service import normalize_path
from app.services.windows_change_tracking import WindowsChangeTracker


logger = logging.getLogger(__name__)
ChangeCallback = Callable[[tuple[str, ...]], None]


class MacFSEventsObserver:
    """FSEvents を専用スレッドの RunLoop 上で受信する macOS 専用監視器。"""

    def __init__(self) -> None:
        self._paths: tuple[str, ...] = ()
        self._callback: ChangeCallback | None = None
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    @staticmethod
    def is_available() -> bool:
        """PyObjC の FSEvents バインディングを読み込める macOS だけで有効化する。"""
        if platform.system() != "Darwin":
            return False
        try:
            import CoreFoundation  # noqa: F401
            import CoreServices  # noqa: F401
        except ImportError:
            return False
        return True

    def start(self, paths: tuple[str, ...], callback: ChangeCallback) -> bool:
        """指定パスの監視を開始できた場合だけ True を返す。"""
        if not paths or not self.is_available():
            return False
        self._paths = paths
        self._callback = callback
        self._thread = threading.Thread(target=self._run, name="fsevents-change-tracker", daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        """次の RunLoop 周期で FSEvents ストリームを停止する。"""
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        self._thread = None

    def _run(self) -> None:
        """PyObjC が利用できる環境だけで FSEvents のコールバックを処理する。"""
        try:
            from CoreFoundation import CFRunLoopGetCurrent, CFRunLoopRunInMode, kCFRunLoopDefaultMode
            from CoreServices import (
                FSEventStreamCreate,
                FSEventStreamInvalidate,
                FSEventStreamRelease,
                FSEventStreamScheduleWithRunLoop,
                FSEventStreamStart,
                FSEventStreamStop,
                kFSEventStreamCreateFlagFileEvents,
                kFSEventStreamEventIdSinceNow,
            )
        except ImportError:
            logger.warning("FSEvents を利用できないため、従来の定期差分走査を使用します。")
            return

        def on_events(_stream, _info, _count, event_paths, _flags, _ids) -> None:
            callback = self._callback
            if callback is not None:
                decoded_paths = []
                for path in event_paths:
                    if isinstance(path, (bytes, bytearray)):
                        decoded_paths.append(os.fsdecode(path))
                    elif isinstance(path, str):
                        decoded_paths.append(path)
                    else:
                        decoded_paths.append(str(path))
                callback(tuple(decoded_paths))

        stream = FSEventStreamCreate(
            None,
            on_events,
            None,
            list(self._paths),
            kFSEventStreamEventIdSinceNow,
            0.75,
            kFSEventStreamCreateFlagFileEvents,
        )
        if stream is None:
            logger.warning("FSEvents ストリームを作成できませんでした。")
            return
        run_loop = CFRunLoopGetCurrent()
        FSEventStreamScheduleWithRunLoop(stream, run_loop, kCFRunLoopDefaultMode)
        if not FSEventStreamStart(stream):
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            logger.warning("FSEvents ストリームを開始できませんでした。")
            return
        try:
            while not self._stop_event.is_set():
                CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.5, False)
        finally:
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)


class ChangeTrackingService:
    """OS変更通知を targets ごとの dirty 状態へ永続化するサービス。"""

    def __init__(
        self,
        connection_factory: Callable[[], Connection] = get_connection,
        *,
        ignored_paths: tuple[Path, ...] | None = None,
    ) -> None:
        self._connection_factory = connection_factory
        self._observer = MacFSEventsObserver()
        self._windows_tracker: WindowsChangeTracker | None = None
        self._is_running = False
        self._sync_stop_event = threading.Event()
        self._sync_thread: threading.Thread | None = None
        self._refresh_stop_event = threading.Event()
        self._refresh_thread: threading.Thread | None = None
        self._observed_paths: tuple[str, ...] = ()
        self._ignored_paths = tuple(
            path.resolve()
            for path in (
                ignored_paths
                or (settings.data_dir, BACKEND_DIR / "backend.log", settings.launcher_log_path)
            )
        )

    def start(self) -> bool:
        """OSごとの監視を開始し、dirty 対象の更新は検索とは別スレッドで行う。"""
        if platform.system() == "Windows":
            self._windows_tracker = WindowsChangeTracker(
                self._connection_factory,
                ignored_paths=self._is_ignored_path,
            )
            tracking_started = self._windows_tracker.start()
            self._is_running = tracking_started
            self._start_dirty_refresh_worker()
            if not tracking_started:
                logger.warning(
                    "ChangeTrackingService: Windows変更追跡の開始に失敗しました。"
                    "dirty_refresh_workerは起動済みのため、手動再インデックス時は更新されます。"
                )
            else:
                logger.info("ChangeTrackingService: Windows変更追跡を開始しました。")
            return tracking_started
        if not self._observer.is_available():
            if platform.system() == "Darwin":
                logger.warning("ChangeTrackingService: FSEvents を利用できないため、従来の定期差分走査を使用します。")
            return False
        paths = self._synchronize_local_targets(mark_all_dirty=True)
        if not paths:
            logger.info("ChangeTrackingService: 監視対象フォルダが0件のためFSEvents を開始しません。target_synchronizer は起動します。")
            self._start_target_synchronizer()
            return False
        self._is_running = self._observer.start(paths, self.mark_changed_paths)
        self._observed_paths = paths
        self._start_target_synchronizer()
        self._start_dirty_refresh_worker()
        if self._is_running:
            logger.info("ChangeTrackingService: FSEvents 監視を開始しました。対象パス数=%d", len(paths))
        else:
            logger.warning("ChangeTrackingService: FSEvents の開始に失敗しました。")
        return self._is_running

    def stop(self) -> None:
        """アプリケーション終了時に監視スレッドを停止する。"""
        logger.info("ChangeTrackingService: 停止します。")
        self._refresh_stop_event.set()
        if self._refresh_thread is not None:
            self._refresh_thread.join(timeout=2.0)
        self._refresh_thread = None
        self._sync_stop_event.set()
        if self._sync_thread is not None:
            self._sync_thread.join(timeout=2.0)
        self._sync_thread = None
        self._observer.stop()
        if self._windows_tracker is not None:
            self._windows_tracker.stop()
        self._windows_tracker = None
        self._is_running = False

    def mark_changed_paths(self, changed_paths: tuple[str | bytes, ...]) -> None:
        """変更パスを含む登録対象だけを dirty にする。"""
        decoded_paths = []
        for path in changed_paths:
            if isinstance(path, (bytes, bytearray)):
                decoded_paths.append(os.fsdecode(path))
            elif isinstance(path, str):
                if (path.startswith("b'") and path.endswith("'")) or (path.startswith('b"') and path.endswith('"')):
                    decoded_paths.append(path[2:-1])
                else:
                    decoded_paths.append(path)
            else:
                decoded_paths.append(str(path))

        effective_changed_paths = tuple(path for path in decoded_paths if not self._is_ignored_path(path))
        if not effective_changed_paths:
            return
        logger.info(
            "ChangeTrackingService: 変更通知を受けました。有効パス数=%d(例: %s)",
            len(effective_changed_paths),
            effective_changed_paths[0] if effective_changed_paths else "",
        )
        connection = self._connection_factory()
        try:
            targets = connection.execute(
                "SELECT id, full_path FROM targets WHERE source_type = 'local' AND is_search_target_enabled = 1"
            ).fetchall()
            for target in targets:
                root = str(target["full_path"])
                if any(self._is_path_within_root(path, root) for path in effective_changed_paths):
                    connection.execute(
                        """\
                        INSERT INTO target_change_states (target_id, is_tracking, is_dirty, last_event_at)
                        VALUES (?, 1, 1, CURRENT_TIMESTAMP)
                        ON CONFLICT(target_id) DO UPDATE SET
                            is_tracking = 1, is_dirty = 1, last_event_at = CURRENT_TIMESTAMP
                        """,
                        (int(target["id"]),),
                    )
                    logger.info(
                        "ChangeTrackingService: dirty 化しました。target=%s",
                        root,
                    )
            connection.commit()
        finally:
            connection.close()

    def _start_target_synchronizer(self) -> None:
        """設定画面から追加・削除された検索対象へ監視を追随させる。"""
        self._sync_thread = threading.Thread(target=self._synchronize_loop, name="change-tracker-target-sync", daemon=True)
        self._sync_thread.start()

    def _start_dirty_refresh_worker(self) -> None:
        """通知後2秒のデバウンスで、dirty 対象を1本ずつ既存差分走査へ渡す。"""
        self._refresh_stop_event.clear()
        self._refresh_thread = threading.Thread(
            target=self._dirty_refresh_loop,
            name="change-tracker-background-index",
            daemon=True,
        )
        self._refresh_thread.start()
        logger.info("ChangeTrackingService: dirty_refresh_worker を起動しました。")

    def _dirty_refresh_loop(self) -> None:
        """検索リクエストを待たせず、同時実行を避けて dirty 対象を更新する。"""
        while not self._refresh_stop_event.wait(0.5):
            self._refresh_one_debounced_dirty_target()

    def _refresh_one_debounced_dirty_target(self) -> None:
        """2秒以上静まった dirty 対象だけを1件更新し、失敗時は dirty のまま残す。"""
        connection = self._connection_factory()
        try:
            target = connection.execute(
                """\
                SELECT t.full_path, t.exclude_keywords, t.index_depth, t.selected_extensions
                FROM targets t
                JOIN target_change_states s ON s.target_id = t.id
                WHERE t.source_type = 'local' AND t.is_search_target_enabled = 1
                  AND s.is_tracking = 1 AND s.is_dirty = 1
                  AND (s.last_event_at IS NULL OR s.last_event_at <= datetime('now', '-2 seconds'))
                ORDER BY s.last_event_at
                LIMIT 1
                """
            ).fetchone()
            if target is None:
                return
            logger.info(
                "ChangeTrackingService: バックグラウンド差分更新を開始します。target=%s",
                target["full_path"],
            )
            from app.services.index_service import IndexService

            service = IndexService(connection=connection)
            if service._is_running():
                return
            service.ensure_fresh_target(
                full_path=str(target["full_path"]),
                refresh_window_minutes=0,
                exclude_keywords=str(target["exclude_keywords"]),
                index_depth=int(target["index_depth"]),
                types=str(target["selected_extensions"]),
            )
            logger.info(
                "ChangeTrackingService: バックグラウンド差分更新が完了しました。target=%s",
                target["full_path"],
            )
        except Exception:
            logger.warning("ChangeTrackingService: 変更通知後のバックグラウンド差分更新に失敗しました。", exc_info=True)
        finally:
            connection.close()

    def _synchronize_loop(self) -> None:
        """FSEvents の監視ルートを必要時だけ再作成する。"""
        while not self._sync_stop_event.wait(2.0):
            paths = self._synchronize_local_targets(mark_all_dirty=False)
            if paths == self._observed_paths:
                continue
            logger.info(
                "ChangeTrackingService: 監視対象パスが変化したため FSEvents を再起動します。"
                "%d->%d 新=%s",
                len(self._observed_paths),
                len(paths),
                paths,
            )
            self._observer.stop()
            self._is_running = self._observer.start(paths, self.mark_changed_paths)
            self._observed_paths = paths if self._is_running else ()

    def _synchronize_local_targets(self, *, mark_all_dirty: bool) -> tuple[str, ...]:
        """未監視の新規対象を dirty 化し、起動時だけ全対象の整合性を回復する。"""
        connection = self._connection_factory()
        try:
            rows = connection.execute(
                "SELECT id, full_path FROM targets WHERE source_type = 'local' AND is_search_target_enabled = 1"
            ).fetchall()
            paths = tuple(sorted(str(row["full_path"]) for row in rows if Path(str(row["full_path"])).is_dir()))
            for row in rows:
                connection.execute(
                    """\
                    INSERT INTO target_change_states (target_id, is_tracking, is_dirty)
                    VALUES (?, 1, 1)
                    ON CONFLICT(target_id) DO UPDATE SET
                        is_tracking = 1,
                        is_dirty = CASE WHEN ? THEN 1 ELSE target_change_states.is_dirty END
                    """,
                    (int(row["id"]), int(mark_all_dirty)),
                )
            connection.commit()
            return paths
        finally:
            connection.close()

    @staticmethod
    def _is_path_within_root(changed_path: str, root_path: str) -> bool:
        """FSEvents の変更パスが検索対象配下かを、境界を含めて判定する。"""
        try:
            changed = normalize_path(changed_path).as_posix()
            root = normalize_path(root_path).as_posix().rstrip("/")
        except (OSError, ValueError):
            return False
        return changed == root or changed.startswith(root + "/")

    def _is_ignored_path(self, changed_path: str) -> bool:
        """アプリ自身のDB・ログ更新に起因する監視イベントを無視する。"""
        try:
            resolved_path = Path(changed_path).resolve()
        except OSError:
            return False
        return any(resolved_path == ignored or ignored in resolved_path.parents for ignored in self._ignored_paths)
