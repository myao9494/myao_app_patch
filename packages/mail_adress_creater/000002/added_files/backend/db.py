"""SQLite・CSVの読み書き。スキーマ作成/移行、設定、お気に入り、宛先、職アド一致、ジョブ履歴を扱う。"""
from __future__ import annotations

import csv
import json
import os
import sqlite3
import tempfile
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend import config
from backend.config import LOGGER, utc_now


@dataclass
class KeywordMatch:
    received_time: str
    subject: str
    line: str
    keyword: str
    is_new: bool
    id: int | None = None
    confirmed: bool = False


# スキーマ作成済みのDBファイル。毎リクエストでDDLと書き込みを繰り返さないために使う。
_initialized_dbs: set[str] = set()
_initialized_dbs_lock = threading.Lock()
DB_BUSY_TIMEOUT_SECONDS = 10


@contextmanager
def db_connection() -> Any:
    conn = sqlite3.connect(config.DB_PATH, timeout=DB_BUSY_TIMEOUT_SECONDS)
    try:
        yield conn
    finally:
        conn.close()


def ensure_db() -> None:
    """スキーマの作成・移行・既定設定の投入を行う。同じDBファイルでは初回だけ実行する。"""
    key = str(config.DB_PATH)
    with _initialized_dbs_lock:
        if key in _initialized_dbs and config.DB_PATH.exists():
            return
        _create_schema()
        _initialized_dbs.add(key)


def _create_schema() -> None:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS recipients (
              name TEXT PRIMARY KEY,
              count INTEGER NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS favorites (
              name TEXT PRIMARY KEY,
              addresses TEXT NOT NULL,
              cc_addresses TEXT NOT NULL DEFAULT '[]',
              updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS keyword_matches (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              received_time TEXT NOT NULL,
              subject TEXT NOT NULL,
              line TEXT NOT NULL,
              keyword TEXT NOT NULL,
              first_seen_at TEXT NOT NULL,
              confirmed INTEGER NOT NULL DEFAULT 0,
              UNIQUE(received_time, subject, line, keyword)
            )
            """
        )
        # カラム移行（confirmed カラムが存在しない場合は追加）
        cursor = conn.execute("PRAGMA table_info(keyword_matches)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "confirmed" not in columns:
            conn.execute("ALTER TABLE keyword_matches ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0")

        # カラム移行（cc_addresses カラムが存在しない場合は追加）
        cursor = conn.execute("PRAGMA table_info(favorites)")
        columns = [row[1] for row in cursor.fetchall()]
        if columns and "cc_addresses" not in columns:
            conn.execute("ALTER TABLE favorites ADD COLUMN cc_addresses TEXT NOT NULL DEFAULT '[]'")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS job_runs (
              job_name TEXT PRIMARY KEY,
              last_run_at TEXT NOT NULL,
              status TEXT NOT NULL,
              message TEXT NOT NULL
            )
            """
        )
        for key, value in config.DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)",
                (key, json.dumps(value, ensure_ascii=False)),
            )
        conn.commit()


def get_settings() -> dict[str, Any]:
    ensure_db()
    settings = dict(config.DEFAULT_SETTINGS)
    with db_connection() as conn:
        for key, value in conn.execute("SELECT key, value FROM settings"):
            settings[key] = json.loads(value)
    return settings


def save_settings(payload: dict[str, Any]) -> dict[str, Any]:
    current = get_settings()
    if "keywords" in payload:
        keywords = payload["keywords"]
        if not isinstance(keywords, list) or not all(isinstance(item, str) for item in keywords):
            raise ValueError("keywords must be a string array")
        current["keywords"] = [item.strip() for item in keywords if item.strip()]
    for key in ("address_interval_minutes", "keyword_interval_minutes"):
        if key in payload:
            value = int(payload[key])
            if value < 1:
                raise ValueError(f"{key} must be greater than 0")
            current[key] = value
    for key in ("my_email", "my_phone", "my_address", "my_dept", "my_home_email"):
        if key in payload:
            current[key] = str(payload[key]).strip()

    with db_connection() as conn:
        for key, value in current.items():
            conn.execute(
                "INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)",
                (key, json.dumps(value, ensure_ascii=False)),
            )
        conn.commit()
    return current


