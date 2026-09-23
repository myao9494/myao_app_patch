"""OS変更通知を検索対象ごとの再インデックス要否へ変換するテスト。"""

import sqlite3
from pathlib import Path

from app.db.schema import initialize_schema
from app.services.change_tracking_service import ChangeTrackingService
from app.services.windows_change_tracking import INVALID_HANDLE_VALUE, UsnJournalInfo, UsnReadResult, WindowsChangeApi, WindowsChangeTracker


def test_changed_path_marks_only_containing_target_dirty(tmp_path: Path) -> None:
    """変更されたパスを含むローカル検索対象だけを dirty にする。"""
    database_path = tmp_path / "search.db"
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    tracked_root = tmp_path / "tracked"
    other_root = tmp_path / "other"
    tracked_root.mkdir()
    other_root.mkdir()
    connection.execute(
        """
        INSERT INTO targets (full_path, index_depth, source_type, created_at, updated_at)
        VALUES (?, 1, 'local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """,
        (str(tracked_root),),
    )
    connection.execute(
        """
        INSERT INTO targets (full_path, index_depth, source_type, created_at, updated_at)
        VALUES (?, 1, 'local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """,
        (str(other_root),),
    )
    connection.commit()
    connection.close()

    def create_connection() -> sqlite3.Connection:
        created = sqlite3.connect(database_path)
        created.row_factory = sqlite3.Row
        return created

    ChangeTrackingService(connection_factory=create_connection).mark_changed_paths((str(tracked_root / "nested" / "note.md"),))

    check_connection = create_connection()
    try:
        rows = check_connection.execute(
            """
            SELECT targets.full_path, target_change_states.is_dirty
            FROM targets
            LEFT JOIN target_change_states ON target_change_states.target_id = targets.id
            ORDER BY targets.full_path
            """
        ).fetchall()
        assert [(row["full_path"], row["is_dirty"]) for row in rows] == [
            (str(other_root), None),
            (str(tracked_root), 1),
        ]
    finally:
        check_connection.close()


def test_ignored_internal_path_does_not_mark_target_dirty(tmp_path: Path) -> None:
    """
    バックエンド自身のログやDB更新は、次回検索の再インデックス理由にしない。
    """
    database_path = tmp_path / "search.db"
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    root = tmp_path / "tracked"
    ignored_directory = root / "backend-data"
    ignored_directory.mkdir(parents=True)
    connection.execute(
        """
        INSERT INTO targets (full_path, index_depth, source_type, created_at, updated_at)
        VALUES (?, 1, 'local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """,
        (str(root),),
    )
    connection.commit()
    connection.close()

    def create_connection() -> sqlite3.Connection:
        created = sqlite3.connect(database_path)
        created.row_factory = sqlite3.Row
        return created

    service = ChangeTrackingService(connection_factory=create_connection, ignored_paths=(ignored_directory,))
    service.mark_changed_paths((str(ignored_directory / "search.db-wal"),))

    check_connection = create_connection()
    try:
        assert check_connection.execute("SELECT COUNT(*) FROM target_change_states").fetchone()[0] == 0
    finally:
        check_connection.close()


def test_changed_path_bytes_marks_containing_target_dirty(tmp_path: Path) -> None:
    """macOS FSEvents から届く bytes 型の変更パスでも正しくデコードして dirty にする。"""
    database_path = tmp_path / "search.db"
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    tracked_root = tmp_path / "tracked"
    tracked_root.mkdir()
    connection.execute(
        """
        INSERT INTO targets (full_path, index_depth, source_type, created_at, updated_at)
        VALUES (?, 1, 'local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """,
        (str(tracked_root),),
    )
    connection.commit()
    connection.close()

    def create_connection() -> sqlite3.Connection:
        created = sqlite3.connect(database_path)
        created.row_factory = sqlite3.Row
        return created

    # PyObjC FSEvents コールバックで渡される bytes 型パス
    raw_bytes_path = (tracked_root / "nested" / "note.md").as_posix().encode("utf-8")
    ChangeTrackingService(connection_factory=create_connection).mark_changed_paths((raw_bytes_path,))

    check_connection = create_connection()
    try:
        rows = check_connection.execute(
            """
            SELECT targets.full_path, target_change_states.is_dirty
            FROM targets
            LEFT JOIN target_change_states ON target_change_states.target_id = targets.id
            """
        ).fetchall()
        assert [(row["full_path"], row["is_dirty"]) for row in rows] == [
            (str(tracked_root), 1),
        ]
    finally:
        check_connection.close()


