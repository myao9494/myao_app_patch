"""
全文検索DBのスキーマ初期化・移行のテスト。

- 新しい DB には全テーブルを作る。
- 旧版の DB は、足りない列を追加するだけでデータを残す。
- 知らない列が増えているだけの DB は、そのまま使う。
- 移行できない DB は、退避コピーを残してから作り直す（インデックスを黙って消さない）。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from app.db.schema import initialize_schema, reclaim_free_pages, reset_schema


def _connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    return connection


def _columns(connection: sqlite3.Connection, table_name: str) -> set[str]:
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table_name})")}


def _insert_file(connection: sqlite3.Connection, path: str) -> None:
    connection.execute(
        """
        INSERT INTO files (full_path, normalized_path, file_name, file_ext, created_at, mtime, size, indexed_at)
        VALUES (?, ?, ?, '.md', 1.0, 1.0, 10, '2026-01-01T00:00:00+00:00')
        """,
        (path, path, Path(path).name),
    )


def _backup_files(db_path: Path) -> list[Path]:
    return sorted(db_path.parent.glob(f"{db_path.name}.incompatible-*"))


def test_initialize_schema_creates_all_tables_on_new_database(tmp_path: Path) -> None:
    connection = _connect(tmp_path / "search.db")
    try:
        initialize_schema(connection)
        tables = {
            str(row[0]) for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
    finally:
        connection.close()

    assert {"targets", "files", "file_segments", "index_runs", "failed_files", "scheduler_settings"} <= tables


def test_initialize_schema_is_idempotent_and_keeps_rows(tmp_path: Path) -> None:
    connection = _connect(tmp_path / "search.db")
    try:
        initialize_schema(connection)
        _insert_file(connection, "/docs/a.md")
        connection.commit()

        initialize_schema(connection)

        count = connection.execute("SELECT COUNT(*) FROM files").fetchone()[0]
    finally:
        connection.close()

    assert count == 1
    assert _backup_files(tmp_path / "search.db") == []


def test_initialize_schema_adds_missing_columns_to_legacy_database(tmp_path: Path) -> None:
    """旧版（クリック数・Obsidian 情報・source_type・中止要求の列が無い）の DB を、行を残したまま移行する。"""
    db_path = tmp_path / "search.db"
    connection = _connect(db_path)
    try:
        connection.executescript(
            """
            CREATE TABLE targets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                full_path TEXT NOT NULL,
                last_indexed_at TEXT,
                exclude_keywords TEXT NOT NULL DEFAULT '',
                index_depth INTEGER NOT NULL DEFAULT 1,
                selected_extensions TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(full_path)
            );
            CREATE TABLE files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                full_path TEXT NOT NULL,
                normalized_path TEXT NOT NULL UNIQUE,
                file_name TEXT NOT NULL,
                file_ext TEXT NOT NULL,
                created_at REAL NOT NULL,
                mtime REAL NOT NULL,
                size INTEGER NOT NULL,
                indexed_at TEXT NOT NULL,
                last_error TEXT
            );
            CREATE TABLE index_runs (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                is_running INTEGER NOT NULL DEFAULT 0,
                last_started_at TEXT,
                last_finished_at TEXT,
                last_error TEXT,
                total_files INTEGER NOT NULL DEFAULT 0,
                error_count INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO targets (full_path, created_at, updated_at) VALUES ('/docs', 'now', 'now');
            INSERT INTO index_runs (id, is_running, total_files, error_count) VALUES (1, 0, 5, 0);
            """
        )
        _insert_file(connection, "/docs/a.md")
        connection.commit()

        initialize_schema(connection)

        file_row = connection.execute("SELECT * FROM files").fetchone()
        target_row = connection.execute("SELECT * FROM targets").fetchone()
        run_row = connection.execute("SELECT * FROM index_runs").fetchone()
        name_hits = connection.execute(
            "SELECT COUNT(*) FROM files_name_fts WHERE files_name_fts MATCH '\"a.md\"'"
        ).fetchone()[0]
    finally:
        connection.close()

    assert file_row["normalized_path"] == "/docs/a.md"
    assert file_row["click_count"] == 0
    assert file_row["source_type"] == "local"
    assert target_row["full_path"] == "/docs"
    assert target_row["is_search_target_enabled"] == 1
    assert target_row["source_type"] == "local"
    assert run_row["total_files"] == 5
    assert run_row["cancel_requested"] == 0
    assert name_hits == 1
    assert _backup_files(db_path) == []


def test_initialize_schema_keeps_database_with_unknown_extra_columns(tmp_path: Path) -> None:
    """新しい版が追加した列が残っている DB を古い版で開いても、インデックスを消さない。"""
    db_path = tmp_path / "search.db"
    connection = _connect(db_path)
    try:
        initialize_schema(connection)
        connection.execute("ALTER TABLE files ADD COLUMN future_column TEXT")
        connection.execute("ALTER TABLE scheduler_logs ADD COLUMN future_column TEXT")
        _insert_file(connection, "/docs/a.md")
        connection.commit()

        initialize_schema(connection)

        count = connection.execute("SELECT COUNT(*) FROM files").fetchone()[0]
    finally:
        connection.close()

    assert count == 1
    assert _backup_files(db_path) == []


def test_initialize_schema_backs_up_incompatible_database_before_rebuilding(tmp_path: Path) -> None:
    """必須列が欠けていて移行できない DB は、退避コピーを残してから作り直す。"""
    db_path = tmp_path / "search.db"
    connection = _connect(db_path)
    try:
        connection.executescript(
            """
            CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL);
            INSERT INTO files (path) VALUES ('/docs/old.md');
            """
        )
        connection.commit()

        initialize_schema(connection)

        columns = _columns(connection, "files")
        count = connection.execute("SELECT COUNT(*) FROM files").fetchone()[0]
    finally:
        connection.close()

    assert "normalized_path" in columns
    assert count == 0
    backups = _backup_files(db_path)
    assert len(backups) == 1
    backup = _connect(backups[0])
    try:
        assert backup.execute("SELECT path FROM files").fetchone()[0] == "/docs/old.md"
    finally:
        backup.close()


def test_initialize_schema_backs_up_database_with_legacy_folders_table(tmp_path: Path) -> None:
    db_path = tmp_path / "search.db"
    connection = _connect(db_path)
    try:
        connection.executescript(
            """
            CREATE TABLE folders (id INTEGER PRIMARY KEY, path TEXT NOT NULL);
            INSERT INTO folders (path) VALUES ('/docs');
            """
        )
        connection.commit()

        initialize_schema(connection)

        tables = {
            str(row[0]) for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
    finally:
        connection.close()

    assert "folders" not in tables
    assert "targets" in tables
    assert len(_backup_files(db_path)) == 1


def test_new_database_returns_free_pages_after_reset(tmp_path: Path) -> None:
    """インデックスを初期化したら、DB ファイルが空に近い大きさへ戻る。"""
    db_path = tmp_path / "search.db"
    connection = _connect(db_path)
    try:
        initialize_schema(connection)
        for index in range(200):
            _insert_file(connection, f"/docs/{index}.md")
            file_id = connection.execute("SELECT last_insert_rowid()").fetchone()[0]
            connection.execute(
                "INSERT INTO file_segments (file_id, segment_type, segment_label, content) VALUES (?, 'body', '', ?)",
                (file_id, "本文 " * 2000),
            )
        connection.commit()
        size_before = db_path.stat().st_size

        reset_schema(connection)

        count = connection.execute("SELECT COUNT(*) FROM files").fetchone()[0]
    finally:
        connection.close()

    assert count == 0
    assert db_path.stat().st_size < size_before / 4


def test_reclaim_free_pages_shrinks_new_database_after_rows_are_deleted(tmp_path: Path) -> None:
    """新規に作った DB は、行を削除したあと VACUUM なしで小さくできる。"""
    db_path = tmp_path / "search.db"
    connection = _connect(db_path)
    try:
        initialize_schema(connection)
        for index in range(200):
            _insert_file(connection, f"/docs/{index}.md")
            file_id = connection.execute("SELECT last_insert_rowid()").fetchone()[0]
            connection.execute(
                "INSERT INTO file_segments (file_id, segment_type, segment_label, content) VALUES (?, 'body', '', ?)",
                (file_id, "本文 " * 2000),
            )
        connection.commit()
        size_before = db_path.stat().st_size
        connection.execute("DELETE FROM file_segments")
        connection.execute("DELETE FROM files")
        connection.commit()

        reclaim_free_pages(connection)
    finally:
        connection.close()

    assert db_path.stat().st_size < size_before / 2


def test_database_opened_like_the_app_gets_incremental_auto_vacuum(tmp_path: Path, monkeypatch) -> None:
    """
    アプリの接続（WAL などの PRAGMA を設定済み）で新規に作った DB でも、空き領域を返せる設定になる。
    WAL へ切り替えた時点で DB のヘッダーが書かれるため、あとから auto_vacuum を指定するだけでは効かない。
    """
    from app.config import settings
    from app.db.connection import get_connection

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    connection = get_connection()
    try:
        initialize_schema(connection)
        auto_vacuum = connection.execute("PRAGMA auto_vacuum").fetchone()[0]
        journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
    finally:
        connection.close()

    assert auto_vacuum == 2
    assert journal_mode == "wal"
