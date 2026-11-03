"""
Windows の変更追跡が、起動後に追加された検索対象へ追従する仕様のテスト。

USN が使えない環境（管理者権限が無い PC など）では ReadDirectoryChangesW で監視する。
監視するフォルダを起動時に固定すると、起動後に追加したフォルダの変更は再起動まで検知されない。

仕様:
- sync_watches は、未監視の有効な検索対象だけ監視を始める。同じフォルダを二重に監視しない。
- 監視を始めたフォルダは dirty にする（監視を始める前の変更を取りこぼさない）。
- 検索対象が 0 件で起動しても、追加されれば追跡を始める。
- USN が使えるボリュームでは、ポーリングを起動する。
- 無効な対象、存在しないフォルダ、Web の対象は監視しない。
- 削除済みのファイルは、親フォルダとファイル名からパスを復元する（無関係な場所の削除で検索対象を更新しない）。
- パスを解決できない変更は 1 分に 1 回まで dirty にする。ボリューム全体の一時ファイルの削除で
  毎秒 dirty になると、2 秒の静止を待つ更新がいつまでも始まらない。通知は捨てず、間隔が空いたら反映する。
"""

from __future__ import annotations

import sqlite3
import time
from collections.abc import Callable
from pathlib import Path

import pytest

from app.db.schema import initialize_schema
from app.services.windows_change_tracking import (
    UNRESOLVED_CHANGE_DIRTY_INTERVAL_SECONDS,
    USN_REASON_CLOSE,
    USN_REASON_FILE_DELETE,
    UsnJournalInfo,
    UsnReadResult,
    WindowsChangeApi,
    WindowsChangeTracker,
    collect_changed_paths,
)


class FakeWindowsApi:
    """USN の可否を切り替えられる API の代用品。"""

    def __init__(self, *, usn_available: bool) -> None:
        self.usn_available = usn_available
        self.unresolved_changes = False
        self.watched: list[str] = []
        self.callback: Callable[[tuple[str, ...]], None] | None = None

    def volume_for_path(self, path: str) -> str:
        return "C:\\"

    def query_journal(self, volume: str) -> UsnJournalInfo:
        if not self.usn_available:
            raise OSError("USN を開けない")
        return UsnJournalInfo(1, 1_000_000)

    def read_journal(self, volume: str, journal_id: int, start_usn: int) -> UsnReadResult:
        return UsnReadResult(next_usn=start_usn, has_relevant_changes=self.unresolved_changes, changed_paths=())

    def start_directory_watch(self, paths: tuple[str, ...], callback: Callable[[tuple[str, ...]], None]) -> bool:
        self.watched.extend(paths)
        self.callback = callback
        return True

    def stop_directory_watch(self) -> None:
        return None


@pytest.fixture
def database(tmp_path: Path):
    path = tmp_path / "search.db"
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    connection.commit()
    connection.close()

    def connect() -> sqlite3.Connection:
        created = sqlite3.connect(path)
        created.row_factory = sqlite3.Row
        return created

    return connect


def _add_target(connect, full_path: str, *, enabled: int = 1, source_type: str = "local") -> None:
    connection = connect()
    connection.execute(
        """
        INSERT INTO targets (full_path, index_depth, exclude_keywords, source_type, is_search_target_enabled, created_at, updated_at)
        VALUES (?, 5, '', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """,
        (full_path, source_type, enabled),
    )
    connection.commit()
    connection.close()


def _dirty_paths(connect) -> list[str]:
    connection = connect()
    try:
        rows = connection.execute(
            """
            SELECT targets.full_path FROM target_change_states
            JOIN targets ON targets.id = target_change_states.target_id
            WHERE target_change_states.is_dirty = 1
            """
        ).fetchall()
        return [str(row[0]) for row in rows]
    finally:
        connection.close()


def _folder(tmp_path: Path, name: str) -> str:
    path = tmp_path / name
    path.mkdir()
    return path.as_posix()


def test_target_added_after_startup_is_watched_and_marked_dirty(database, tmp_path: Path) -> None:
    api = FakeWindowsApi(usn_available=False)
    tracker = WindowsChangeTracker(database, api=api)
    assert tracker.start() is False

    folder = _folder(tmp_path, "added")
    _add_target(database, folder)
    assert tracker.sync_watches() is True
    tracker.stop()

    assert api.watched == [folder]
    assert _dirty_paths(database) == [folder]


def test_each_folder_is_watched_once(database, tmp_path: Path) -> None:
    api = FakeWindowsApi(usn_available=False)
    first = _folder(tmp_path, "first")
    _add_target(database, first)
    tracker = WindowsChangeTracker(database, api=api)
    tracker.start()
    tracker.sync_watches()
    tracker.sync_watches()

    second = _folder(tmp_path, "second")
    _add_target(database, second)
    tracker.sync_watches()
    tracker.sync_watches()
    tracker.stop()

    assert sorted(api.watched) == sorted([first, second])