def test_ignored_internal_path_bytes_does_not_mark_target_dirty(tmp_path: Path) -> None:
    """bytes 型の無視パス（自身が出力するログやDB更新）でも正しく除外され dirty にしない。"""
    database_path = tmp_path / "search.db"
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    root = tmp_path / "tracked"
    ignored_directory = root / "backend-data"
    ignored_directory.mkdir(parents=True)
    connection.execute(
        """
        INSERT INTO targets (full_path, index_depth, source_type, created_at, updated_at)
        VALUES (?, 1, 'local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """,
        (str(root),),
    )
    connection.commit()
    connection.close()

    def create_connection() -> sqlite3.Connection:
        created = sqlite3.connect(database_path)
        created.row_factory = sqlite3.Row
        return created

    service = ChangeTrackingService(connection_factory=create_connection, ignored_paths=(ignored_directory,))
    raw_bytes_path = (ignored_directory / "search.db-wal").as_posix().encode("utf-8")
    service.mark_changed_paths((raw_bytes_path,))

    check_connection = create_connection()
    try:
        assert check_connection.execute("SELECT COUNT(*) FROM target_change_states").fetchone()[0] == 0
    finally:
        check_connection.close()


class FakeUsnApi:
    """Windows API を呼ばずに USN の成否を指定するテスト用ラッパー。"""

    def __init__(self, result: UsnReadResult | None = None, error: Exception | None = None) -> None:
        self.result = result
        self.error = error
        self.watched_paths: tuple[str, ...] = ()
        self.read_calls = 0

    def volume_for_path(self, _path: str) -> str:
        return "C:/"

    def query_journal(self, _volume: str) -> UsnJournalInfo:
        return UsnJournalInfo(journal_id=42, next_usn=100)

    def read_journal(self, _volume: str, _journal_id: int, _last_usn: int) -> UsnReadResult:
        self.read_calls += 1
        if self.error:
            raise self.error
        assert self.result is not None
        return self.result

    def start_directory_watch(self, paths: tuple[str, ...], _callback) -> bool:
        self.watched_paths = paths
        return bool(paths)

    def stop_directory_watch(self) -> None:
        pass


def _create_windows_tracker(tmp_path: Path, api: FakeUsnApi) -> tuple[WindowsChangeTracker, callable]:
    database_path = tmp_path / "search.db"
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    root = tmp_path / "tracked"
    root.mkdir()
    connection.execute(
        """INSERT INTO targets (full_path, index_depth, source_type, created_at, updated_at)
           VALUES (?, 1, 'local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)""",
        (root.as_posix(),),
    )
    connection.execute(
        "INSERT INTO windows_usn_journals (volume_path, journal_id, last_usn, updated_at) VALUES ('C:/', 42, 10, CURRENT_TIMESTAMP)"
    )
    connection.commit()
    connection.close()

    def create_connection() -> sqlite3.Connection:
        created = sqlite3.connect(database_path)
        created.row_factory = sqlite3.Row
        return created

    return WindowsChangeTracker(create_connection, api=api), create_connection


def test_windows_usn_changes_mark_target_and_persist_cursor(tmp_path: Path) -> None:
    """USN の正常な履歴読み取りは対象を dirty にし、次回位置を保存する。"""
    tracker, create_connection = _create_windows_tracker(
        tmp_path, FakeUsnApi(result=UsnReadResult(next_usn=25, changed_paths=(str(tmp_path / "tracked" / "note.md"),)))
    )

    tracker.reconcile_once()

    connection = create_connection()
    try:
        assert connection.execute("SELECT is_dirty FROM target_change_states").fetchone()[0] == 1
        assert connection.execute("SELECT last_usn FROM windows_usn_journals").fetchone()[0] == 25
    finally:
        connection.close()


