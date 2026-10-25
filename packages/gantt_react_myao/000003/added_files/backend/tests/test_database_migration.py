"""
init_db() の後方互換マイグレーション（is_pinned 追加前に作られたDBの読み込み）のテスト。
"""
from sqlalchemy import create_engine, text

import database

OLD_TASK_COLUMNS = (
    "id INTEGER PRIMARY KEY, text TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL"
)


def column_names(engine, table: str) -> set[str]:
    with engine.connect() as connection:
        return {row[1] for row in connection.execute(text(f"PRAGMA table_info({table})"))}


def test_init_db_adds_is_pinned_to_databases_created_before_the_column_existed(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{(tmp_path / 'old.db').as_posix()}")
    with engine.begin() as connection:
        for table in ("tasks", "grid_tasks"):
            connection.execute(text(f"CREATE TABLE {table} ({OLD_TASK_COLUMNS})"))
        connection.execute(
            text("INSERT INTO tasks (id, text, start_date, end_date) VALUES (1, 'Old', 's', 'e')")
        )
    monkeypatch.setattr(database, "engine", engine)

    database.init_db()

    assert "is_pinned" in column_names(engine, "tasks")
    assert "is_pinned" in column_names(engine, "grid_tasks")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT text, is_pinned FROM tasks")).one() == ("Old", 0)
    engine.dispose()


def test_init_db_twice_does_not_fail_or_change_the_schema(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{(tmp_path / 'new.db').as_posix()}")
    monkeypatch.setattr(database, "engine", engine)

    database.init_db()
    columns = column_names(engine, "tasks")
    database.init_db()

    assert column_names(engine, "tasks") == columns
    engine.dispose()