def normalize_favorite_addresses(addresses: Any) -> list[str]:
    if isinstance(addresses, str):
        parts = addresses.replace("、", ";").replace(",", ";").split(";")
    elif isinstance(addresses, list):
        parts = [str(item) for item in addresses]
    else:
        parts = []
    return [part.strip() for part in parts if part.strip()]


def list_favorites() -> list[dict[str, Any]]:
    ensure_db()
    with db_connection() as conn:
        rows = conn.execute(
            "SELECT name, addresses, cc_addresses, updated_at FROM favorites ORDER BY updated_at DESC, name"
        ).fetchall()
    return [
        {
            "name": row[0],
            "addresses": json.loads(row[1]),
            "cc_addresses": json.loads(row[2]),
            "updated_at": row[3],
        }
        for row in rows
    ]


def save_favorites(payload: dict[str, Any]) -> list[dict[str, Any]]:
    ensure_db()
    favorites = payload.get("favorites")
    if not isinstance(favorites, list):
        raise ValueError("favorites must be an array")

    normalized: dict[str, tuple[list[str], list[str]]] = {}
    for favorite in favorites:
        if not isinstance(favorite, dict):
            continue
        name = str(favorite.get("name") or "").strip()
        addresses = normalize_favorite_addresses(favorite.get("addresses"))
        cc_addresses = normalize_favorite_addresses(favorite.get("cc_addresses"))
        if name and (addresses or cc_addresses):
            normalized[name] = (addresses, cc_addresses)

    now = utc_now()
    existing = {
        favorite["name"]: (favorite["addresses"], favorite["cc_addresses"], favorite["updated_at"])
        for favorite in list_favorites()
    }
    with db_connection() as conn:
        conn.execute("DELETE FROM favorites")
        for name, (addresses, cc_addresses) in normalized.items():
            previous = existing.get(name)
            updated_at = now
            if previous is not None and previous[0] == addresses and previous[1] == cc_addresses:
                updated_at = previous[2]
            conn.execute(
                "INSERT INTO favorites(name, addresses, cc_addresses, updated_at) VALUES(?, ?, ?, ?)",
                (
                    name,
                    json.dumps(addresses, ensure_ascii=False),
                    json.dumps(cc_addresses, ensure_ascii=False),
                    updated_at,
                ),
            )
        conn.commit()
    return list_favorites()


def add_favorite(payload: dict[str, Any]) -> dict[str, Any]:
    ensure_db()
    name = str(payload.get("name") or "").strip()
    addresses = normalize_favorite_addresses(payload.get("addresses"))
    cc_addresses = normalize_favorite_addresses(payload.get("cc_addresses"))
    if not name:
        raise ValueError("お気に入り名を入力してください")
    if not addresses and not cc_addresses:
        raise ValueError("お気に入りに登録する宛先またはCCがありません")

    favorite = {"name": name, "addresses": addresses, "cc_addresses": cc_addresses, "updated_at": utc_now()}
    with db_connection() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO favorites(name, addresses, cc_addresses, updated_at) VALUES(?, ?, ?, ?)",
            (
                name,
                json.dumps(addresses, ensure_ascii=False),
                json.dumps(cc_addresses, ensure_ascii=False),
                favorite["updated_at"],
            ),
        )
        conn.commit()
    return favorite


def read_recipients_csv(path: Path) -> dict[str, int]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8-sig", newline="") as fp:
        reader = csv.DictReader(fp)
        result: dict[str, int] = {}
        for row in reader:
            name = (row.get("名前") or "").strip()
            if name:
                try:
                    result[name] = int(row.get("回数") or 0)
                except ValueError:
                    LOGGER.warning("Skipped recipient row with invalid count: name=%s count=%s", name, row.get("回数"))
        return result


