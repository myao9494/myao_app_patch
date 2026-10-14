"""
全文検索DB（SQLite）のスキーマ定義・初期化・マイグレーション。
仕様:
- targets（検索対象）、files / file_segments（インデックス本体）、FTS5 仮想テーブルと同期トリガー、
  failed_files、index_runs（実行状態）、スケジューラー・変更追跡・クリック履歴用テーブルを定義する。
- initialize_schema は冪等で、既存DBには不足している列・インデックスだけを追加する。
  列を追加するときは SCHEMA_STATEMENTS の CREATE TABLE を直すだけでよい（既定値を持つ列か NULL 可の列にする）。
  必須の列が欠けている DB は移行できないため、退避コピー（<DB名>.incompatible-<日時>）を残してから作り直す。
- reset_schema は全テーブルを作り直し、インデックスを空の初期状態へ戻す。
- 新規に作る DB は auto_vacuum=INCREMENTAL にし、削除で空いたページを reclaim_free_pages で OS へ返せるようにする。
"""

import logging
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from sqlite3 import Connection, OperationalError

from app.extractors.obsidian_properties import extract_obsidian_title_and_aliases, has_obsidian_top_tag

logger = logging.getLogger(__name__)
_AUTO_VACUUM_INCREMENTAL = 2

SCHEMA_STATEMENTS: list[str] = [
    """
    CREATE TABLE IF NOT EXISTS targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_path TEXT NOT NULL,
        last_indexed_at TEXT,
        exclude_keywords TEXT NOT NULL DEFAULT '',
        index_depth INTEGER NOT NULL DEFAULT 1,
        selected_extensions TEXT NOT NULL DEFAULT '',
        is_search_target_enabled INTEGER NOT NULL DEFAULT 1,
        indexed_file_count INTEGER NOT NULL DEFAULT 0,
        index_version INTEGER NOT NULL DEFAULT 0,
        source_type TEXT NOT NULL DEFAULT 'local',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(full_path)
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_path TEXT NOT NULL,
        normalized_path TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL,
        file_ext TEXT NOT NULL,
        created_at REAL NOT NULL,
        mtime REAL NOT NULL,
        click_count INTEGER NOT NULL DEFAULT 0,
        obsidian_click_count INTEGER NOT NULL DEFAULT 0,
        obsidian_rank_score REAL NOT NULL DEFAULT 0.0,
        has_obsidian_top_tag INTEGER NOT NULL DEFAULT 0,
        obsidian_title TEXT NOT NULL DEFAULT '',
        obsidian_aliases TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL,
        indexed_at TEXT NOT NULL,
        last_error TEXT,
        source_type TEXT NOT NULL DEFAULT 'local'
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS search_query_clicks (
        normalized_query TEXT NOT NULL,
        file_id INTEGER NOT NULL,
        click_count INTEGER NOT NULL DEFAULT 0,
        last_clicked_at TEXT NOT NULL,
        PRIMARY KEY(normalized_query, file_id),
        FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS file_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        segment_type TEXT NOT NULL,
        segment_label TEXT NOT NULL,
        content TEXT NOT NULL,
        FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
    );
    """,
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS file_segments_fts
    USING fts5(content, segment_label, content='file_segments', content_rowid='id');
    """,
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS files_name_fts
    USING fts5(file_name, tokenize='trigram', content='files', content_rowid='id');
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_file_segments_file_id_segment_type
    ON file_segments(file_id, segment_type);
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_files_source_type_normalized_path
    ON files(source_type, normalized_path);
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_targets_enabled_source_type_full_path
    ON targets(is_search_target_enabled, source_type, full_path);
    """,
    """
    CREATE TABLE IF NOT EXISTS index_runs (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        is_running INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        last_started_at TEXT,
        last_finished_at TEXT,
        last_error TEXT,
        total_files INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0
    );
    """,
    """
    INSERT INTO index_runs (id, is_running, cancel_requested, total_files, error_count)
    VALUES (1, 0, 0, 0, 0)
    ON CONFLICT(id) DO NOTHING;
    """,
    """
    CREATE TABLE IF NOT EXISTS failed_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        normalized_path TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL,
        error_message TEXT NOT NULL,
        last_failed_at TEXT NOT NULL
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS target_change_states (
        target_id INTEGER PRIMARY KEY,
        is_tracking INTEGER NOT NULL DEFAULT 0,
        is_dirty INTEGER NOT NULL DEFAULT 1,
        last_event_at TEXT,
        FOREIGN KEY(target_id) REFERENCES targets(id) ON DELETE CASCADE
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS windows_usn_journals (
        volume_path TEXT PRIMARY KEY,
        journal_id INTEGER NOT NULL,
        last_usn INTEGER NOT NULL,
        updated_at TEXT NOT NULL
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS scheduler_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        start_at TEXT,
        is_enabled INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
    );
    """,
    """
    INSERT INTO scheduler_settings (id, start_at, is_enabled, updated_at)
    VALUES (1, NULL, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING;
    """,
    """
    CREATE TABLE IF NOT EXISTS scheduler_paths (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scheduler_id INTEGER NOT NULL,
        folder_path TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        FOREIGN KEY(scheduler_id) REFERENCES scheduler_settings(id) ON DELETE CASCADE
    );
    """,
    """
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduler_paths_unique_order
    ON scheduler_paths(scheduler_id, sort_order);
    """,
    """
    CREATE TABLE IF NOT EXISTS scheduler_runtime (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL DEFAULT 'idle',
        current_path TEXT,
        process_id INTEGER,
        run_token TEXT,
        last_started_at TEXT,
        last_finished_at TEXT,
        last_error TEXT
    );
    """,
    """
    INSERT INTO scheduler_runtime (
        id, status, current_path, process_id, run_token, last_started_at, last_finished_at, last_error
    )
    VALUES (1, 'idle', NULL, NULL, NULL, NULL, NULL, NULL)
    ON CONFLICT(id) DO NOTHING;
    """,
    """
    CREATE TABLE IF NOT EXISTS scheduler_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        logged_at TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        folder_path TEXT
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS scheduler_daily_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_key TEXT NOT NULL UNIQUE,
        scheduled_time TEXT NOT NULL,
        started_at TEXT NOT NULL
    );
    """,
    """
    CREATE TRIGGER IF NOT EXISTS file_segments_ai AFTER INSERT ON file_segments BEGIN
        INSERT INTO file_segments_fts(rowid, content, segment_label)
        VALUES (new.id, new.content, new.segment_label);
    END;
    """,
    """
    CREATE TRIGGER IF NOT EXISTS file_segments_ad AFTER DELETE ON file_segments BEGIN
        INSERT INTO file_segments_fts(file_segments_fts, rowid, content, segment_label)
        VALUES ('delete', old.id, old.content, old.segment_label);
    END;
    """,
    """
    CREATE TRIGGER IF NOT EXISTS file_segments_au AFTER UPDATE ON file_segments BEGIN
        INSERT INTO file_segments_fts(file_segments_fts, rowid, content, segment_label)
        VALUES ('delete', old.id, old.content, old.segment_label);
        INSERT INTO file_segments_fts(rowid, content, segment_label)
        VALUES (new.id, new.content, new.segment_label);
    END;
    """,
    """
    CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
        INSERT INTO files_name_fts(rowid, file_name)
        VALUES (new.id, new.file_name);
    END;
    """,
    """
    CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
        INSERT INTO files_name_fts(files_name_fts, rowid, file_name)
        VALUES ('delete', old.id, old.file_name);
    END;
    """,
    """
    CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE OF file_name ON files BEGIN
        INSERT INTO files_name_fts(files_name_fts, rowid, file_name)
        VALUES ('delete', old.id, old.file_name);
        INSERT INTO files_name_fts(rowid, file_name)
        VALUES (new.id, new.file_name);
    END;
    """,
]