def test_change_in_a_folder_added_later_marks_it_dirty(database, tmp_path: Path) -> None:
    api = FakeWindowsApi(usn_available=False)
    tracker = WindowsChangeTracker(database, api=api)
    tracker.start()
    folder = _folder(tmp_path, "added")
    _add_target(database, folder)
    tracker.sync_watches()
    connection = database()
    connection.execute("UPDATE target_change_states SET is_dirty = 0")
    connection.commit()
    connection.close()

    assert api.callback is not None
    api.callback((f"{folder}/note.md",))
    tracker.stop()

    assert _dirty_paths(database) == [folder]


def test_polling_starts_when_a_target_on_a_usn_volume_is_added(database, tmp_path: Path) -> None:
    api = FakeWindowsApi(usn_available=True)
    tracker = WindowsChangeTracker(database, api=api)
    assert tracker.start() is False

    _add_target(database, _folder(tmp_path, "added"))
    assert tracker.sync_watches() is True
    tracker.stop()

    assert api.watched == []


def test_disabled_missing_and_web_targets_are_not_watched(database, tmp_path: Path) -> None:
    api = FakeWindowsApi(usn_available=False)
    tracker = WindowsChangeTracker(database, api=api)
    tracker.start()
    _add_target(database, _folder(tmp_path, "disabled"), enabled=0)
    _add_target(database, (tmp_path / "missing").as_posix())
    _add_target(database, "https://example.com/docs/", source_type="web")

    assert tracker.sync_watches() is False
    tracker.stop()

    assert api.watched == []


def _usn_record(*, file_reference: int, parent_reference: int, reason: int, name: str) -> bytes:
    encoded = name.encode("utf-16-le")
    length = 60 + len(encoded)
    return (
        length.to_bytes(4, "little")
        + (2).to_bytes(2, "little")
        + (0).to_bytes(2, "little")
        + file_reference.to_bytes(8, "little")
        + parent_reference.to_bytes(8, "little")
        + bytes(16)
        + reason.to_bytes(4, "little")
        + bytes(12)
        + len(encoded).to_bytes(2, "little")
        + (60).to_bytes(2, "little")
        + encoded
    )


def _journal(*records: bytes) -> bytes:
    return (123).to_bytes(8, "little") + b"".join(records)


def test_deleted_file_path_is_restored_from_the_parent_folder() -> None:
    raw = _journal(_usn_record(file_reference=5, parent_reference=9, reason=USN_REASON_FILE_DELETE, name="消えた.md"))
    resolved = {9: "C:/work/notes"}

    assert collect_changed_paths(raw, resolved.get) == (("C:/work/notes/消えた.md",), True, False)


def test_path_falls_back_to_the_file_id_when_the_parent_cannot_be_opened() -> None:
    raw = _journal(_usn_record(file_reference=5, parent_reference=9, reason=USN_REASON_FILE_DELETE, name="a.md"))
    resolved = {5: "C:/work/a.md"}

    assert collect_changed_paths(raw, resolved.get) == (("C:/work/a.md",), True, False)


def test_files_in_the_same_folder_need_only_one_lookup() -> None:
    """ボリューム全体の記録を毎秒読むので、ファイルごとに ID を開かない。"""
    calls: list[int] = []

    def resolve(file_reference: int) -> str | None:
        calls.append(file_reference)
        return "C:/work"

    raw = _journal(*[_usn_record(file_reference=index, parent_reference=9, reason=USN_REASON_FILE_DELETE, name=f"{index}.md") for index in range(1, 51)])

    assert len(collect_changed_paths(raw, resolve)[0]) == 50
    assert calls == [9]


def test_unresolved_when_the_parent_folder_is_gone_too() -> None:
    raw = _journal(_usn_record(file_reference=5, parent_reference=9, reason=USN_REASON_FILE_DELETE, name="a.md"))

    assert collect_changed_paths(raw, {}.get) == ((), True, True)


def test_irrelevant_records_are_skipped() -> None:
    raw = _journal(_usn_record(file_reference=5, parent_reference=9, reason=USN_REASON_CLOSE, name="a.md"))

    assert collect_changed_paths(raw, {5: "C:/a.md"}.get) == ((), False, False)


@pytest.mark.parametrize(("reason", "expected"), [(0x00000002, False), (0x00000002 | USN_REASON_CLOSE, True), (0x00000004 | USN_REASON_CLOSE, True)])
def test_content_change_counts_when_the_file_is_closed(reason: int, expected: bool) -> None:
    """上書き・追記は、書き込みの途中ではなくファイルが閉じられた記録で検知する。"""
    raw = _journal(_usn_record(file_reference=5, parent_reference=9, reason=reason, name="a.md"))

    paths, relevant, _unresolved = collect_changed_paths(raw, {5: "C:/a.md"}.get)

    assert relevant is expected
    assert paths == (("C:/a.md",) if expected else ())


