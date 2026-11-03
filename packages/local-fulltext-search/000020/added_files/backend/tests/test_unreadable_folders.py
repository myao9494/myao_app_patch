"""
走査で読めなかった場所のインデックスを消さないことのテスト。

一時的に読めないだけのフォルダ（権限・ロック・ネットワークの瞬断）を「ファイルが消えた」と扱うと、
インデックスが消える。ベクトルインデックスは再作成に何時間もかかる。

仕様:
- 走査で読めなかったフォルダの配下は、全文インデックスの削除の対象にしない。
- 対象フォルダ自体が読めないときも何も消さない。
- 読めなかったフォルダを除外キーワードへは追加しない（一時的な事象のため）。
- ベクトルインデックスの削除候補にも出さない。
- 読めるようになれば、次の走査で通常どおり更新する。消えたファイルはそのときに消す。
"""

import os
import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

from app.db.schema import initialize_schema
from app.services.index_service import IndexService
from app.vector.state import VectorState


@contextmanager
def _unreadable(suffix: str, error: OSError) -> Iterator[None]:
    """パスの末尾が suffix のフォルダの os.scandir を失敗させる。"""
    real_scandir = os.scandir

    def flaky_scandir(path: object = ".") -> object:
        if str(path).endswith(suffix):
            raise error
        return real_scandir(path)

    os.scandir = flaky_scandir  # type: ignore[assignment]
    try:
        yield
    finally:
        os.scandir = real_scandir


@pytest.fixture
def indexed(tmp_path: Path):
    connection = sqlite3.connect(tmp_path / "search.db")
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    service = IndexService(connection=connection)
    target = (tmp_path / "work").resolve()
    (target / "sub").mkdir(parents=True)
    (target / "keep.md").write_text("keep", encoding="utf-8")
    (target / "sub" / "inner.md").write_text("inner", encoding="utf-8")

    def scan() -> None:
        service.ensure_fresh_target(full_path=target.as_posix(), refresh_window_minutes=0, index_depth=5)

    def names() -> list[str]:
        return [str(row[0]) for row in connection.execute("SELECT file_name FROM files ORDER BY file_name")]

    scan()
    assert names() == ["inner.md", "keep.md"]
    try:
        yield {"target": target, "scan": scan, "names": names, "connection": connection}
    finally:
        connection.close()


FOLDER_ERRORS = [
    PermissionError(13, "Access is denied"),
    OSError(64, "The specified network name is no longer available"),
    OSError(53, "The network path was not found"),
    OSError(121, "The semaphore timeout period has expired"),
]


@pytest.mark.parametrize("error", FOLDER_ERRORS, ids=["権限", "ネットワーク切断", "ネットワーク不明", "タイムアウト"])
def test_unreadable_subfolder_keeps_its_index(indexed: dict, error: OSError) -> None:
    with _unreadable("sub", error):
        indexed["scan"]()

    assert indexed["names"]() == ["inner.md", "keep.md"]


def test_unreadable_target_folder_keeps_the_whole_index(indexed: dict) -> None:
    with _unreadable("work", PermissionError(13, "Access is denied")):
        try:
            indexed["scan"]()
        except Exception:
            pass

    assert indexed["names"]() == ["inner.md", "keep.md"]


def test_unreadable_folder_is_not_added_to_the_exclusions(indexed: dict) -> None:
    with _unreadable("sub", PermissionError(13, "Access is denied")):
        indexed["scan"]()

    keywords = indexed["connection"].execute("SELECT exclude_keywords FROM targets").fetchone()[0]
    assert "sub" not in (keywords or "")


def test_deleted_file_is_removed_once_the_folder_is_readable_again(indexed: dict) -> None:
    with _unreadable("sub", PermissionError(13, "Access is denied")):
        indexed["scan"]()
    (indexed["target"] / "sub" / "inner.md").unlink()

    indexed["scan"]()

    assert indexed["names"]() == ["keep.md"]


def test_file_that_cannot_be_inspected_keeps_its_index(indexed: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    real_stat = Path.stat

    def flaky_stat(self: Path, *args: object, **kwargs: object) -> os.stat_result:
        if self.name == "inner.md":
            raise PermissionError(13, "Access is denied")
        return real_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", flaky_stat)
    indexed["scan"]()

    assert indexed["names"]() == ["inner.md", "keep.md"]


def _vector_state(tmp_path: Path) -> tuple[VectorState, Path]:
    folder = (tmp_path / "notes").resolve()
    (folder / "sub").mkdir(parents=True)
    (folder / "keep.md").write_text("keep", encoding="utf-8")
    (folder / "sub" / "inner.md").write_text("inner", encoding="utf-8")
    state = VectorState(data_dir=tmp_path)
    state.load_model(use_mock=True, mock_dim=32)
    state.sync_index(target_folders=[str(folder)], exclude_keywords="")
    return state, folder


def test_vector_deletion_candidates_skip_unreadable_folders(tmp_path: Path) -> None:
    state, folder = _vector_state(tmp_path)

    with _unreadable("sub", PermissionError(13, "Access is denied")):
        pending = state.get_pending_deletions(target_folders=[str(folder)])

    assert pending == []


def test_vector_sync_with_cleanup_keeps_unreadable_folders(tmp_path: Path) -> None:
    state, folder = _vector_state(tmp_path)

    with _unreadable("sub", OSError(64, "The specified network name is no longer available")):
        state.sync_index(target_folders=[str(folder)], exclude_keywords="", clean_deleted_files=True)

    assert state.get_pending_deletions(target_folders=[str(folder)]) == []
    with state_db(state) as count:
        assert count() == 2


@contextmanager
def state_db(state: VectorState) -> Iterator[Callable[[], int]]:
    from app.vector.db import open_db

    with open_db(state.searcher.db_path) as connection:
        yield lambda: int(connection.execute("SELECT count(*) FROM documents").fetchone()[0])