def initialize_schema(connection: Connection) -> None:
    """
    スキーマを最新の状態へそろえる（何度呼んでも同じ結果になる）。
    - 無いテーブルは作る。足りない列は追加する（行は残す）。知らない列が増えているだけなら、そのまま使う。
    - 必須の列が欠けているなど移行できない DB は、退避コピーを残してから作り直す。
    """
    is_new_database = not _list_user_tables(connection)
    if is_new_database:
        _enable_incremental_auto_vacuum(connection)
    incompatibility = _find_incompatibility(connection)
    if incompatibility is not None:
        backup_path = _backup_database(connection)
        logger.warning(
            "The search database cannot be migrated (%s). It was rebuilt from scratch. Backup: %s",
            incompatibility,
            backup_path or "not created (in-memory database)",
        )
        _drop_managed_schema_objects(connection)
    _create_schema_objects(connection)
    connection.commit()


def _enable_incremental_auto_vacuum(connection: Connection) -> None:
    """
    まだテーブルの無い DB を、削除で空いたページを VACUUM なしで返せる設定（auto_vacuum=INCREMENTAL）にする。
    アプリの接続は先に WAL へ切り替えており、その時点で DB のヘッダーが書かれている。
    ヘッダーが書かれたあとは設定だけでは切り替わらないため、VACUUM で作り直して反映する（中身が空なのですぐ終わる）。
    """
    connection.commit()
    try:
        connection.execute("PRAGMA auto_vacuum = INCREMENTAL;")
        connection.execute("VACUUM;")
    except OperationalError as error:
        # 他の接続が使用中などで切り替えられなくても、動作には支障がない（空き領域の自動回収が効かないだけ）
        logger.info("Could not enable incremental auto-vacuum on the new database: %s", error)


