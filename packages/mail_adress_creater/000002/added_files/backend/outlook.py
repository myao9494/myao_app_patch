"""Outlook COM連携（Windows + pywin32）。送信済みの宛先取得、予定登録、職アド受信メールの検索を行う。"""
from __future__ import annotations

import html
import os
import re
import shutil
import sys
import tempfile
from contextlib import contextmanager
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from backend import db
from backend.config import LOGGER
from backend.event_parser import ParsedEvent


HTML_TAG_PATTERN = re.compile(r"</?[A-Za-z][^<>]*>")


BLOCK_TAGS = {"p", "div", "li", "tr", "table", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"}


IGNORED_TAGS = {"script", "style", "head", "title"}


def outlook_namespace() -> Any:
    return outlook_application().GetNamespace("MAPI")


def _import_win32com_client() -> Any:
    try:
        import win32com.client  # type: ignore[import-not-found]
    except ImportError as exc:
        LOGGER.warning("pywin32 import failed: %s", exc)
        raise RuntimeError("Outlook連携にはWindows環境とpywin32が必要です") from exc
    return win32com.client


def outlook_application() -> Any:
    """Outlook.Application に接続する。

    型ライブラリのキャッシュ不整合は、キャッシュ削除→再試行→Dispatchの順で復旧する。
    """
    client = _import_win32com_client()
    try:
        return client.gencache.EnsureDispatch("Outlook.Application")
    except Exception:  # noqa: BLE001 - pywin32 raises platform-specific COM errors
        LOGGER.warning("EnsureDispatch failed; clearing Outlook gen_py cache and retrying", exc_info=True)
        clear_outlook_gen_py_cache()
        client = _import_win32com_client()

    try:
        return client.gencache.EnsureDispatch("Outlook.Application")
    except Exception:  # noqa: BLE001
        LOGGER.warning("EnsureDispatch retry failed; falling back to Dispatch", exc_info=True)

    try:
        return client.Dispatch("Outlook.Application")
    except Exception as exc:  # noqa: BLE001
        LOGGER.exception("Failed to connect to Outlook COM namespace")
        raise RuntimeError(
            "OutlookのCOM連携を開始できません。"
            "クラシック版Outlookがインストールされ、同じWindowsユーザーで起動できる状態か確認してください。"
            "新しいOutlookのみの環境ではOutlook.Applicationが登録されないため、この機能は使えません。"
        ) from exc


def gen_py_cache_dir() -> Path | None:
    """pywin32が型ライブラリのラッパーを生成する %TEMP%/gen_py/<Pythonのバージョン> を返す。"""
    temp = os.environ.get("TEMP")
    if not temp:
        return None
    return Path(temp) / "gen_py" / f"{sys.version_info.major}.{sys.version_info.minor}"


def clear_outlook_gen_py_cache() -> None:
    cache_dir = gen_py_cache_dir()
    if cache_dir is not None and cache_dir.exists():
        for folder in cache_dir.glob("*000000000046*"):  # Outlook型ライブラリのGUID
            if folder.is_dir():
                shutil.rmtree(folder, ignore_errors=True)

    # sys.modules から win32com 関連モジュールをクリアしてメモリ上のキャッシュをパージする
    for name in [name for name in sys.modules if name.startswith("win32com")]:
        sys.modules.pop(name, None)


@contextmanager
def outlook_com_context() -> Any:
    try:
        import pythoncom  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("Outlook連携にはWindows環境とpywin32が必要です") from exc

    pythoncom.CoInitialize()
    try:
        yield
    finally:
        pythoncom.CoUninitialize()


def get_sent_item_recipients(limit: int = 150) -> list[str]:
    with outlook_com_context():
        namespace = outlook_namespace()
        sent_folder = namespace.GetDefaultFolder(5)
        items = sent_folder.Items
        items.Sort("[SentOn]", True)
        recipients: list[str] = []
        for index, item in enumerate(items, start=1):
            if index > limit:
                break
            for recipient in item.Recipients:
                name = str(getattr(recipient, "Name", "") or "").strip()
                if name:
                    recipients.append(name)
        return recipients


def looks_like_html(body: str) -> bool:
    """本文がHTMLタグを含むか。`A &amp; B` や `a < b` のような平文は対象外。"""
    return bool(HTML_TAG_PATTERN.search(body))


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._ignored_depth = 0

    def _ensure_newline(self) -> None:
        if self.parts and not self.parts[-1].endswith("\n"):
            self.parts.append("\n")

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in IGNORED_TAGS:
            self._ignored_depth += 1
        elif tag == "br":
            self.parts.append("\n")
        elif tag in BLOCK_TAGS:
            self._ensure_newline()

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "br":
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in IGNORED_TAGS:
            self._ignored_depth = max(0, self._ignored_depth - 1)
        elif tag in BLOCK_TAGS:
            self._ensure_newline()

    def handle_data(self, data: str) -> None:
        if not self._ignored_depth:
            self.parts.append(data.replace("\xa0", " "))


def html_to_text(body: str) -> str:
    """HTML本文を、改行を保った読みやすい平文へ変換する。"""
    extractor = _TextExtractor()
    extractor.feed(body)
    extractor.close()
    lines = "".join(extractor.parts).split("\n")
    return "\n".join(line.strip() for line in lines).strip("\n")


def set_appointment_body(appointment: Any, body: str) -> None:
    """予定本文を設定する。HTMLは一時ファイル経由でWordEditorへ取り込み、失敗時は平文にする。"""
    if not looks_like_html(body):
        appointment.Body = html.unescape(body)
        return

    temp_filepath: str | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".html", delete=False, mode="w", encoding="utf-8") as temp_file:
            temp_file.write(body)
            temp_filepath = temp_file.name
        appointment.GetInspector.WordEditor.Range().InsertFile(temp_filepath)
    except Exception:  # noqa: BLE001 - COMのエラー型は環境依存
        LOGGER.warning("Failed to insert HTML via WordEditor; falling back to plain text Body", exc_info=True)
        appointment.Body = html_to_text(body)
    finally:
        if temp_filepath and os.path.exists(temp_filepath):
            try:
                os.remove(temp_filepath)
            except OSError:
                LOGGER.warning("Failed to remove temporary HTML file: %s", temp_filepath)