def write_recipients_csv(rows: list[tuple[str, int]]) -> None:
    """public/ と dist/ のCSVを書き換える。一時ファイル経由で置換し、途中失敗でも元のCSVを壊さない。"""
    for path in (config.PUBLIC_CSV_PATH, config.DIST_CSV_PATH):
        if not path.parent.exists():
            continue
        fd, temp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as fp:
                writer = csv.writer(fp)
                writer.writerow(["名前", "回数"])
                writer.writerows(rows)
            os.replace(temp_name, path)
        except BaseException:
            Path(temp_name).unlink(missing_ok=True)
            raise


def list_recipient_names() -> set[str]:
    ensure_db()
    with db_connection() as conn:
        return {str(row[0]) for row in conn.execute("SELECT name FROM recipients")}


def save_recipients(rows: list[tuple[str, int]]) -> None:
    ensure_db()
    now = utc_now()
    with db_connection() as conn:
        conn.execute("DELETE FROM recipients")
        for name, count in rows:
            conn.execute(
                "INSERT OR REPLACE INTO recipients(name, count, updated_at) VALUES(?, ?, ?)",
                (name, count, now),
            )
        conn.commit()


def list_recipient_rows_for_csv(conn: sqlite3.Connection) -> list[tuple[str, int]]:
    return [
        (str(row[0]), int(row[1]))
        for row in conn.execute("SELECT name, count FROM recipients ORDER BY count DESC, name")
    ]