def reset_schema(connection: Connection) -> None:
    """
    管理対象の全テーブルと FTS を削除し、空のスキーマを再作成する。
    呼び出し元の接続を維持したまま DB を初期化したいときに使う。削除で空いた領域は OS へ返す。
    """
    _drop_managed_schema_objects(connection)
    _create_schema_objects(connection)
    connection.commit()
    # 初期化直後は中身がほぼ無く VACUUM がすぐ終わるので、旧版の DB もここで作り直す
    reclaim_free_pages(connection, allow_full_vacuum=True)


def reclaim_free_pages(connection: Connection, *, allow_full_vacuum: bool = False) -> None:
    """
    行の削除で空いたページを OS へ返す。
    - auto_vacuum が有効な DB（このアプリが新規に作った DB）では、空きページだけを切り詰める。
    - それ以外の DB は、allow_full_vacuum=True のときだけ VACUUM で作り直す（同時に auto_vacuum を有効にする）。
      VACUUM は DB 全体を書き直すため、中身が大きい DB では `python compact_db.py` を停止中に使う。
    - 他の接続が使用中で排他ロックを取れないときは何もしない。
    """
    connection.commit()
    try:
        if int(connection.execute("PRAGMA auto_vacuum;").fetchone()[0]) == _AUTO_VACUUM_INCREMENTAL:
            connection.execute("PRAGMA incremental_vacuum;").fetchall()
            connection.commit()
            return
        if not allow_full_vacuum or int(connection.execute("PRAGMA freelist_count;").fetchone()[0]) == 0:
            return
        connection.execute("PRAGMA auto_vacuum = INCREMENTAL;")
        connection.execute("VACUUM;")
    except OperationalError as error:
        # 他の接続が読み書き中だと排他ロックを取れない。空き領域は次の機会に返す。
        logger.info("Skipped reclaiming free database pages: %s", error)


def _create_schema_objects(connection: Connection) -> None:
    """
    テーブル → 足りない列 → 索引・トリガー・初期行の順に作る。
    旧版の DB では、索引や初期行が参照する列を先に追加しておく必要がある。
    """
    table_statements = [statement for statement in SCHEMA_STATEMENTS if _is_create_table_statement(statement)]
    other_statements = [statement for statement in SCHEMA_STATEMENTS if not _is_create_table_statement(statement)]
    for statement in table_statements:
        connection.execute(statement)
    _add_missing_columns(connection)
    for statement in other_statements:
        connection.execute(statement)
    _rebuild_files_name_fts(connection)