def test_windows_usn_history_gap_marks_volume_targets_dirty(tmp_path: Path) -> None:
    """USN 履歴が欠落した場合は安全側でボリューム配下を再照合する。"""
    api = FakeUsnApi(error=RuntimeError("journal gap"))
    tracker, create_connection = _create_windows_tracker(tmp_path, api)

    tracker.reconcile_once()
    tracker.reconcile_once()

    connection = create_connection()
    try:
        assert connection.execute("SELECT is_dirty FROM target_change_states").fetchone()[0] == 1
        assert api.read_calls == 1
    finally:
        connection.close()


def test_windows_uses_directory_watch_when_usn_is_unavailable(tmp_path: Path) -> None:
    """USN 非対応ボリュームは ReadDirectoryChangesW ラッパーへフォールバックする。"""
    api = FakeUsnApi(error=OSError("not NTFS"))
    tracker, _ = _create_windows_tracker(tmp_path, api)

    assert tracker.start() is True
    assert api.watched_paths == ((tmp_path / "tracked").as_posix(),)
    tracker.stop()


def test_windows_invalid_handle_value_is_not_used_as_a_valid_handle() -> None:
    """64-bit ctypes の符号拡張済み INVALID_HANDLE_VALUE を正しく失敗扱いにする。"""
    assert WindowsChangeApi._is_invalid_handle(INVALID_HANDLE_VALUE) is True


def test_dirty_target_is_cleaned_after_background_refresh(tmp_path: Path) -> None:
    """dirty 化された対象は検索を待たせず既存の安全な差分走査で clean に戻る。"""
    database_path = tmp_path / "search.db"
    root = tmp_path / "tracked"
    root.mkdir()
    (root / "note.md").write_text("background refresh", encoding="utf-8")
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    cursor = connection.execute(
        """INSERT INTO targets (full_path, index_depth, source_type, created_at, updated_at)
           VALUES (?, 1, 'local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)""",
        (root.as_posix(),),
    )
    connection.execute(
        "INSERT INTO target_change_states (target_id, is_tracking, is_dirty) VALUES (?, 1, 1)",
        (cursor.lastrowid,),
    )
    connection.commit()
    connection.close()

    def create_connection() -> sqlite3.Connection:
        created = sqlite3.connect(database_path)
        created.row_factory = sqlite3.Row
        return created

    service = ChangeTrackingService(connection_factory=create_connection)
    service._refresh_one_debounced_dirty_target()

    check_connection = create_connection()
    try:
        assert check_connection.execute("SELECT is_dirty FROM target_change_states").fetchone()[0] == 0
    finally:
        check_connection.close()


def test_windows_poll_loop_stops_when_all_volumes_fallback(tmp_path: Path) -> None:
    """全ボリュームが USN 利用不可で ReadDirectoryChangesW にフォールバックした場合、ポーリングスレッドは停止する。"""
    api = FakeUsnApi(error=OSError("Access denied / not supported"))
    tracker, _ = _create_windows_tracker(tmp_path, api)

    assert tracker.start() is True
    # tracker.start() 内で reconcile_once() が走り、fallback_volumes に追加される
    # _poll_loop を直接呼んだ場合にループを抜けて即座に終了することを確認
    tracker._poll_loop()
    assert tracker._thread is not None
    # スレッドが生存していない（終了した）ことを確認
    tracker._thread.join(timeout=1.0)
    assert not tracker._thread.is_alive()
    tracker.stop()


def test_windows_service_starts_dirty_refresh_worker_even_if_tracking_fails(monkeypatch, tmp_path: Path) -> None:
    """Windows環境で変更追跡の開始に失敗しても、dirty_refresh_worker は起動する。"""
    import platform

    monkeypatch.setattr(platform, "system", lambda: "Windows")

    database_path = tmp_path / "search.db"
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    connection.close()

    def create_connection() -> sqlite3.Connection:
        created = sqlite3.connect(database_path)
        created.row_factory = sqlite3.Row
        return created

    class FailingTracker:
        def __init__(self, *args, **kwargs):
            pass

        def start(self) -> bool:
            return False

        def stop(self) -> None:
            pass

    monkeypatch.setattr("app.services.change_tracking_service.WindowsChangeTracker", FailingTracker)

    service = ChangeTrackingService(connection_factory=create_connection)
    started = service.start()
    try:
        assert started is False
        assert service._refresh_thread is not None
        assert service._refresh_thread.is_alive()
    finally:
        service.stop()