def persist_keyword_matches(matches: list[KeywordMatch]) -> list[KeywordMatch]:
    ensure_db()
    now = utc_now()
    persisted: list[KeywordMatch] = []
    with db_connection() as conn:
        for match in matches:
            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO keyword_matches(
                  received_time, subject, line, keyword, first_seen_at
                ) VALUES(?, ?, ?, ?, ?)
                """,
                (match.received_time, match.subject, match.line, match.keyword, now),
            )
            is_new = cursor.rowcount == 1
            if is_new:
                row_id = cursor.lastrowid
                confirmed = 0
            else:
                row = conn.execute(
                    """
                    SELECT id, confirmed FROM keyword_matches
                    WHERE received_time = ? AND subject = ? AND line = ? AND keyword = ?
                    """,
                    (match.received_time, match.subject, match.line, match.keyword),
                ).fetchone()
                row_id = row[0] if row else None
                confirmed = row[1] if row else 0

            persisted.append(
                KeywordMatch(
                    received_time=match.received_time,
                    subject=match.subject,
                    line=match.line,
                    keyword=match.keyword,
                    is_new=is_new,
                    id=row_id,
                    confirmed=bool(confirmed),
                )
            )
        conn.commit()
    return persisted


def list_keyword_matches(new_only: bool = False, unconfirmed_only: bool = False) -> list[dict[str, Any]]:
    ensure_db()
    if new_only:
        return []
    query = "SELECT received_time, subject, line, keyword, first_seen_at, id, confirmed FROM keyword_matches"
    if unconfirmed_only:
        query += " WHERE confirmed = 0"
    query += " ORDER BY first_seen_at DESC, id DESC"
    with db_connection() as conn:
        rows = conn.execute(query).fetchall()
    return [
        {
            "received_time": row[0],
            "subject": row[1],
            "line": row[2],
            "keyword": row[3],
            "first_seen_at": row[4],
            "id": row[5],
            "confirmed": bool(row[6]),
            "is_new": False,
        }
        for row in rows
    ]


def confirm_keyword_matches(ids: list[int]) -> dict[str, Any]:
    ensure_db()
    if not ids:
        return {"updated": 0}
    with db_connection() as conn:
        cursor = conn.executemany(
            "UPDATE keyword_matches SET confirmed = 1 WHERE id = ?", [(row_id,) for row_id in ids]
        )
        conn.commit()
        updated = cursor.rowcount if cursor.rowcount != -1 else 0
    return {"updated": updated}


def list_database() -> dict[str, list[dict[str, Any]]]:
    ensure_db()
    with db_connection() as conn:
        conn.row_factory = sqlite3.Row
        settings = [
            {"key": row["key"], "value": row["value"]}
            for row in conn.execute("SELECT key, value FROM settings ORDER BY key")
        ]
        recipients = [
            {"name": row["name"], "count": row["count"], "updated_at": row["updated_at"]}
            for row in conn.execute(
                "SELECT name, count, updated_at FROM recipients ORDER BY updated_at DESC, count DESC, name"
            )
        ]
        favorites = [
            {
                "name": row["name"],
                "addresses": json.loads(row["addresses"]),
                "cc_addresses": json.loads(row["cc_addresses"]),
                "updated_at": row["updated_at"],
            }
            for row in conn.execute(
                "SELECT name, addresses, cc_addresses, updated_at FROM favorites ORDER BY updated_at DESC, name"
            )
        ]
        keyword_matches = [
            {
                "id": row["id"],
                "received_time": row["received_time"],
                "subject": row["subject"],
                "line": row["line"],
                "keyword": row["keyword"],
                "first_seen_at": row["first_seen_at"],
                "confirmed": bool(row["confirmed"]),
            }
            for row in conn.execute(
                """
                SELECT id, received_time, subject, line, keyword, first_seen_at, confirmed
                FROM keyword_matches
                ORDER BY received_time DESC, first_seen_at DESC, id DESC
                """
            )
        ]
        job_runs = [
            {
                "job_name": row["job_name"],
                "last_run_at": row["last_run_at"],
                "status": row["status"],
                "message": row["message"],
            }
            for row in conn.execute(
                "SELECT job_name, last_run_at, status, message FROM job_runs ORDER BY last_run_at DESC, job_name"
            )
        ]
    return {
        "settings": settings,
        "recipients": recipients,
        "favorites": favorites,
        "keyword_matches": keyword_matches,
        "job_runs": job_runs,
    }


def delete_database_records(table: str, keys: list[str]) -> dict[str, Any]:
    ensure_db()
    if table not in {"recipients", "favorites", "keyword_matches", "job_runs"}:
        raise ValueError("削除できないテーブルです")
    if not keys:
        return {"table": table, "deleted": 0}

    recipient_rows: list[tuple[str, int]] | None = None
    with db_connection() as conn:
        if table == "recipients":
            cursor = conn.executemany("DELETE FROM recipients WHERE name = ?", [(key,) for key in keys])
            recipient_rows = list_recipient_rows_for_csv(conn)
        elif table == "favorites":
            cursor = conn.executemany("DELETE FROM favorites WHERE name = ?", [(key,) for key in keys])
        elif table == "keyword_matches":
            ids = [int(key) for key in keys]
            cursor = conn.executemany("DELETE FROM keyword_matches WHERE id = ?", [(row_id,) for row_id in ids])
        else:
            cursor = conn.executemany("DELETE FROM job_runs WHERE job_name = ?", [(key,) for key in keys])
        conn.commit()
        deleted = cursor.rowcount if cursor.rowcount != -1 else 0
    if recipient_rows is not None:
        write_recipients_csv(recipient_rows)
    return {"table": table, "deleted": deleted}


def record_job_run(job_name: str, status: str, message: str) -> None:
    ensure_db()
    with db_connection() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO job_runs(job_name, last_run_at, status, message) VALUES(?, ?, ?, ?)",
            (job_name, utc_now(), status, message),
        )
        conn.commit()


def list_job_runs() -> dict[str, dict[str, str]]:
    ensure_db()
    with db_connection() as conn:
        rows = conn.execute("SELECT job_name, last_run_at, status, message FROM job_runs").fetchall()
    return {
        row[0]: {
            "last_run_at": row[1],
            "status": row[2],
            "message": row[3],
        }
        for row in rows
    }