def _is_create_table_statement(statement: str) -> bool:
    normalized = " ".join(statement.split()).upper()
    return normalized.startswith(("CREATE TABLE", "CREATE VIRTUAL TABLE"))


@dataclass(frozen=True)
class _ColumnDefinition:
    """基準スキーマ上の 1 列（PRAGMA table_info の内容）。"""

    name: str
    declared_type: str
    is_not_null: bool
    default_sql: str | None
    is_primary_key: bool

    @property
    def can_be_added(self) -> bool:
        """既存の行があっても ALTER TABLE ADD COLUMN で追加できるか。"""
        return not self.is_primary_key and (not self.is_not_null or self.default_sql is not None)

    def to_add_column_sql(self, table_name: str) -> str:
        parts = [f"ALTER TABLE {table_name} ADD COLUMN {self.name} {self.declared_type}"]
        if self.is_not_null:
            parts.append("NOT NULL")
        if self.default_sql is not None:
            parts.append(f"DEFAULT {self.default_sql}")
        return " ".join(parts) + ";"


@lru_cache(maxsize=1)
def _reference_columns() -> dict[str, tuple[_ColumnDefinition, ...]]:
    """
    SCHEMA_STATEMENTS が作るテーブルの列定義を返す。
    基準を SCHEMA_STATEMENTS 1 か所にするため、空のメモリ DB に作って読み取る
    （列を追加するときは CREATE TABLE を直すだけでよく、期待する列の一覧を別に持たない）。
    """
    reference = sqlite3.connect(":memory:")
    try:
        for statement in SCHEMA_STATEMENTS:
            reference.execute(statement)
        return {
            table_name: tuple(
                _ColumnDefinition(
                    name=str(row[1]),
                    declared_type=str(row[2]),
                    is_not_null=bool(row[3]),
                    default_sql=None if row[4] is None else str(row[4]),
                    is_primary_key=bool(row[5]),
                )
                for row in reference.execute(f"PRAGMA table_info({table_name});")
            )
            for table_name in _list_user_tables(reference)
        }
    finally:
        reference.close()


def _list_user_tables(connection: Connection) -> list[str]:
    """通常のテーブル名を返す（FTS の仮想テーブルとその内部テーブル、SQLite の内部テーブルは除く）。"""
    rows = connection.execute(
        """
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'
        ORDER BY name
        """
    ).fetchall()
    return [str(row[0]) for row in rows]


def _find_incompatibility(connection: Connection) -> str | None:
    """列を追加するだけでは今のスキーマにできない理由を返す。移行できるなら None。"""
    if _get_columns(connection, "folders"):
        return "legacy 'folders' table"
    for table_name, definitions in _reference_columns().items():
        existing_columns = _get_columns(connection, table_name)
        if not existing_columns:
            continue
        for definition in definitions:
            if definition.name not in existing_columns and not definition.can_be_added:
                return f"{table_name}.{definition.name} is missing"
    return None


def _add_missing_columns(connection: Connection) -> None:
    """既存テーブルに足りない列を追加し、追加した列に必要な値を既存の行から補う。"""
    backfills: list[Callable[[Connection], None]] = []
    for table_name, definitions in _reference_columns().items():
        existing_columns = _get_columns(connection, table_name)
        for definition in definitions:
            if definition.name in existing_columns:
                continue
            connection.execute(definition.to_add_column_sql(table_name))
            backfill = _COLUMN_BACKFILLS.get((table_name, definition.name))
            if backfill is not None and backfill not in backfills:
                backfills.append(backfill)
    for backfill in backfills:
        backfill(connection)


def _backup_database(connection: Connection) -> Path | None:
    """作り直す前の DB を、同じフォルダへ別名でコピーする。ファイルを持たない DB では何もしない。"""
    row = connection.execute("PRAGMA database_list;").fetchone()
    database_file = str(row[2] or "") if row is not None else ""
    if not database_file:
        return None
    connection.commit()
    source_path = Path(database_file)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = source_path.with_name(f"{source_path.name}.incompatible-{timestamp}")
    backup_connection = sqlite3.connect(backup_path)
    try:
        connection.backup(backup_connection)
    finally:
        backup_connection.close()
    return backup_path