def save_outlook_event(event: ParsedEvent) -> None:
    with outlook_com_context():
        app = outlook_application()
        appointment = app.CreateItem(1)
        appointment.Start = event.start.strftime("%Y/%m/%d %H:%M:%S")
        appointment.Subject = event.subject
        appointment.Duration = event.duration_minutes
        appointment.Location = event.location

        set_appointment_body(appointment, event.body)

        appointment.ReminderSet = True
        appointment.ReminderMinutesBeforeStart = 5
        appointment.AllDayEvent = bool(event.all_day)
        appointment.BusyStatus = 2
        appointment.Save()


def message_received_time(message: Any) -> str:
    received_time = getattr(message, "ReceivedTime", "")
    if hasattr(received_time, "isoformat"):
        return received_time.isoformat()
    return str(received_time)


def find_keyword_matches(keywords: list[str], limit: int = 500) -> list[db.KeywordMatch]:
    # 除外キーワードを示すプレフィックス（半角マイナス、全角マイナス、長音記号、ダッシュ、ハイフンなど）
    exclude_prefixes = ("-", "－", "ー", "―", "−")

    # 肯定キーワードと除外キーワードに分ける
    positive_keywords = [
        k for k in keywords
        if not (k.startswith(exclude_prefixes) and len(k.strip()) > 1) and k.strip()
    ]
    negative_keywords = [
        k[1:].strip() for k in keywords
        if k.startswith(exclude_prefixes) and len(k.strip()) > 1
    ]

    with outlook_com_context():
        namespace = outlook_namespace()
        inbox = namespace.GetDefaultFolder(6)
        messages = inbox.Items
        messages.Sort("[ReceivedTime]", True)
        matches: list[db.KeywordMatch] = []
        for index, message in enumerate(messages, start=1):
            if index > limit:
                break
            subject = str(getattr(message, "Subject", "") or "")
            if "職アドからのお知らせ" not in subject:
                continue
            body = str(getattr(message, "Body", "") or "")
            received_time = message_received_time(message)
            for line in body.splitlines():
                # 肯定キーワードのいずれかが line に含まれているかチェック
                matched_keyword = next((keyword for keyword in positive_keywords if keyword in line), None)
                if matched_keyword:
                    # 除外キーワードのいずれかが subject または line に含まれている場合は除外
                    if any(neg in line or neg in subject for neg in negative_keywords):
                        continue

                    matches.append(
                        db.KeywordMatch(
                            received_time=received_time,
                            subject=subject,
                            line=line.strip(),
                            keyword=matched_keyword,
                            is_new=False,
                        )
                    )
        return matches
