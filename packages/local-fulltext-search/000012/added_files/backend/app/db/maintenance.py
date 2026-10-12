"""
全文検索DB・ベクトルDBの保守（空き領域の回収）。

仕様:
- SQLite は行を削除してもファイルを縮めず、FTS5 は削除済みデータの残骸を索引内に持ち続ける。
  検索対象フォルダの削除や大量の再インデックスを繰り返すと、DB ファイルが実データの何十倍にも膨らむ。
- compact_search_database は FTS5 索引を 1 セグメントへ統合（optimize）したうえで VACUUM し、空き領域を OS へ返す。
  検索結果・クリック履歴・設定などのデータは変更しない。
- VACUUM 中は DB 全体をロックし、一時的に DB と同程度の空きディスクを使う。
  そのためアプリの稼働中には実行せず、停止中に `python compact_db.py` から実行する。
- インデックス実行中（index_runs.is_running = 1）の DB には実行しない。
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path

SEARCH_FTS_TABLES = ("file_segments_fts", "files_name_fts")


class DatabaseBusyError(RuntimeError):
    """インデックス実行中のため保守処理を行えないことを表す。"""


@dataclass(frozen=True)
class CompactionResult:
    """保守処理の前後の DB サイズ（バイト）。"""

    path: str
    size_before: int
    size_after: int

    @property
    def reclaimed_bytes(self) -> int:
        return max(self.size_before - self.size_after, 0)


def _database_size(connection: sqlite3.Connection) -> int:
    page_count = int(connection.execute("PRAGMA page_count").fetchone()[0])
    page_size = int(connection.execute("PRAGMA page_size").fetchone()[0])
    return page_count * page_size


def _has_table(connection: sqlite3.Connection, table_name: str) -> bool:
    row = connection.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", (table_name,)
    ).fetchone()
    return bool(row[0])


def _vacuum(connection: sqlite3.Connection) -> None:
    """未コミットの変更を確定し、WAL を本体へ反映してから空き領域を回収する。"""
    connection.commit()
    connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    connection.execute("VACUUM")
    connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")


def compact_search_database(db_path: str | Path) -> CompactionResult:
    """全文検索DBの FTS5 索引を統合し、空き領域を回収する。"""
    resolved_path = str(Path(db_path).resolve())
    connection = sqlite3.connect(resolved_path, timeout=30.0, isolation_level=None)
    try:
        if _has_table(connection, "index_runs"):
            row = connection.execute("SELECT is_running FROM index_runs WHERE id = 1").fetchone()
            if row is not None and int(row[0] or 0):
                raise DatabaseBusyError("Indexing is running. Stop it before compacting the database.")
        size_before = _database_size(connection)
        for table_name in SEARCH_FTS_TABLES:
            if _has_table(connection, table_name):
                connection.execute(f"INSERT INTO {table_name}({table_name}) VALUES ('optimize')")
        _vacuum(connection)
        size_after = _database_size(connection)
    finally:
        connection.close()
    return CompactionResult(path=resolved_path, size_before=size_before, size_after=size_after)


def compact_vector_database(db_path: str | Path) -> CompactionResult:
    """ベクトルDBの空き領域を回収する（文書・チャンクの内容は変更しない）。"""
    resolved_path = str(Path(db_path).resolve())
    connection = sqlite3.connect(resolved_path, timeout=30.0, isolation_level=None)
    try:
        size_before = _database_size(connection)
        _vacuum(connection)
        size_after = _database_size(connection)
    finally:
        connection.close()
    return CompactionResult(path=resolved_path, size_before=size_before, size_after=size_after)