def _drop_managed_schema_objects(connection: Connection) -> None:
    """
    アプリが管理する検索用テーブル・FTS・旧テーブルをまとめて削除する。
    旧 app_settings テーブルが残っていても、設定保存先は現在テキストファイルなので削除してよい。
    """
    connection.execute("DROP TABLE IF EXISTS app_settings;")
    connection.execute("DROP TABLE IF EXISTS files_name_fts;")
    connection.execute("DROP TABLE IF EXISTS file_segments_fts;")
    connection.execute("DROP TABLE IF EXISTS file_segments;")
    connection.execute("DROP TABLE IF EXISTS search_query_clicks;")
    connection.execute("DROP TABLE IF EXISTS files;")
    connection.execute("DROP TABLE IF EXISTS failed_files;")
    connection.execute("DROP TABLE IF EXISTS target_change_states;")
    connection.execute("DROP TABLE IF EXISTS windows_usn_journals;")
    connection.execute("DROP TABLE IF EXISTS scheduler_logs;")
    connection.execute("DROP TABLE IF EXISTS scheduler_paths;")
    connection.execute("DROP TABLE IF EXISTS scheduler_runtime;")
    connection.execute("DROP TABLE IF EXISTS scheduler_settings;")
    connection.execute("DROP TABLE IF EXISTS scheduler_daily_runs;")
    connection.execute("DROP TABLE IF EXISTS targets;")
    connection.execute("DROP TABLE IF EXISTS folders;")
    connection.execute("DROP TABLE IF EXISTS index_runs;")


def _get_columns(connection: Connection, table_name: str) -> set[str]:
    rows = connection.execute(f"PRAGMA table_info({table_name});").fetchall()
    return {str(row[1]) for row in rows}


def _backfill_obsidian_top_tags(connection: Connection) -> None:
    """
    既存インデックスの Markdown 本文を走査し、top タグの順位フラグを移行時に補完する。
    """
    rows = connection.execute(
        """
        SELECT files.id, file_segments.content
        FROM files
        JOIN file_segments ON file_segments.file_id = files.id
        WHERE files.file_ext = '.md' AND file_segments.segment_type = 'body'
        """
    )
    updates = [(int(row["id"]),) for row in rows if has_obsidian_top_tag(str(row["content"]))]
    if updates:
        connection.executemany("UPDATE files SET has_obsidian_top_tag = 1 WHERE id = ?", updates)


def _backfill_obsidian_metadata(connection: Connection) -> None:
    """
    既存Markdown本文からObsidianのtitle・aliasesを移行時に補完する。
    """
    rows = connection.execute(
        """
        SELECT files.id, file_segments.content
        FROM files JOIN file_segments ON file_segments.file_id = files.id
        WHERE files.file_ext = '.md' AND file_segments.segment_type = 'body'
        """
    )
    updates = []
    for row in rows:
        title, aliases = extract_obsidian_title_and_aliases(str(row["content"]))
        updates.append((title, "\n".join(aliases), int(row["id"])))
    if updates:
        connection.executemany(
            "UPDATE files SET obsidian_title = ?, obsidian_aliases = ? WHERE id = ?",
            updates,
        )


def _rebuild_files_name_fts(connection: Connection) -> None:
    """
    既存 files レコードを file_name FTS へ再投入し、移行直後から索引を使えるようにする。
    """
    connection.execute("INSERT INTO files_name_fts(files_name_fts) VALUES ('rebuild');")


# 列を追加したときに、既存の行から値を補う処理
_COLUMN_BACKFILLS: dict[tuple[str, str], Callable[[Connection], None]] = {
    ("files", "has_obsidian_top_tag"): _backfill_obsidian_top_tags,
    ("files", "obsidian_title"): _backfill_obsidian_metadata,
    ("files", "obsidian_aliases"): _backfill_obsidian_metadata,
}
