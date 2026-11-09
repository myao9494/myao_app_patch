"""Outlook のメールのキャッシュ (受信トレイとその下、送信済みとその下)。

Outlook を毎回読み直すと遅いので、メールの見出しと本文を、ローカルの SQLite に取っておく。
  - 取り込み (sync): 新しい順にたどり、キャッシュに無いメールだけを読む。2 回目以降は、前回より新しい分だけ
  - 検索 (search) と表示 (get): キャッシュだけを読む。Outlook には接続しない
添付ファイルは取り込まない (件数だけ)。Outlook を書き換える操作は、ここには無い。
標準ライブラリだけで動く。
"""
from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import time
import unicodedata
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable

import outlook_client as oc

DEFAULT_DAYS = 90          # 最初に取り込む期間
DEFAULT_MAX_SECONDS = 100  # 1 回の取り込みの上限 (シェルの時間切れより短くする)。途中で止めても、次回に続きから取り込む
DEFAULT_MAX_AGE_MIN = 10   # 検索の前に、これより古ければ差分を取り込む
BODY_MAX_CHARS = 30000     # 1 通の本文の上限 (これより長い分は切る)
DELTA_MARGIN = timedelta(days=1)  # 差分の取り込みで、前回の最新より、これだけ古い所まで見直す
TIME_FORMAT = "%Y-%m-%d %H:%M:%S"
KIND_LABELS = {"inbox": "受信", "sent": "送信"}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS mails (
    entry_id TEXT PRIMARY KEY, alias TEXT NOT NULL, kind TEXT NOT NULL, folder_id TEXT NOT NULL, folder TEXT NOT NULL,
    time TEXT NOT NULL, sender TEXT NOT NULL, sender_addr TEXT NOT NULL, recipients TEXT NOT NULL, cc TEXT NOT NULL,
    subject TEXT NOT NULL, thread TEXT NOT NULL, attachments INTEGER NOT NULL, body TEXT NOT NULL, truncated INTEGER NOT NULL,
    fingerprint TEXT NOT NULL, n_sender TEXT NOT NULL, n_recipients TEXT NOT NULL, n_subject TEXT NOT NULL, n_all TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mails_time ON mails (time);
CREATE INDEX IF NOT EXISTS mails_alias ON mails (alias);
CREATE INDEX IF NOT EXISTS mails_fingerprint ON mails (fingerprint);
CREATE INDEX IF NOT EXISTS mails_thread ON mails (thread);
CREATE TABLE IF NOT EXISTS folders (
    folder_id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL, newest TEXT, covered_from TEXT, synced_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

_REPLY_PREFIX = re.compile(r"^\s*((re|fw|fwd|返信|転送)\s*[:：]\s*|\[[^\]]{1,20}\]\s*)+", re.IGNORECASE)


def cache_db_path() -> Path:
    """キャッシュの場所。メールの本文が入るので、リポジトリや作業フォルダの外 (利用者のフォルダ) に置く。"""
    override = os.environ.get("OPENCODE_OUTLOOK_MAILCACHE")
    if override:
        return Path(override)
    base = os.environ.get("LOCALAPPDATA")
    root = Path(base) if base else Path.home() / ".cache"
    return root / "opencode-harness" / "outlook-mail-cache.sqlite3"


def norm(text: str) -> str:
    """検索用にそろえる (全角・半角、大文字・小文字の違いを無くす)。"""
    return unicodedata.normalize("NFKC", text or "").casefold()


def thread_key(subject: str) -> str:
    """件名から RE: や FW: を除いたもの。同じ件のやり取りをまとめるのに使う。"""
    return norm(_REPLY_PREFIX.sub("", subject or "")).strip()


def _like(word: str) -> str:
    escaped = norm(word).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _stamp(value: datetime) -> str:
    return value.strftime(TIME_FORMAT)


class CacheStore:
    """SQLite のファイル 1 つ。開くときに、表が無ければ作る。"""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or cache_db_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path))
        self.db.row_factory = sqlite3.Row
        self.db.executescript(_SCHEMA)

    def close(self) -> None:
        self.db.commit()
        self.db.close()

    def __enter__(self) -> "CacheStore":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # --- 状態 -----------------------------------------------------------

    def get_meta(self, key: str) -> str | None:
        row = self.db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_meta(self, key: str, value: str) -> None:
        self.db.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))

    def days(self) -> int:
        try:
            return max(1, int(self.get_meta("days") or DEFAULT_DAYS))
        except ValueError:
            return DEFAULT_DAYS

    def last_sync(self) -> datetime | None:
        value = self.get_meta("last_sync")
        try:
            return datetime.strptime(value, TIME_FORMAT) if value else None
        except ValueError:
            return None

    def status(self) -> dict[str, Any]:
        row = self.db.execute("SELECT COUNT(*) AS n, MIN(time) AS oldest, MAX(time) AS newest FROM mails").fetchone()
        kinds = {r["kind"]: r["n"] for r in self.db.execute("SELECT kind, COUNT(*) AS n FROM mails GROUP BY kind")}
        folders = self.db.execute("SELECT COUNT(*) AS n, SUM(covered_from IS NULL) AS partial FROM folders").fetchone()
        return {
            "path": str(self.path), "count": row["n"], "oldest": row["oldest"] or "", "newest": row["newest"] or "",
            "inbox": kinds.get("inbox", 0), "sent": kinds.get("sent", 0), "days": self.days(),
            "last_sync": self.get_meta("last_sync") or "", "last_full": self.get_meta("last_full") or "",
            "folders": folders["n"], "partial_folders": int(folders["partial"] or 0),
        }

    # --- 書き込み (キャッシュのファイルだけ) -------------------------------

    def known_ids(self) -> set[str]:
        return {r["entry_id"] for r in self.db.execute("SELECT entry_id FROM mails")}

    def folder_state(self, folder_id: str) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM folders WHERE folder_id = ?", (folder_id,)).fetchone()

    def save_folder_state(self, folder_id: str, kind: str, path: str, newest: str | None, covered_from: str, synced_at: str) -> None:
        self.db.execute(
            "INSERT INTO folders (folder_id, kind, path, newest, covered_from, synced_at) VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(folder_id) DO UPDATE SET kind = excluded.kind, path = excluded.path, newest = excluded.newest, "
            "covered_from = excluded.covered_from, synced_at = excluded.synced_at",
            (folder_id, kind, path, newest, covered_from, synced_at),
        )

    def add_mail(self, record: dict[str, Any], kind: str, folder_id: str, folder: str) -> None:
        body = record["body"]
        truncated = len(body) > BODY_MAX_CHARS
        if truncated:
            body = body[:BODY_MAX_CHARS]
        stamp = _stamp(record["time"])
        fingerprint = hashlib.sha1("\x1f".join([kind, stamp, record["sender"], record["subject"], body[:2000]]).encode("utf-8")).hexdigest()
        # 同じメールが別の ID で残っていたら (別のフォルダへ移した後など)、古い方を消す
        self.db.execute("DELETE FROM mails WHERE fingerprint = ? AND entry_id <> ?", (fingerprint, record["entry_id"]))
        self.db.execute(
            "INSERT OR REPLACE INTO mails VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                record["entry_id"], oc.make_alias("m", record["entry_id"]), kind, folder_id, folder, stamp,
                record["sender"], record["sender_addr"], record["to"], record["cc"], record["subject"], thread_key(record["subject"]),
                int(record["attachments"]), body, int(truncated), fingerprint,
                norm(f"{record['sender']} {record['sender_addr']}"), norm(f"{record['to']} {record['cc']}"), norm(record["subject"]),
                norm("\n".join([record["subject"], record["sender"], record["sender_addr"], record["to"], record["cc"], body])),
            ),
        )

    def prune_folder(self, folder_id: str, since: str, seen: set[str]) -> int:
        """全体の取り直しで、Outlook に無くなったメール (移動・削除されたもの) を、キャッシュから除く。"""
        rows = self.db.execute("SELECT entry_id FROM mails WHERE folder_id = ? AND time >= ?", (folder_id, since)).fetchall()
        gone = [r["entry_id"] for r in rows if r["entry_id"] not in seen]
        self.db.executemany("DELETE FROM mails WHERE entry_id = ?", [(g,) for g in gone])
        return len(gone)

    def prune_missing_folders(self, alive: set[str]) -> int:
        """無くなったフォルダの分を除く (移動で場所だけ書き換えた行は folder_id が空なので、残す)。"""
        removed = 0
        for row in self.db.execute("SELECT folder_id FROM folders").fetchall():
            if row["folder_id"] not in alive:
                removed += self.db.execute("DELETE FROM mails WHERE folder_id = ?", (row["folder_id"],)).rowcount
                self.db.execute("DELETE FROM folders WHERE folder_id = ?", (row["folder_id"],))
        return removed

    def note_moved(self, old_entry: str, new_entry: str, folder: str) -> None:
        """mail-move / mail-undo の後で、キャッシュの ID と場所を合わせる (本文は読み直さない)。"""
        self.db.execute("DELETE FROM mails WHERE entry_id = ? AND ? <> ?", (new_entry, new_entry, old_entry))
        self.db.execute(
            "UPDATE mails SET entry_id = ?, alias = ?, folder = ?, folder_id = '' WHERE entry_id = ?",
            (new_entry, oc.make_alias("m", new_entry), folder, old_entry),
        )

    # --- 読み取り -------------------------------------------------------

    def find(self, ref: str) -> sqlite3.Row | None:
        ref = ref.strip()
        row = self.db.execute("SELECT * FROM mails WHERE alias = ? ORDER BY time DESC", (ref,)).fetchone()
        return row or self.db.execute("SELECT * FROM mails WHERE entry_id = ?", (ref,)).fetchone()

    def search(
        self,
        words: list[str] | None = None,
        kind: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        sender: str | None = None,
        to: str | None = None,
        subject: str | None = None,
        folder: str | None = None,
        thread: str | None = None,
        limit: int = 20,
    ) -> dict[str, Any]:
        where: list[str] = []
        params: list[Any] = []
        for word in words or []:
            if norm(word).strip():
                where.append("n_all LIKE ? ESCAPE '\\'")
                params.append(_like(word))
        for column, value in (("n_sender", sender), ("n_recipients", to), ("n_subject", subject)):
            if value:
                where.append(f"{column} LIKE ? ESCAPE '\\'")
                params.append(_like(value))
        if folder:
            where.append("folder LIKE ? ESCAPE '\\'")
            params.append("%" + folder.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
        if kind:
            where.append("kind = ?")
            params.append(kind)
        if since:
            where.append("time >= ?")
            params.append(_stamp(since))
        if until:
            where.append("time < ?")
            params.append(_stamp(until))
        if thread is not None:
            where.append("thread = ?")
            params.append(thread)
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        total = self.db.execute(f"SELECT COUNT(*) AS n FROM mails{clause}", params).fetchone()["n"]
        order = "time ASC" if thread is not None else "time DESC"  # やり取りは古い順 (経緯を追う)、ほかは新しい順
        rows = self.db.execute(f"SELECT * FROM mails{clause} ORDER BY {order} LIMIT ?", [*params, limit]).fetchall()
        return {"items": rows, "total": total}


def excerpt(body: str, words: list[str], limit: int) -> str:
    """本文の、最初に検索語が出てくるあたりを 1 行にして返す。語が無ければ冒頭。"""
    if limit <= 0:
        return ""
    flat = re.sub(r"\s+", " ", body or "").strip()
    lowered = flat.casefold()
    hits = [pos for pos in (lowered.find(w.casefold()) for w in words if w.strip()) if pos >= 0]
    start = max(0, min(hits) - limit // 4) if hits else 0
    piece = flat[start:start + limit]
    return ("…" if start else "") + piece + ("…" if start + limit < len(flat) else "")


# ---------------------------------------------------------------------------
# 取り込み
# ---------------------------------------------------------------------------

def sync(
    client: Any,
    store: CacheStore,
    *,
    days: int | None = None,
    full: bool = False,
    max_seconds: float = DEFAULT_MAX_SECONDS,
    now: datetime | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """Outlook から、キャッシュに無いメールを取り込む。

    新しい順にたどる。キャッシュにあるメールは、ID と日時だけを見て飛ばす (本文を読まない) ので、速い。
    前回に期間の端まで取り込んだフォルダは、前回の最新のあたりで止める (差分)。full=True は、期間の全部を見直し、
    Outlook に無くなったメールを、キャッシュから除く。max_seconds を超えたら止め、次回に続きを取り込む。
    """
    now = now or datetime.now()
    if days is not None:
        store.set_meta("days", str(max(1, days)))
    window_start = now - timedelta(days=store.days())
    since = _stamp(window_start)
    started = clock()
    known = store.known_ids()
    added = {"inbox": 0, "sent": 0}
    removed = errors = 0
    timed_out = False
    folders = client.mail_folders()
    for kind, folder in folders:
        folder_id = str(getattr(folder, "EntryID", "") or "")
        path = oc.folder_path(folder) or str(getattr(folder, "Name", ""))
        state = store.folder_state(folder_id)
        covered = bool(state and state["covered_from"] and state["covered_from"] <= since)
        stop_at = None
        if covered and not full and state["newest"]:
            stop_at = datetime.strptime(state["newest"], TIME_FORMAT) - DELTA_MARGIN
        items = folder.Items
        items.Sort(oc.CACHE_SORT_FIELDS[kind], True)  # 新しい順
        seen: set[str] = set()
        newest: datetime | None = None
        finished = True
        for item in items:
            if clock() - started > max_seconds:
                finished, timed_out = False, True
                break
            when = oc.naive(getattr(item, oc.CACHE_TIME_ATTRS[kind], None))
            if when is None:
                continue  # 日時の無いアイテム (メール以外) は取り込まない
            if when < window_start or (stop_at is not None and when < stop_at):
                break  # 新しい順なので、これより後ろは、期間の外か、取り込み済み
            newest = newest or when
            entry_id = str(getattr(item, "EntryID", "") or "")
            if not entry_id:
                continue
            seen.add(entry_id)
            if entry_id in known:
                continue
            try:
                store.add_mail(client.mail_record(item, when), kind, folder_id, path)
            except Exception:  # noqa: BLE001 - 1 通の失敗で、ほかを止めない (COM のエラーは型が多様)
                errors += 1
                continue
            known.add(entry_id)
            added[kind] += 1
        if finished:
            previous = state["newest"] if state else None
            latest = max([s for s in (previous, _stamp(newest) if newest else None) if s], default=None)
            reached = min(state["covered_from"], since) if covered else since
            store.save_folder_state(folder_id, kind, path, latest, reached, _stamp(now))
            if full:
                removed += store.prune_folder(folder_id, since, seen)
        store.db.commit()  # フォルダごとに保存する (途中で止まっても、取り込んだ分は残る)
        if timed_out:
            break
    if full and not timed_out:
        removed += store.prune_missing_folders({str(getattr(f, "EntryID", "") or "") for _, f in folders})
        store.set_meta("last_full", _stamp(now))
    if not timed_out:
        store.set_meta("last_sync", _stamp(now))
    store.db.commit()
    return {
        "added": added, "removed": removed, "errors": errors, "timed_out": timed_out, "full": full,
        "folders": len(folders), "seconds": clock() - started, "days": store.days(),
    }
