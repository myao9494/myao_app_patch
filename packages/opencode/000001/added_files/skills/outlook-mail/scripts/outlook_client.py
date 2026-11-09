"""Outlook COM 連携 (Windows + pywin32、クラシック版 Outlook)。

提供する機能は、次のものだけ。
  - 接続の確認
  - メールの一覧・本文の読み取り
  - 返信の下書きの保存
  - 予定の一覧の読み取り
  - 予定の作成 (保存だけで、招待は送らない)
  - フォルダの一覧と作成
  - メールのフォルダ間の移動 (記録を残し、元に戻せる。削除済みアイテム・迷惑メールへは移動しない)

メールの送信と削除は、実装しない。移動の呼び出しは、move_mails と undo_moves の 2 か所だけ。
tests/test_outlook.py が、ソースにこれ以外の呼び出しが無いことを検査する。
標準ライブラリと pywin32 だけで動く。pywin32 は、使うときに初めて読み込む。
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import shutil
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterator

# Outlook の定数
OL_FOLDER_CALENDAR = 9
OL_ITEM_APPOINTMENT = 1
OL_FORMAT_HTML = 2
OL_MEETING = 1
FOLDERS = {"inbox": 6, "sent": 5, "drafts": 16}
SORT_FIELDS = {"inbox": "[ReceivedTime]", "sent": "[SentOn]", "drafts": "[LastModificationTime]"}
TIME_ATTRS = {"inbox": "ReceivedTime", "sent": "SentOn", "drafts": "LastModificationTime"}
# キャッシュ (outlook_cache) に取り込む種類: 受信トレイとその下、送信済みとその下
CACHE_SORT_FIELDS = {"inbox": "[ReceivedTime]", "sent": "[SentOn]"}
CACHE_TIME_ATTRS = {"inbox": "ReceivedTime", "sent": "SentOn"}

OL_FOLDER_DELETED = 3
OL_FOLDER_JUNK = 23
ROOTS = ("inbox", "mailbox")  # inbox: 受信トレイの下、mailbox: メールボックス全体の直下
MOVE_LIMIT = 50  # 1 回で移動できる通数
_BAD_FOLDER_CHARS = re.compile(r'[\\/:*?"<>|]')

ALIAS_CACHE_LIMIT = 2000
DEFAULT_DATE_FORMATS = ("%Y/%m/%d %H:%M", "%m/%d/%Y %H:%M")


# ---------------------------------------------------------------------------
# 接続
# ---------------------------------------------------------------------------

def _import_win32com_client() -> Any:
    try:
        import win32com.client  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("Outlook 連携には Windows と pywin32 が必要です (pip install pywin32)") from exc
    return win32com.client


def gen_py_cache_dir() -> Path | None:
    temp = os.environ.get("TEMP")
    if not temp:
        return None
    return Path(temp) / "gen_py" / f"{sys.version_info.major}.{sys.version_info.minor}"


def clear_outlook_gen_py_cache() -> None:
    """型ライブラリのキャッシュの不整合を直すため、Outlook 分のキャッシュを消す。"""
    cache_dir = gen_py_cache_dir()
    if cache_dir is not None and cache_dir.exists():
        for folder in cache_dir.glob("*000000000046*"):  # Outlook 型ライブラリの GUID
            if folder.is_dir():
                shutil.rmtree(folder, ignore_errors=True)
    for name in [name for name in sys.modules if name.startswith("win32com")]:
        sys.modules.pop(name, None)


def outlook_application() -> Any:
    """Outlook.Application に接続する。失敗したらキャッシュを消して再試行し、最後に Dispatch を試す。"""
    client = _import_win32com_client()
    try:
        return client.gencache.EnsureDispatch("Outlook.Application")
    except Exception:  # noqa: BLE001 - COM のエラー型は環境依存
        clear_outlook_gen_py_cache()
        client = _import_win32com_client()
    try:
        return client.gencache.EnsureDispatch("Outlook.Application")
    except Exception:  # noqa: BLE001
        pass
    try:
        return client.Dispatch("Outlook.Application")
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            "Outlook に接続できません。クラシック版 Outlook がインストールされ、"
            "同じ Windows ユーザーで起動できる状態か確認してください。"
            "新しい Outlook だけの環境では使えません。"
        ) from exc


@contextmanager
def com_context() -> Iterator[None]:
    try:
        import pythoncom  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("Outlook 連携には Windows と pywin32 が必要です (pip install pywin32)") from exc
    pythoncom.CoInitialize()
    try:
        yield
    finally:
        pythoncom.CoUninitialize()


@contextmanager
def open_client() -> Iterator["OutlookClient"]:
    with com_context():
        yield OutlookClient(outlook_application())


# ---------------------------------------------------------------------------
# 短い ID (EntryID は長いので、トークンを節約するために別名を使う)
# ---------------------------------------------------------------------------

def alias_cache_path() -> Path:
    override = os.environ.get("OPENCODE_OUTLOOK_CACHE")
    return Path(override) if override else Path(tempfile.gettempdir()) / "opencode-outlook-ids.json"


def make_alias(prefix: str, entry_id: str) -> str:
    return prefix + hashlib.sha1(entry_id.encode("utf-8")).hexdigest()[:6]


def _load_aliases() -> dict[str, str]:
    try:
        data = json.loads(alias_cache_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def remember_aliases(new: dict[str, str]) -> None:
    if not new:
        return
    cache = _load_aliases()
    for key in new:
        cache.pop(key, None)  # 新しいものを末尾へ
    cache.update(new)
    while len(cache) > ALIAS_CACHE_LIMIT:
        cache.pop(next(iter(cache)))
    path = alias_cache_path()
    tmp = path.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass  # キャッシュに書けなくても、一覧の表示自体は成功させる


def resolve_id(ref: str) -> str:
    """短い ID (m1a2b3c など) を EntryID に直す。長い 16 進数は、EntryID としてそのまま使う。"""
    ref = ref.strip()
    cache = _load_aliases()
    if ref in cache:
        return cache[ref]
    if len(ref) >= 40 and re.fullmatch(r"[0-9A-Fa-f]+", ref):
        return ref
    raise LookupError(f"ID '{ref}' が見つかりません。先に mail-list を実行して、表示された ID を使ってください")


# ---------------------------------------------------------------------------
# フォルダのパスと、移動の記録
# ---------------------------------------------------------------------------

def split_folder_path(path: str) -> list[str]:
    """'案件A/2026' のようなパスを、フォルダ名の並びにする。'.' と空の指定は、起点そのもの。"""
    parts = [p.strip() for p in path.replace("\\", "/").split("/")]
    parts = [p for p in parts if p and p != "."]
    for name in parts:
        if name == ".." or _BAD_FOLDER_CHARS.search(name) or len(name) > 100:
            raise ValueError(f"フォルダ名 '{name}' は使えません (\\ / : * ? \" < > | と '..' は使えず、100 文字まで)")
    return parts


def folder_path(folder: Any) -> str:
    """フォルダの、メールボックスの直下からのパス (例: 受信トレイ/案件A)。"""
    names: list[str] = []
    current = folder
    for _ in range(20):
        name = getattr(current, "Name", None)
        if not name:
            break
        names.append(str(name))
        current = getattr(current, "Parent", None)
        if current is None:
            break
    if len(names) > 1:
        names.pop()  # いちばん上は、メールボックス自体の名前なので除く
    return "/".join(reversed(names))


def movelog_path() -> Path:
    """移動の記録の場所。元に戻すための記録なので、掃除で消えやすい一時フォルダではなく、利用者のフォルダに置く。

    以前の場所 (一時フォルダ) に記録が残っていて、新しい場所にまだ無ければ、写してから使う (以前の移動も戻せるように)。
    """
    override = os.environ.get("OPENCODE_OUTLOOK_MOVELOG")
    if override:
        return Path(override)
    legacy = Path(tempfile.gettempdir()) / "opencode-outlook-moves.jsonl"
    base = os.environ.get("LOCALAPPDATA")
    if not base:
        return legacy
    durable = Path(base) / "opencode-harness" / "outlook-moves.jsonl"
    try:
        durable.parent.mkdir(parents=True, exist_ok=True)
        if not durable.exists() and legacy.exists():
            durable.write_text(legacy.read_text(encoding="utf-8"), encoding="utf-8")
    except OSError:
        return legacy
    return durable


def read_movelog() -> list[dict[str, Any]]:
    try:
        lines = movelog_path().read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    records: list[dict[str, Any]] = []
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def append_movelog(record: dict[str, Any]) -> None:
    record = {"time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), **record}
    try:
        with movelog_path().open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass  # 記録に書けなくても、移動の結果は表示する (元に戻す機能だけが使えなくなる)


# ---------------------------------------------------------------------------
# 本文の変換
# ---------------------------------------------------------------------------

_BLOCK_TAGS = {"p", "div", "li", "tr", "table", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"}
_IGNORED_TAGS = {"script", "style", "head", "title"}


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._ignored = 0

    def _newline(self) -> None:
        if self.parts and not self.parts[-1].endswith("\n"):
            self.parts.append("\n")

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _IGNORED_TAGS:
            self._ignored += 1
        elif tag == "br":
            self.parts.append("\n")
        elif tag in _BLOCK_TAGS:
            self._newline()

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "br":
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in _IGNORED_TAGS:
            self._ignored = max(0, self._ignored - 1)
        elif tag in _BLOCK_TAGS:
            self._newline()

    def handle_data(self, data: str) -> None:
        if not self._ignored:
            self.parts.append(data.replace("\xa0", " "))


def html_to_text(body: str) -> str:
    extractor = _TextExtractor()
    extractor.feed(body)
    extractor.close()
    lines = "".join(extractor.parts).split("\n")
    return "\n".join(line.strip() for line in lines).strip("\n")


def text_to_html(text: str) -> str:
    escaped = html.escape(text).replace("\r\n", "\n").replace("\n", "<br>")
    return f"<div>{escaped}</div><br>"


def insert_into_html_body(document: str, fragment: str) -> str:
    """HTML 文書の <body> の直後に断片を差し込む。<body> が無ければ、先頭に置く。"""
    match = re.search(r"<body[^>]*>", document, re.IGNORECASE)
    if match is None:
        return fragment + document
    return document[: match.end()] + fragment + document[match.end():]


_QUOTE_START = re.compile(
    r"^\s*(-{3,}\s*(Original Message|元のメッセージ|転送メッセージ)\s*-{3,}|_{10,}|On .+ wrote:|.+さんは書きました:?)\s*$",
    re.IGNORECASE,
)
_HEADER_FROM = re.compile(r"^\s*(差出人|From)\s*[:：]", re.IGNORECASE)
_HEADER_NEXT = re.compile(r"^\s*(送信日時|送信|Sent|Date)\s*[:：]", re.IGNORECASE)


def strip_quoted(text: str) -> str:
    """返信や転送で付く、引用された過去のやり取りを取り除く。最初の見つけた位置から後ろを切る。"""
    lines = text.splitlines()
    for index, line in enumerate(lines):
        cut = bool(_QUOTE_START.match(line))
        if not cut and _HEADER_FROM.match(line) and index + 1 < len(lines):
            cut = bool(_HEADER_NEXT.match(lines[index + 1]))
        if not cut and line.lstrip().startswith(">") and index > 0:
            rest = lines[index:]
            cut = all((not item.strip()) or item.lstrip().startswith(">") for item in rest)
        if cut and "".join(lines[:index]).strip():
            return "\n".join(lines[:index]).rstrip()
    return text


# ---------------------------------------------------------------------------
# 値の変換
# ---------------------------------------------------------------------------

def naive(value: Any) -> datetime | None:
    """pywin32 の日時を、タイムゾーンの無い日時にする (時計の値はそのまま)。"""
    if not isinstance(value, datetime):
        return None
    return value.replace(tzinfo=None) if value.tzinfo is not None else value


def fmt_time(value: datetime | None) -> str:
    return value.strftime("%Y-%m-%d %H:%M") if value else ""


def one_line(text: str, limit: int) -> str:
    collapsed = re.sub(r"\s+", " ", text or "").strip()
    return collapsed if len(collapsed) <= limit else collapsed[:limit] + "…"


def _count(collection: Any) -> int:
    try:
        return int(collection.Count)
    except Exception:  # noqa: BLE001
        return 0


def date_formats() -> tuple[str, ...]:
    override = os.environ.get("OPENCODE_OUTLOOK_DATE_FORMAT")
    return (override,) if override else DEFAULT_DATE_FORMATS


# ---------------------------------------------------------------------------
# クライアント
# ---------------------------------------------------------------------------

class OutlookClient:
    """Outlook.Application (または同じ形の偽物) を受け取って、操作をまとめる。"""

    def __init__(self, app: Any) -> None:
        self.app = app
        self.ns = app.GetNamespace("MAPI")

    def check(self) -> dict[str, Any]:
        info: dict[str, Any] = {"version": str(getattr(self.app, "Version", ""))}
        try:
            info["user"] = str(self.ns.CurrentUser.Name)
        except Exception:  # noqa: BLE001
            info["user"] = ""
        info["inbox_count"] = _count(self.ns.GetDefaultFolder(FOLDERS["inbox"]).Items)
        info["calendar_count"] = _count(self.ns.GetDefaultFolder(OL_FOLDER_CALENDAR).Items)
        return info

    # --- メール ---------------------------------------------------------

    def list_mail(
        self,
        folder: str = "inbox",
        since: datetime | None = None,
        until: datetime | None = None,
        sender: str | None = None,
        subject: str | None = None,
        unread_only: bool = False,
        limit: int = 20,
        preview_chars: int = 80,
        scan_limit: int = 500,
    ) -> dict[str, Any]:
        folder = folder.lower()
        if folder not in FOLDERS:
            raise ValueError(f"フォルダは {', '.join(FOLDERS)} のどれかを指定してください")
        items = self.ns.GetDefaultFolder(FOLDERS[folder]).Items
        items.Sort(SORT_FIELDS[folder], True)  # 新しい順

        rows: list[dict[str, Any]] = []
        new_aliases: dict[str, str] = {}
        scanned = 0
        scan_limited = False
        for item in items:
            scanned += 1
            if scanned > scan_limit:
                scan_limited = True
                break
            when = naive(getattr(item, TIME_ATTRS[folder], None))
            if since and when and when < since:
                break  # 新しい順なので、これより後ろは全部古い
            if until and when and when >= until:
                continue
            if unread_only and not getattr(item, "Unread", False):
                continue
            sender_name = str(getattr(item, "SenderName", "") or "")
            sender_addr = str(getattr(item, "SenderEmailAddress", "") or "")
            if sender and sender.lower() not in f"{sender_name} {sender_addr}".lower():
                continue
            subject_text = str(getattr(item, "Subject", "") or "")
            if subject and subject.lower() not in subject_text.lower():
                continue
            entry_id = str(getattr(item, "EntryID", "") or "")
            alias = make_alias("m", entry_id)
            new_aliases[alias] = entry_id
            try:
                preview = one_line(str(getattr(item, "Body", "") or ""), preview_chars) if preview_chars else ""
            except Exception:  # noqa: BLE001
                preview = ""
            rows.append(
                {
                    "id": alias,
                    "time": fmt_time(when),
                    "sender": sender_name,
                    "subject": subject_text,
                    "unread": bool(getattr(item, "Unread", False)),
                    "attachments": _count(getattr(item, "Attachments", None)),
                    "preview": preview,
                }
            )
            if len(rows) >= limit:
                break
        remember_aliases(new_aliases)
        return {"items": rows, "scanned": scanned, "scan_limited": scan_limited}

    def get_mail(self, ref: str, strip_quotes: bool = False) -> dict[str, Any]:
        entry_id = resolve_id(ref)
        item = self.ns.GetItemFromID(entry_id)
        body = str(getattr(item, "Body", "") or "")
        if not body.strip():
            body = html_to_text(str(getattr(item, "HTMLBody", "") or ""))
        if strip_quotes:
            body = strip_quoted(body)
        names: list[str] = []
        try:
            for attachment in item.Attachments:
                names.append(str(getattr(attachment, "FileName", "") or ""))
        except Exception:  # noqa: BLE001
            pass
        return {
            "id": make_alias("m", entry_id),
            "subject": str(getattr(item, "Subject", "") or ""),
            "sender": str(getattr(item, "SenderName", "") or ""),
            "to": str(getattr(item, "To", "") or ""),
            "cc": str(getattr(item, "CC", "") or ""),
            "time": fmt_time(naive(getattr(item, "ReceivedTime", None) or getattr(item, "SentOn", None))),
            "attachments": names,
            "body": body,
        }

    # --- キャッシュ用の読み取り (outlook_cache.sync が使う) -----------------

    def mail_folders(self) -> list[tuple[str, Any]]:
        """キャッシュに取り込むフォルダ。受信トレイとその下、送信済みとその下 (削除済み・迷惑メールは除く)。"""
        forbidden = self._forbidden_ids()
        found: list[tuple[str, Any]] = []

        def visit(kind: str, folder: Any, level: int) -> None:
            if str(getattr(folder, "EntryID", "")) in forbidden or level > 10:
                return
            found.append((kind, folder))
            for child in folder.Folders:
                visit(kind, child, level + 1)

        for kind in CACHE_SORT_FIELDS:
            visit(kind, self.ns.GetDefaultFolder(FOLDERS[kind]), 0)
        return found

    @staticmethod
    def mail_record(item: Any, when: datetime) -> dict[str, Any]:
        """1 通を、キャッシュに入れる形で読む。添付ファイルは、件数だけ (中身も名前も読まない)。"""
        body = str(getattr(item, "Body", "") or "")
        if not body.strip():
            body = html_to_text(str(getattr(item, "HTMLBody", "") or ""))
        return {
            "entry_id": str(getattr(item, "EntryID", "") or ""),
            "time": when,
            "sender": str(getattr(item, "SenderName", "") or ""),
            "sender_addr": str(getattr(item, "SenderEmailAddress", "") or ""),
            "to": str(getattr(item, "To", "") or ""),
            "cc": str(getattr(item, "CC", "") or ""),
            "subject": str(getattr(item, "Subject", "") or ""),
            "attachments": _count(getattr(item, "Attachments", None)),
            "body": body,
        }

    def create_reply_draft(self, ref: str, body: str, reply_all: bool = False) -> dict[str, Any]:
        """返信を作って、下書きに保存する。送信はしない。"""
        entry_id = resolve_id(ref)
        original = self.ns.GetItemFromID(entry_id)
        reply = original.ReplyAll() if reply_all else original.Reply()
        if getattr(reply, "BodyFormat", 1) == OL_FORMAT_HTML:
            reply.HTMLBody = insert_into_html_body(str(reply.HTMLBody or ""), text_to_html(body))
        else:
            reply.Body = body + "\r\n\r\n" + str(reply.Body or "")
        reply.Save()
        draft_id = str(getattr(reply, "EntryID", "") or "")
        remember_aliases({make_alias("d", draft_id): draft_id} if draft_id else {})
        return {
            "id": make_alias("d", draft_id) if draft_id else "",
            "to": str(getattr(reply, "To", "") or ""),
            "cc": str(getattr(reply, "CC", "") or ""),
            "subject": str(getattr(reply, "Subject", "") or ""),
        }

    # --- 予定 -----------------------------------------------------------

    def list_events(self, since: datetime, until: datetime, limit: int = 50) -> dict[str, Any]:
        items = self.ns.GetDefaultFolder(OL_FOLDER_CALENDAR).Items
        items.IncludeRecurrences = True
        items.Sort("[Start]")
        restricted = None
        last_error: Exception | None = None
        for fmt in date_formats():
            condition = f"[Start] <= '{until.strftime(fmt)}' AND [End] >= '{since.strftime(fmt)}'"
            try:
                restricted = items.Restrict(condition)
                break
            except Exception as exc:  # noqa: BLE001
                last_error = exc
        if restricted is None:
            raise RuntimeError(
                "予定の絞り込みに失敗しました。環境変数 OPENCODE_OUTLOOK_DATE_FORMAT に、"
                "Outlook が受け付ける日時の形式 (例: %Y/%m/%d %H:%M) を設定してください"
            ) from last_error

        rows: list[dict[str, Any]] = []
        for item in restricted:
            start = naive(getattr(item, "Start", None))
            end = naive(getattr(item, "End", None))
            if start and start >= until:
                break  # 開始順に並んでいる。繰り返しの予定は、終わりが無いこともあるので、ここで止める
            if end and end <= since:
                continue
            rows.append(
                {
                    "start": fmt_time(start),
                    "end": fmt_time(end),
                    "subject": str(getattr(item, "Subject", "") or ""),
                    "location": str(getattr(item, "Location", "") or ""),
                    "all_day": bool(getattr(item, "AllDayEvent", False)),
                    "recurring": bool(getattr(item, "IsRecurring", False)),
                    "organizer": str(getattr(item, "Organizer", "") or ""),
                    "attendees": one_line(str(getattr(item, "RequiredAttendees", "") or ""), 80),
                }
            )
            if len(rows) >= limit:
                break
        return {"items": rows}

    def create_event(
        self,
        subject: str,
        start: datetime,
        duration_min: int = 60,
        location: str = "",
        body: str = "",
        attendees: list[str] | None = None,
        reminder_min: int | None = 15,
        all_day: bool = False,
        busy_status: int = 2,
    ) -> dict[str, Any]:
        """予定を作って保存する。出席者を付けても、招待は送らない。"""
        appointment = self.app.CreateItem(OL_ITEM_APPOINTMENT)
        appointment.Subject = subject
        appointment.Start = start.strftime("%Y/%m/%d %H:%M:%S")
        if all_day:
            appointment.AllDayEvent = True
        else:
            appointment.Duration = duration_min
        appointment.Location = location
        if body:
            appointment.Body = body
        if reminder_min is not None:
            appointment.ReminderSet = True
            appointment.ReminderMinutesBeforeStart = reminder_min
        appointment.BusyStatus = busy_status
        if attendees:
            appointment.MeetingStatus = OL_MEETING
            for address in attendees:
                appointment.Recipients.Add(address)
            appointment.Recipients.ResolveAll()
        appointment.Save()
        return {"subject": subject, "start": fmt_time(start), "attendees": list(attendees or [])}

    # --- フォルダと整理 ---------------------------------------------------

    def _root_folder(self, root: str) -> Any:
        if root not in ROOTS:
            raise ValueError(f"起点は {', '.join(ROOTS)} のどちらかを指定してください")
        inbox = self.ns.GetDefaultFolder(FOLDERS["inbox"])
        return inbox if root == "inbox" else inbox.Parent

    def _forbidden_ids(self) -> set[str]:
        ids: set[str] = set()
        for folder_id in (OL_FOLDER_DELETED, OL_FOLDER_JUNK):
            try:
                ids.add(str(self.ns.GetDefaultFolder(folder_id).EntryID))
            except Exception:  # noqa: BLE001 - 迷惑メールのフォルダが無い環境もある
                pass
        return ids

    def _under_forbidden(self, folder: Any) -> bool:
        """削除済みアイテム、迷惑メール、またはその下のフォルダか。"""
        forbidden = self._forbidden_ids()
        current = folder
        for _ in range(20):
            if current is None:
                break
            if str(getattr(current, "EntryID", "")) in forbidden:
                return True
            current = getattr(current, "Parent", None)
        return False

    @staticmethod
    def _child(folder: Any, name: str) -> Any | None:
        wanted = name.casefold()
        for child in folder.Folders:
            if str(getattr(child, "Name", "")).casefold() == wanted:
                return child
        return None

    def _walk(self, start: Any, parts: list[str]) -> tuple[Any, list[str]]:
        """パスをたどり、存在する一番深いフォルダと、存在しない残りの名前を返す。"""
        if parts and parts[0].casefold() == str(getattr(start, "Name", "")).casefold():
            parts = parts[1:]  # 先頭に起点の名前 (受信トレイ) が付いていても受け付ける
        folder = start
        for index, name in enumerate(parts):
            child = self._child(folder, name)
            if child is None:
                return folder, parts[index:]
            folder = child
        return folder, []

    def _not_found(self, folder: Any, missing: list[str]) -> ValueError:
        siblings = [str(getattr(c, "Name", "")) for c in folder.Folders][:10]
        where = folder_path(folder) or str(getattr(folder, "Name", ""))
        hint = f" '{where}' の下にあるフォルダ: {', '.join(siblings)}" if siblings else f" '{where}' の下にフォルダはありません"
        return ValueError(f"フォルダ '{missing[0]}' が見つかりません。{hint}")

    def list_folders(self, root: str = "inbox", depth: int = 2) -> dict[str, Any]:
        start = self._root_folder(root)
        forbidden = self._forbidden_ids()
        rows: list[dict[str, Any]] = []

        def visit(folder: Any, relative: str, level: int) -> None:
            try:
                unread = int(getattr(folder, "UnReadItemCount", 0) or 0)
            except (TypeError, ValueError):
                unread = 0
            rows.append({"path": relative or ".", "name": str(getattr(folder, "Name", "")), "count": _count(getattr(folder, "Items", None)), "unread": unread})
            if level >= depth:
                return
            for child in folder.Folders:
                if str(getattr(child, "EntryID", "")) in forbidden:
                    continue  # 削除済みアイテム・迷惑メールは、整理の対象にしない
                name = str(getattr(child, "Name", ""))
                visit(child, f"{relative}/{name}" if relative else name, level + 1)

        visit(start, "", 0)
        return {"root": root, "rows": rows}

    def create_folder(self, path: str, root: str = "inbox", dry_run: bool = False) -> dict[str, Any]:
        """フォルダを作る (途中のフォルダも作る)。すでにあれば、何もしない。"""
        parts = split_folder_path(path)
        if not parts:
            raise ValueError("作るフォルダの名前を指定してください")
        start = self._root_folder(root)
        folder, missing = self._walk(start, parts)
        if self._under_forbidden(folder):
            raise ValueError("削除済みアイテムと迷惑メールの下には、フォルダを作れません")
        base = folder_path(folder)
        for name in missing:
            if not dry_run:
                folder = folder.Folders.Add(name)
        full = "/".join([p for p in [base] + missing if p])
        return {"path": full, "created": missing}

    def move_mails(self, refs: list[str], path: str, root: str = "inbox", create_missing: bool = False, dry_run: bool = False) -> dict[str, Any]:
        """メールを別のフォルダへ移動する。削除済みアイテム・迷惑メールへは移動しない。記録を残す。"""
        if not refs:
            raise ValueError("移動するメールの ID を指定してください")
        if len(refs) > MOVE_LIMIT:
            raise ValueError(f"一度に移動できるのは {MOVE_LIMIT} 通までです (指定: {len(refs)} 通)")
        start = self._root_folder(root)
        target, missing = self._walk(start, split_folder_path(path))
        if self._under_forbidden(target):
            raise ValueError("削除済みアイテムと迷惑メールへは移動できません")
        if missing and not create_missing:
            raise self._not_found(target, missing)
        to_path = "/".join([p for p in [folder_path(target)] + missing if p])
        if missing and not dry_run:
            for name in missing:
                target = target.Folders.Add(name)

        rows: list[dict[str, Any]] = []
        for ref in refs:
            row: dict[str, Any] = {"ref": ref, "to_path": to_path}
            try:
                item = self.ns.GetItemFromID(resolve_id(ref))
                source = item.Parent
                row["subject"] = str(getattr(item, "Subject", "") or "")
                row["from_path"] = folder_path(source)
                if not missing and str(getattr(source, "EntryID", "")) == str(getattr(target, "EntryID", "")):
                    row["status"] = "対象外 (すでにそのフォルダにあります)"
                elif dry_run:
                    row["status"] = "移動予定"
                else:
                    moved = item.Move(target)
                    new_entry = str(moved.EntryID)
                    new_alias = make_alias("m", new_entry)
                    remember_aliases({new_alias: new_entry})
                    append_movelog(
                        {
                            "action": "move", "new_alias": new_alias, "new_id": new_entry, "subject": row["subject"],
                            "from_path": row["from_path"], "from_entry": str(getattr(source, "EntryID", "")), "to_path": to_path,
                        }
                    )
                    row["status"] = "移動しました"
                    row["new_id"] = new_alias
            except Exception as exc:  # noqa: BLE001 - 1 通の失敗で、ほかを止めない
                row["status"] = "失敗"
                row["error"] = str(exc)
            rows.append(row)
        return {"to_path": to_path, "created": missing, "rows": rows}

    def undo_moves(self, refs: list[str] | None = None, last: int | None = None, dry_run: bool = False) -> dict[str, Any]:
        """記録をもとに、移動したメールを元のフォルダへ戻す。"""
        records = read_movelog()
        undone = {r.get("undo_of") for r in records if r.get("action") == "undo"}
        candidates = [r for r in records if r.get("action") == "move" and r.get("new_alias") not in undone]
        selected: list[dict[str, Any] | str] = []
        if refs:
            by_alias = {r["new_alias"]: r for r in candidates}
            selected = [by_alias.get(ref, ref) for ref in refs]
        elif last:
            selected = list(reversed(candidates))[:last]
        else:
            raise ValueError("元に戻すメールの ID か、--last 件数 を指定してください")

        rows: list[dict[str, Any]] = []
        for record in selected:
            if isinstance(record, str):
                rows.append({"ref": record, "status": "失敗", "error": "移動の記録がありません (すでに戻したか、このPCで移動していません)"})
                continue
            row: dict[str, Any] = {"ref": record["new_alias"], "subject": record.get("subject", ""), "from_path": record.get("to_path", ""), "to_path": record.get("from_path", "")}
            try:
                if dry_run:
                    row["status"] = "戻す予定"
                else:
                    item = self.ns.GetItemFromID(record["new_id"])
                    destination = self.ns.GetFolderFromID(record["from_entry"])
                    moved = item.Move(destination)
                    new_entry = str(moved.EntryID)
                    new_alias = make_alias("m", new_entry)
                    remember_aliases({new_alias: new_entry})
                    append_movelog({"action": "undo", "undo_of": record["new_alias"], "new_alias": new_alias, "subject": row["subject"]})
                    row["status"] = "元に戻しました"
                    row["new_id"] = new_alias
            except Exception as exc:  # noqa: BLE001
                row["status"] = "失敗"
                row["error"] = str(exc)
            rows.append(row)
        return {"rows": rows}

    def move_log(self, limit: int = 20) -> dict[str, Any]:
        records = read_movelog()
        undone = {r.get("undo_of") for r in records if r.get("action") == "undo"}
        moves = [r for r in records if r.get("action") == "move"]
        rows = [{**r, "undone": r.get("new_alias") in undone} for r in reversed(moves)][:limit]
        return {"rows": rows}
