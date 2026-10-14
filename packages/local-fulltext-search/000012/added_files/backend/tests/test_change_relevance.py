"""
変更通知がインデックスへ影響しうるかの判定（app.services.change_relevance）の単体テスト。

仕様:
- 検索対象フォルダ配下の変更だけが、その対象を dirty にする。
- 除外キーワード（名前形式・パス形式・`foo/.` 形式）に該当する変更は、走査しても結果が変わらないため無視する。
- 判定はインデックス走査と同じ規則で、`old` が `older` に誤一致するような過剰な除外はしない。
- macOS(FSEvents) と Windows(ReadDirectoryChangesW / USN) の両方の dirty 化経路に適用される。
"""

import sqlite3
from pathlib import Path

import pytest

from app.db.schema import initialize_schema
from app.services.change_relevance import find_targets_affected_by_changes, is_change_relevant_to_target
from app.services.change_tracking_service import ChangeTrackingService
from app.services.windows_change_tracking import WindowsChangeTracker

ROOT = "/Users/me/work"


@pytest.mark.parametrize(
    ("changed_path", "exclude_keywords", "expected"),
    [
        # 対象フォルダ配下の通常ファイル
        (f"{ROOT}/notes/todo.md", "", True),
        (f"{ROOT}/notes/todo.md", ".git\nnode_modules", True),
        # 対象フォルダ自身への通知は常に関係あり
        (ROOT, ".git", True),
        # 対象フォルダの外・前方一致するだけの別フォルダ
        ("/Users/me/other/todo.md", "", False),
        ("/Users/me/work2/todo.md", "", False),
        # 名前形式の除外（フォルダ名・ドット始まり・ファイル名）
        (f"{ROOT}/repo/.git/index.lock", ".git", False),
        (f"{ROOT}/repo/node_modules/pkg/index.js", "node_modules", False),
        # 記号だけの名前キーワードは部分一致（インデックス走査と同じ規則。Office の一時ファイル ~$xxx を除外できる）
        (f"{ROOT}/docs/~$draft.docx", "~$", False),
        (f"{ROOT}/docs/~$/draft.docx", "~$", False),
        (f"{ROOT}/docs/backup/report.md", "backup", False),
        # 単語境界: old は older に一致しない
        (f"{ROOT}/older/report.md", "old", True),
        (f"{ROOT}/old/report.md", "old", False),
        (f"{ROOT}/archive_old/report.md", "old", False),
        # パス形式（絶対パス）: 先頭一致
        (f"{ROOT}/app/src/main.py", f"{ROOT}/app", False),
        (f"{ROOT}/application/main.py", f"{ROOT}/app", True),
        # パス形式（相対パス）: 祖先の途中一致
        (f"{ROOT}/vault/plugins/data.json", "vault/plugins", False),
        (f"{ROOT}/vault/notes/data.json", "vault/plugins", True),
        # foo/. 形式: foo 配下のドット始まり要素
        (f"{ROOT}/vault/.obsidian/plugins/x/data.json", "vault/.", False),
        (f"{ROOT}/vault/notes/a.md", "vault/.", True),
        # 非 ASCII キーワードは部分一致
        (f"{ROOT}/資料_旧版/a.md", "旧", False),
    ],
)
def test_is_change_relevant_to_target(changed_path: str, exclude_keywords: str, expected: bool) -> None:
    assert is_change_relevant_to_target(changed_path, ROOT, exclude_keywords) is expected


def test_find_targets_affected_by_changes_uses_each_targets_own_exclude_keywords() -> None:
    targets = [
        {"id": 1, "full_path": "/data/a", "exclude_keywords": ".git"},
        {"id": 2, "full_path": "/data/b", "exclude_keywords": ""},
        {"id": 3, "full_path": "/data/c", "exclude_keywords": None},
    ]

    affected = find_targets_affected_by_changes(
        targets,
        ["/data/a/repo/.git/HEAD", "/data/b/repo/.git/HEAD", "/elsewhere/x.md"],
    )

    assert [target["id"] for target in affected] == [2]


def _create_database(tmp_path: Path, root: Path, exclude_keywords: str) -> Path:
    database_path = tmp_path / "search.db"
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    connection.execute(
        """
        INSERT INTO targets (full_path, index_depth, exclude_keywords, source_type, created_at, updated_at)
        VALUES (?, 5, ?, 'local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """,
        (root.as_posix(), exclude_keywords),
    )
    connection.commit()
    connection.close()
    return database_path


def _dirty_flags(database_path: Path) -> list[int | None]:
    connection = sqlite3.connect(database_path)
    try:
        rows = connection.execute(
            """
            SELECT target_change_states.is_dirty
            FROM targets
            LEFT JOIN target_change_states ON target_change_states.target_id = targets.id
            """
        ).fetchall()
        return [row[0] for row in rows]
    finally:
        connection.close()


def _connection_factory(database_path: Path):
    def create_connection() -> sqlite3.Connection:
        connection = sqlite3.connect(database_path)
        connection.row_factory = sqlite3.Row
        return connection

    return create_connection


def test_fsevents_change_inside_excluded_folder_does_not_mark_target_dirty(tmp_path: Path) -> None:
    root = (tmp_path / "work").resolve()
    root.mkdir()
    database_path = _create_database(tmp_path, root, ".git\nnode_modules")
    service = ChangeTrackingService(connection_factory=_connection_factory(database_path), ignored_paths=(tmp_path / "data",))

    service.mark_changed_paths((str(root / "repo" / ".git" / "index.lock"), str(root / "node_modules" / "a.js")))
    assert _dirty_flags(database_path) == [None]

    service.mark_changed_paths((str(root / "repo" / ".git" / "index.lock"), str(root / "repo" / "README.md")))
    assert _dirty_flags(database_path) == [1]


def test_windows_change_inside_excluded_folder_does_not_mark_target_dirty(tmp_path: Path) -> None:
    root = (tmp_path / "work").resolve()
    root.mkdir()
    database_path = _create_database(tmp_path, root, ".git")
    tracker = WindowsChangeTracker(_connection_factory(database_path))

    tracker.mark_changed_paths((str(root / "repo" / ".git" / "index.lock"),))
    assert _dirty_flags(database_path) == [None]

    tracker.mark_changed_paths((str(root / "notes" / "todo.md"),))
    assert _dirty_flags(database_path) == [1]


def test_rotated_backend_log_is_treated_as_internal_change(tmp_path: Path) -> None:
    root = (tmp_path / "work").resolve()
    root.mkdir()
    log_path = root / "app" / "backend.log"
    database_path = _create_database(tmp_path, root, "")
    service = ChangeTrackingService(connection_factory=_connection_factory(database_path), ignored_paths=(log_path,))

    service.mark_changed_paths((str(log_path), f"{log_path}.1", f"{log_path}.5"))
    assert _dirty_flags(database_path) == [None]

    service.mark_changed_paths((str(root / "app" / "backend.logic.md"),))
    assert _dirty_flags(database_path) == [1]