def test_mixed_read_reports_both_paths_and_unresolved_changes() -> None:
    raw = _journal(
        _usn_record(file_reference=5, parent_reference=9, reason=USN_REASON_FILE_DELETE, name="a.md"),
        _usn_record(file_reference=6, parent_reference=7, reason=USN_REASON_FILE_DELETE, name="b.md"),
    )

    assert collect_changed_paths(raw, {5: "C:/a.md"}.get) == (("C:/a.md",), True, True)


def test_each_file_id_is_resolved_once_in_a_read() -> None:
    calls: list[int] = []

    def resolve(file_reference: int) -> str | None:
        calls.append(file_reference)
        return "C:/work" if file_reference == 9 else None

    raw = _journal(*[_usn_record(file_reference=index, parent_reference=9, reason=USN_REASON_FILE_DELETE, name=f"{index}.md") for index in (1, 2, 3)])

    assert len(collect_changed_paths(raw, resolve)[0]) == 3
    assert calls.count(9) == 1


def test_changes_outside_the_targets_are_not_resolved(database, tmp_path: Path) -> None:
    """ボリューム全体の通知が毎秒来るので、検索対象の外のパスには実ファイルの確認（resolve）をしない。"""
    api = FakeWindowsApi(usn_available=True)
    folder = _folder(tmp_path, "work")
    _add_target(database, folder)
    checked: list[str] = []

    def ignored(path: str) -> bool:
        checked.append(path)
        return False

    api.read_journal = lambda volume, journal_id, start_usn: UsnReadResult(
        next_usn=start_usn,
        changed_paths=("C:/Windows/Temp/x.tmp", f"{folder}/note.md"),
        has_relevant_changes=True,
    )
    tracker = WindowsChangeTracker(database, api=api, ignored_paths=ignored)
    tracker.reconcile_once()
    tracker.reconcile_once()

    assert checked == [f"{folder}/note.md"]


def test_unresolved_changes_mark_targets_dirty_at_most_once_per_interval(database, tmp_path: Path) -> None:
    api = FakeWindowsApi(usn_available=True)
    now = [1000.0]
    folder = _folder(tmp_path, "work")
    _add_target(database, folder)
    tracker = WindowsChangeTracker(database, api=api, clock=lambda: now[0])
    tracker.reconcile_once()

    def clear_dirty() -> None:
        connection = database()
        connection.execute("UPDATE target_change_states SET is_dirty = 0")
        connection.commit()
        connection.close()

    clear_dirty()
    api.unresolved_changes = True
    tracker.reconcile_once()
    assert _dirty_paths(database) == [folder]

    clear_dirty()
    now[0] += 1
    tracker.reconcile_once()
    assert _dirty_paths(database) == []

    # 間隔が空いたら、途中で来た通知もまとめて反映する（捨てない）
    api.unresolved_changes = False
    now[0] += UNRESOLVED_CHANGE_DIRTY_INTERVAL_SECONDS
    tracker.reconcile_once()
    assert _dirty_paths(database) == [folder]

    clear_dirty()
    now[0] += UNRESOLVED_CHANGE_DIRTY_INTERVAL_SECONDS
    tracker.reconcile_once()
    assert _dirty_paths(database) == []


def _journal_or_skip(api: WindowsChangeApi, folder: Path) -> tuple[str, UsnJournalInfo]:
    if not api.is_available():
        pytest.skip("Windows 専用のテスト")
    try:
        volume = api.volume_for_path(str(folder))
        return volume, api.query_journal(volume)
    except OSError as error:
        pytest.skip(f"USN Journal を読めない環境: {error}")


def _read_until(api: WindowsChangeApi, volume: str, journal: UsnJournalInfo, predicate) -> UsnReadResult:
    """通知が記録されるまで待って読む。ボリューム全体の記録が多いので、位置を進めながら読み続ける。"""
    cursor = journal.next_usn
    paths: list[str] = []
    for _ in range(40):
        result = api.read_journal(volume, journal.journal_id, cursor)
        cursor = result.next_usn
        paths.extend(result.changed_paths)
        if predicate(paths):
            break
        time.sleep(0.1)
    return UsnReadResult(next_usn=cursor, changed_paths=tuple(paths))


def test_real_usn_journal_resolves_changed_and_deleted_paths(tmp_path: Path) -> None:
    """実際の USN Journal で、書き換え・新規作成・削除のパスを解決できる。"""
    api = WindowsChangeApi()
    folder = tmp_path.resolve()
    existing = folder / "existing.md"
    existing.write_text("before", encoding="utf-8")
    volume, journal = _journal_or_skip(api, folder)

    existing.write_text("after", encoding="utf-8")
    created = folder / "created.md"
    created.write_text("new", encoding="utf-8")
    deleted = folder / "deleted.md"
    deleted.write_text("gone", encoding="utf-8")
    deleted.unlink()

    expected = {str(existing).lower(), str(created).lower(), str(deleted).lower()}

    def normalized(paths: list[str]) -> set[str]:
        return {Path(path).as_posix().lower().replace("/", "\\") for path in paths}

    result = _read_until(api, volume, journal, lambda paths: expected <= normalized(paths))

    assert expected <= normalized(list(result.changed_paths))
