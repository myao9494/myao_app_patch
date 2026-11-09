"""outlook_client / outlook_cli のテスト。本物の Outlook は使わず、偽物 (Fake*) で確認する。

実行: python -m unittest discover -s skills/outlook-mail/tests -v   (リポジトリのルートから)
"""
from __future__ import annotations

import copy
import io
import os
import re
import sys
import tempfile
import unittest
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR / "scripts"))

import outlook_cache as cache  # noqa: E402
import outlook_cli as cli  # noqa: E402
import outlook_client as oc  # noqa: E402


# ---------------------------------------------------------------------------
# Outlook COM の偽物
# ---------------------------------------------------------------------------

class FakeCollection:
    def __init__(self, items=None) -> None:
        self._items = list(items or [])

    @property
    def Count(self) -> int:  # noqa: N802 - COM の名前に合わせる
        return len(self._items)

    def __iter__(self):
        return iter(list(self._items))

    def Add(self, value):  # noqa: N802
        self._items.append(value)
        return value

    def ResolveAll(self) -> bool:  # noqa: N802
        self.resolved = True
        return True


class FakeItems(FakeCollection):
    """Items の偽物。Sort は並べ替え、Restrict は日時の書式だけを検査する。"""

    def __init__(self, items=None, accept_format: str | None = None) -> None:
        super().__init__(items)
        self.accept_format = accept_format  # "ja" か "us"。None なら何でも受け付ける
        self.IncludeRecurrences = False
        self.sort_calls: list[tuple] = []
        self.restrict_calls: list[str] = []

    def Sort(self, field, descending=False):  # noqa: N802
        self.sort_calls.append((field, descending))
        attr = field.strip("[]")
        self._items.sort(key=lambda item: getattr(item, attr), reverse=descending)

    def Restrict(self, condition):  # noqa: N802
        self.restrict_calls.append(condition)
        ja = re.search(r"'\d{4}/\d{2}/\d{2} ", condition)
        us = re.search(r"'\d{2}/\d{2}/\d{4} ", condition)
        if self.accept_format == "ja" and not ja:
            raise RuntimeError("日時の形式が違う")
        if self.accept_format == "us" and not us:
            raise RuntimeError("日時の形式が違う")
        return FakeItems(self._items)


class Trap:
    """送信・削除のように、呼んではいけないメソッド。呼ばれたらテストを失敗させる。"""

    def Send(self, *a, **k):  # noqa: N802
        raise AssertionError("Send が呼ばれました")

    def Delete(self, *a, **k):  # noqa: N802
        raise AssertionError("Delete が呼ばれました")


class FakeAttachment:
    def __init__(self, name: str) -> None:
        self.FileName = name


class FakeReply(Trap):
    def __init__(self, html: bool = False) -> None:
        self.BodyFormat = oc.OL_FORMAT_HTML if html else 1
        self.Body = "元の本文\r\n> 引用"
        self.HTMLBody = "<html><body><p>元の本文</p></body></html>"
        self.To = "sender@example.com"
        self.CC = ""
        self.Subject = "RE: 件名"
        self.EntryID = "ABCDEF0123456789" * 3
        self.saved = False

    def Save(self) -> None:  # noqa: N802
        self.saved = True


class FakeMail(Trap):
    def __init__(self, entry_id: str, subject: str, sender: str, when: datetime, body: str = "本文", unread: bool = False,
                 attachments: tuple[str, ...] = (), html: bool = False) -> None:
        self.EntryID = entry_id
        self.Subject = subject
        self.SenderName = sender
        self.SenderEmailAddress = f"{sender}@example.com"
        self.ReceivedTime = when
        self.SentOn = when
        self.LastModificationTime = when
        self.Body = body
        self.HTMLBody = ""
        self.Unread = unread
        self.To = "me@example.com"
        self.CC = ""
        self.Attachments = FakeCollection([FakeAttachment(n) for n in attachments])
        self.reply_html = html
        self.replies: list[FakeReply] = []

    def Reply(self) -> FakeReply:  # noqa: N802
        reply = FakeReply(self.reply_html)
        self.replies.append(reply)
        return reply

    def ReplyAll(self) -> FakeReply:  # noqa: N802
        reply = FakeReply(self.reply_html)
        reply.CC = "all@example.com"
        self.replies.append(reply)
        return reply

    def Move(self, target) -> "FakeMail":  # noqa: N802
        """別のフォルダへ移す。Outlook と同じく、移動後は新しい EntryID の別のアイテムになる。"""
        self.Parent.Items._items.remove(self)
        moved = copy.copy(self)
        moved.EntryID = "MOVED-" + self.EntryID
        moved.Parent = target
        target.Items._items.append(moved)
        return moved


class FakeAppointment(Trap):
    def __init__(self) -> None:
        self.Recipients = FakeCollection()
        self.saved = False

    def Save(self) -> None:  # noqa: N802
        self.saved = True


class FakeEvent:
    def __init__(self, subject: str, start: datetime, end: datetime, **extra) -> None:
        self.Subject = subject
        self.Start = start
        self.End = end
        self.Location = extra.get("location", "")
        self.AllDayEvent = extra.get("all_day", False)
        self.IsRecurring = extra.get("recurring", False)
        self.Organizer = extra.get("organizer", "")
        self.RequiredAttendees = extra.get("attendees", "")


class FakeFolders(FakeCollection):
    def __init__(self, owner: "FakeFolder") -> None:
        super().__init__()
        self.owner = owner

    def Add(self, name: str) -> "FakeFolder":  # noqa: N802
        return FakeFolder(name, parent=self.owner, registry=self.owner.registry)  # 親の一覧への登録は FakeFolder が行う


class FakeFolder:
    def __init__(self, name: str, items: FakeItems | None = None, parent: "FakeFolder | None" = None, registry: dict | None = None) -> None:
        self.Name = name
        self.Parent = parent
        self.registry = registry if registry is not None else {}
        self.EntryID = f"FOLDER-{len(self.registry)}"
        self.registry[self.EntryID] = self
        self.Items = items or FakeItems([])
        self.Folders = FakeFolders(self)
        self.UnReadItemCount = sum(1 for m in self.Items._items if getattr(m, "Unread", False))
        for item in self.Items._items:
            item.Parent = self
        if parent is not None:
            parent.Folders._items.append(self)


class FakeNamespace:
    def __init__(self, defaults: dict[int, FakeFolder], registry: dict[str, FakeFolder]) -> None:
        self.defaults = defaults
        self.registry = registry
        self.CurrentUser = type("U", (), {"Name": "テスト 太郎"})()

    def GetDefaultFolder(self, folder_id: int) -> FakeFolder:  # noqa: N802
        return self.defaults[folder_id]

    def GetFolderFromID(self, entry_id: str) -> FakeFolder:  # noqa: N802
        return self.registry[entry_id]

    def GetItemFromID(self, entry_id: str):  # noqa: N802
        for folder in self.registry.values():
            for item in folder.Items._items:
                if getattr(item, "EntryID", None) == entry_id:
                    return item
        raise KeyError(entry_id)


class FakeApp:
    Version = "16.0.0"

    def __init__(self, mails: list[FakeMail], events: list[FakeEvent] | None = None, accept_format: str | None = None) -> None:
        registry: dict = {}
        root = FakeFolder("mailbox@example.com", registry=registry)
        self.inbox = FakeFolder("受信トレイ", FakeItems(mails), parent=root, registry=registry)
        sent = FakeFolder("送信済みアイテム", parent=root, registry=registry)
        self.sent = sent
        drafts = FakeFolder("下書き", parent=root, registry=registry)
        self.deleted = FakeFolder("削除済みアイテム", parent=root, registry=registry)
        self.junk = FakeFolder("迷惑メール", parent=root, registry=registry)
        self.calendar_items = FakeItems(events or [], accept_format=accept_format)
        calendar = FakeFolder("予定表", self.calendar_items, parent=root, registry=registry)
        self.root = root
        self.namespace = FakeNamespace({6: self.inbox, 5: sent, 16: drafts, 3: self.deleted, 23: self.junk, 9: calendar}, registry)
        self.appointments: list[FakeAppointment] = []

    def GetNamespace(self, name: str) -> FakeNamespace:  # noqa: N802
        return self.namespace

    def CreateItem(self, item_type: int) -> FakeAppointment:  # noqa: N802
        assert item_type == oc.OL_ITEM_APPOINTMENT
        appointment = FakeAppointment()
        self.appointments.append(appointment)
        return appointment


def long_id(seed: str) -> str:
    return (seed * 64)[:96].upper().replace("-", "A")


# ---------------------------------------------------------------------------
# テストの土台
# ---------------------------------------------------------------------------

class OutlookTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        env = patch.dict(os.environ, {"OPENCODE_OUTLOOK_CACHE": str(self.tmp / "ids.json"), "OPENCODE_OUTLOOK_MOVELOG": str(self.tmp / "moves.jsonl"),
                                           "OPENCODE_OUTLOOK_MAILCACHE": str(self.tmp / "cache" / "mail.sqlite3")})
        env.start()
        self.addCleanup(env.stop)

    def sample_app(self, **kwargs) -> FakeApp:
        mails = [
            FakeMail(long_id("a"), "見積のご連絡", "山田", datetime(2026, 11, 6, 9, 0), body="見積を送ります。\n--\n署名", unread=True, attachments=("見積.xlsx",)),
            FakeMail(long_id("b"), "会議の日程", "佐藤", datetime(2026, 11, 5, 15, 30), body="来週の会議です。"),
            FakeMail(long_id("c"), "先月の報告", "山田", datetime(2026, 10, 1, 10, 0), body="報告です。"),
        ]
        return FakeApp(mails, **kwargs)

    def run_cli(self, argv: list[str], app: FakeApp | None = None) -> tuple[int, str, str]:
        app = app or self.sample_app()

        @contextmanager
        def factory():
            yield oc.OutlookClient(app)

        out, err = io.StringIO(), io.StringIO()
        code = cli.main(argv, client_factory=factory, stdout=out, stderr=err)
        return code, out.getvalue(), err.getvalue()


# ---------------------------------------------------------------------------
# 安全性
# ---------------------------------------------------------------------------

class SafetyTests(unittest.TestCase):
    def read(self, name: str) -> str:
        return (SKILL_DIR / "scripts" / name).read_text(encoding="utf-8")

    def test_送信_削除_転送の呼び出しがソースに無い(self) -> None:
        pattern = re.compile(r"\.(Send|SendUsingAccount|Delete|Forward|Remove)\s*\(")
        for name in ("outlook_client.py", "outlook_cli.py", "outlook_cache.py"):
            self.assertIsNone(pattern.search(self.read(name)), f"{name} に送信・削除の呼び出しがあります")

    def test_移動の呼び出しは_clientの2か所だけ(self) -> None:
        self.assertEqual(self.read("outlook_client.py").count(".Move("), 2)  # move_mails と undo_moves
        self.assertEqual(self.read("outlook_cli.py").count(".Move("), 0)
        self.assertEqual(self.read("outlook_cache.py").count(".Move("), 0)

    def test_キャッシュはOutlookに書き込まない(self) -> None:
        # キャッシュが書くのは、SQLite のファイルだけ。Outlook の保存・作成・フォルダの追加を呼ばない
        self.assertIsNone(re.search(r"\.(Save|Add|CreateItem|Reply|ReplyAll)\s*\(", self.read("outlook_cache.py")))

    def test_run_batはASCIIだけ(self) -> None:
        data = (SKILL_DIR / "run.bat").read_bytes()
        data.decode("ascii")  # 日本語が入っていると例外


# ---------------------------------------------------------------------------
# メール
# ---------------------------------------------------------------------------

class MailListTests(OutlookTestCase):
    def test_新しい順に並び_短いIDが付く(self) -> None:
        code, out, _ = self.run_cli(["mail-list"])
        self.assertEqual(code, 0)
        lines = [l for l in out.splitlines() if l.startswith("[")]
        self.assertEqual(len(lines), 3)
        self.assertIn("見積のご連絡", lines[0])
        self.assertIn("未読", lines[0])
        self.assertIn("添付1", lines[0])
        self.assertRegex(lines[0], r"m[0-9a-f]{6}")
        self.assertNotIn(long_id("a"), out)  # 長い EntryID は出さない

    def test_期間と差出人で絞れる(self) -> None:
        _, out, _ = self.run_cli(["mail-list", "--since", "2026-11-01", "--until", "2026-11-05"])
        self.assertIn("会議の日程", out)
        self.assertNotIn("見積のご連絡", out)  # 11-06 は until(11-05 を含む)より後
        self.assertNotIn("先月の報告", out)    # since より前
        _, out, _ = self.run_cli(["mail-list", "--from", "山田"])
        self.assertIn("見積のご連絡", out)
        self.assertNotIn("会議の日程", out)

    def test_件名_未読_件数の指定(self) -> None:
        _, out, _ = self.run_cli(["mail-list", "--subject", "会議"])
        self.assertTrue(out.startswith("件数: 1"))
        self.assertIn("会議の日程", out)
        _, out, _ = self.run_cli(["mail-list", "--unread"])
        self.assertIn("見積のご連絡", out)
        self.assertNotIn("会議の日程", out)
        _, out, _ = self.run_cli(["mail-list", "--limit", "1"])
        self.assertTrue(out.startswith("件数: 1"))

    def test_冒頭の表示は0で消せる(self) -> None:
        _, out, _ = self.run_cli(["mail-list", "--preview", "0"])
        self.assertNotIn("冒頭:", out)

    def test_不正な日時はエラー(self) -> None:
        code, _, err = self.run_cli(["mail-list", "--since", "昨日"])
        self.assertEqual(code, 2)
        self.assertIn("読めません", err)


class MailGetTests(OutlookTestCase):
    def test_短いIDで本文を読める(self) -> None:
        app = self.sample_app()
        _, listing, _ = self.run_cli(["mail-list"], app)
        alias = re.search(r"\] (m[0-9a-f]{6}) ", listing).group(1)
        code, out, _ = self.run_cli(["mail-get", alias], app)
        self.assertEqual(code, 0)
        self.assertIn("件名: 見積のご連絡", out)
        self.assertIn("添付: 見積.xlsx", out)
        self.assertIn("見積を送ります。", out)

    def test_長い本文は切って_省略を知らせる(self) -> None:
        mail = FakeMail(long_id("d"), "長い", "田中", datetime(2026, 11, 6), body="あ" * 100)
        app = FakeApp([mail])
        _, listing, _ = self.run_cli(["mail-list"], app)
        alias = re.search(r"\] (m[0-9a-f]{6}) ", listing).group(1)
        _, out, _ = self.run_cli(["mail-get", alias, "--max-chars", "30"], app)
        self.assertIn("30 / 全 100 文字", out)
        self.assertIn("70 文字は省略", out)

    def test_引用を省ける(self) -> None:
        body = "了解しました。\n\n差出人: 山田\n送信日時: 2026年11月5日\n件名: 前の件\n昔の本文"
        mail = FakeMail(long_id("e"), "RE: 件", "山田", datetime(2026, 11, 6), body=body)
        app = FakeApp([mail])
        _, listing, _ = self.run_cli(["mail-list"], app)
        alias = re.search(r"\] (m[0-9a-f]{6}) ", listing).group(1)
        _, out, _ = self.run_cli(["mail-get", alias, "--no-quote"], app)
        self.assertIn("了解しました。", out)
        self.assertNotIn("昔の本文", out)
        _, out, _ = self.run_cli(["mail-get", alias], app)
        self.assertIn("昔の本文", out)

    def test_本文が空ならHTMLから取る(self) -> None:
        mail = FakeMail(long_id("f"), "HTMLだけ", "鈴木", datetime(2026, 11, 6), body="")
        mail.HTMLBody = "<html><body><p>こんにちは</p><p>二行目</p></body></html>"
        app = FakeApp([mail])
        _, listing, _ = self.run_cli(["mail-list"], app)
        alias = re.search(r"\] (m[0-9a-f]{6}) ", listing).group(1)
        _, out, _ = self.run_cli(["mail-get", alias], app)
        self.assertIn("こんにちは\n二行目", out)

    def test_知らないIDはエラー(self) -> None:
        code, _, err = self.run_cli(["mail-get", "mzzzzzz"])
        self.assertEqual(code, 2)
        self.assertIn("mail-list", err)

    def test_長い16進数のIDはそのまま使える(self) -> None:
        code, out, _ = self.run_cli(["mail-get", long_id("b")])
        self.assertEqual(code, 0)
        self.assertIn("会議の日程", out)


class ReplyDraftTests(OutlookTestCase):
    def prepare(self, html: bool = False):
        mail = FakeMail(long_id("a"), "見積", "山田", datetime(2026, 11, 6), html=html)
        app = FakeApp([mail])
        _, listing, _ = self.run_cli(["mail-list"], app)
        alias = re.search(r"\] (m[0-9a-f]{6}) ", listing).group(1)
        body_file = self.tmp / "reply.md"
        body_file.write_text("お世話になっております。\n承知しました。", encoding="utf-8")
        return app, mail, alias, body_file

    def test_平文の返信は本文の先頭に足して保存だけする(self) -> None:
        app, mail, alias, body_file = self.prepare()
        code, out, _ = self.run_cli(["reply-draft", alias, "--body-file", str(body_file)], app)
        self.assertEqual(code, 0)
        reply = mail.replies[0]
        self.assertTrue(reply.saved)
        self.assertTrue(reply.Body.startswith("お世話になっております。"))
        self.assertIn("元の本文", reply.Body)
        self.assertIn("送信はしていません", out)

    def test_HTMLの返信はbodyの直後に差し込む(self) -> None:
        app, mail, alias, body_file = self.prepare(html=True)
        self.run_cli(["reply-draft", alias, "--body-file", str(body_file)], app)
        html = mail.replies[0].HTMLBody
        self.assertTrue(html.startswith("<html><body><div>お世話になっております。<br>承知しました。</div>"))
        self.assertIn("<p>元の本文</p>", html)

    def test_全員に返信(self) -> None:
        app, mail, alias, body_file = self.prepare()
        self.run_cli(["reply-draft", alias, "--body-file", str(body_file), "--reply-all"], app)
        self.assertEqual(mail.replies[0].CC, "all@example.com")

    def test_dry_runはOutlookに接続しない(self) -> None:
        body_file = self.tmp / "reply.md"
        body_file.write_text("本文", encoding="utf-8")

        def factory():
            raise AssertionError("dry-run で接続しました")

        out, err = io.StringIO(), io.StringIO()
        code = cli.main(["reply-draft", "m000000", "--body-file", str(body_file), "--dry-run"], client_factory=factory, stdout=out, stderr=err)
        self.assertEqual(code, 0)
        self.assertIn("dry-run", out.getvalue())

    def test_本文ファイルが無い_空ならエラー(self) -> None:
        code, _, err = self.run_cli(["reply-draft", "m000000", "--body-file", str(self.tmp / "none.md")])
        self.assertEqual(code, 2)
        empty = self.tmp / "empty.md"
        empty.write_text("  \n", encoding="utf-8")
        code, _, err = self.run_cli(["reply-draft", "m000000", "--body-file", str(empty)])
        self.assertEqual(code, 2)
        self.assertIn("空", err)


# ---------------------------------------------------------------------------
# 予定
# ---------------------------------------------------------------------------

class CalendarTests(OutlookTestCase):
    def events(self):
        return [
            FakeEvent("朝会", datetime(2026, 11, 9, 9, 0), datetime(2026, 11, 9, 9, 30), recurring=True, organizer="佐藤"),
            FakeEvent("設計レビュー", datetime(2026, 11, 10, 14, 0), datetime(2026, 11, 10, 15, 0), location="会議室A", attendees="山田; 田中"),
            FakeEvent("研修", datetime(2026, 11, 11, 0, 0), datetime(2026, 11, 12, 0, 0), all_day=True),
            FakeEvent("来月の予定", datetime(2026, 12, 1, 10, 0), datetime(2026, 12, 1, 11, 0)),
        ]

    def test_期間内の予定だけを開始順に返す(self) -> None:
        app = FakeApp([], self.events())
        code, out, _ = self.run_cli(["cal-list", "--since", "2026-11-09", "--until", "2026-11-15"], app)
        self.assertEqual(code, 0)
        self.assertIn("朝会", out)
        self.assertIn("会議室A", out)
        self.assertIn("2026-11-11 終日", out)
        self.assertIn("繰り返し", out)
        self.assertNotIn("来月の予定", out)
        self.assertTrue(app.calendar_items.IncludeRecurrences)
        self.assertIn(("[Start]", False), app.calendar_items.sort_calls)

    def test_日時の書式が合わなければ次の書式を試す(self) -> None:
        app = FakeApp([], self.events(), accept_format="us")
        code, out, _ = self.run_cli(["cal-list", "--since", "2026-11-09", "--until", "2026-11-15"], app)
        self.assertEqual(code, 0)
        self.assertEqual(len(app.calendar_items.restrict_calls), 2)  # ja で失敗 → us で成功
        self.assertIn("設計レビュー", out)

    def test_どの書式も合わなければ分かるエラー(self) -> None:
        app = FakeApp([], self.events(), accept_format="us")
        with patch.dict(os.environ, {"OPENCODE_OUTLOOK_DATE_FORMAT": "%Y-%m-%d"}):
            code, _, err = self.run_cli(["cal-list", "--since", "2026-11-09"], app)
        self.assertEqual(code, 3)
        self.assertIn("OPENCODE_OUTLOOK_DATE_FORMAT", err)

    def test_件数の上限(self) -> None:
        app = FakeApp([], self.events())
        _, out, _ = self.run_cli(["cal-list", "--since", "2026-11-09", "--until", "2026-11-30", "--limit", "2"], app)
        self.assertTrue(out.startswith("件数: 2"))

    def test_予定を作る_保存だけで送らない(self) -> None:
        app = FakeApp([])
        body_file = self.tmp / "body.md"
        body_file.write_text("議題: 設計の確認", encoding="utf-8")
        code, out, _ = self.run_cli(
            ["cal-create", "--subject", "設計レビュー", "--start", "2026-11-10 14:00", "--duration-min", "45",
             "--location", "会議室A", "--body-file", str(body_file), "--attendees", "a@example.com; b@example.com"],
            app,
        )
        self.assertEqual(code, 0)
        appt = app.appointments[0]
        self.assertTrue(appt.saved)
        self.assertEqual(appt.Subject, "設計レビュー")
        self.assertEqual(appt.Start, "2026/11/10 14:00:00")
        self.assertEqual(appt.Duration, 45)
        self.assertEqual(appt.Location, "会議室A")
        self.assertEqual(appt.Body, "議題: 設計の確認")
        self.assertEqual(appt.MeetingStatus, oc.OL_MEETING)
        self.assertEqual(appt.Recipients._items, ["a@example.com", "b@example.com"])
        self.assertTrue(appt.ReminderSet)
        self.assertEqual(appt.ReminderMinutesBeforeStart, 15)
        self.assertIn("招待は送っていません", out)

    def test_終了日時から長さを計算する(self) -> None:
        app = FakeApp([])
        self.run_cli(["cal-create", "--subject", "打合せ", "--start", "2026-11-10 14:00", "--end", "2026-11-10 15:30"], app)
        self.assertEqual(app.appointments[0].Duration, 90)

    def test_終日の予定(self) -> None:
        app = FakeApp([])
        self.run_cli(["cal-create", "--subject", "研修", "--start", "2026-11-11 13:00", "--all-day"], app)
        appt = app.appointments[0]
        self.assertTrue(appt.AllDayEvent)
        self.assertEqual(appt.Start, "2026/11/11 00:00:00")
        self.assertFalse(hasattr(appt, "Duration"))

    def test_出席者なしなら会議にしない(self) -> None:
        app = FakeApp([])
        self.run_cli(["cal-create", "--subject", "作業", "--start", "2026-11-10 10:00"], app)
        self.assertFalse(hasattr(app.appointments[0], "MeetingStatus"))

    def test_不正な指定はエラーで予定を作らない(self) -> None:
        app = FakeApp([])
        code, _, err = self.run_cli(["cal-create", "--subject", "x", "--start", "2026-11-10 10:00", "--end", "2026-11-10 09:00"], app)
        self.assertEqual(code, 2)
        self.assertEqual(app.appointments, [])

    def test_dry_runは作らない(self) -> None:
        def factory():
            raise AssertionError("dry-run で接続しました")

        out, err = io.StringIO(), io.StringIO()
        code = cli.main(["cal-create", "--subject", "x", "--start", "2026-11-10 10:00", "--dry-run"], client_factory=factory, stdout=out, stderr=err)
        self.assertEqual(code, 0)
        self.assertIn("dry-run", out.getvalue())


# ---------------------------------------------------------------------------
# フォルダと整理
# ---------------------------------------------------------------------------

class FolderTests(OutlookTestCase):
    def app_with_folders(self) -> FakeApp:
        app = self.sample_app()
        project = app.inbox.Folders.Add("案件A")
        project.Folders.Add("2026")
        app.inbox.Folders.Add("案件B")
        return app

    def test_フォルダの一覧(self) -> None:
        app = self.app_with_folders()
        code, out, _ = self.run_cli(["folder-list", "--depth", "2"], app)
        self.assertEqual(code, 0)
        self.assertIn("- . ", out)
        self.assertIn("案件A/2026", out)
        self.assertIn("案件B", out)
        self.assertNotIn("削除済みアイテム", out)

    def test_mailbox起点の一覧には削除済みと迷惑メールが出ない(self) -> None:
        app = self.app_with_folders()
        _, out, _ = self.run_cli(["folder-list", "--root", "mailbox", "--depth", "1"], app)
        self.assertIn("受信トレイ", out)
        self.assertIn("送信済みアイテム", out)
        self.assertNotIn("削除済みアイテム", out)
        self.assertNotIn("迷惑メール", out)

    def test_フォルダを作る_途中も作る_既にあれば何もしない(self) -> None:
        app = self.sample_app()
        code, out, _ = self.run_cli(["folder-create", "案件C/2026/11"], app)
        self.assertEqual(code, 0)
        self.assertIn("案件C/2026/11", out)
        c = [f for f in app.inbox.Folders if f.Name == "案件C"][0]
        self.assertEqual([f.Name for f in c.Folders], ["2026"])
        _, out, _ = self.run_cli(["folder-create", "案件C/2026"], app)
        self.assertIn("すでにあります", out)

    def test_dry_runでは作らない(self) -> None:
        app = self.sample_app()
        _, out, _ = self.run_cli(["folder-create", "案件X", "--dry-run"], app)
        self.assertIn("dry-run", out)
        self.assertEqual(app.inbox.Folders.Count, 0)

    def test_使えない名前は拒否(self) -> None:
        for bad in ("a:b", "案件*", "../x"):
            code, _, err = self.run_cli(["folder-create", bad])
            self.assertEqual(code, 2, bad)

    def test_削除済みアイテムの下には作れない(self) -> None:
        code, _, err = self.run_cli(["folder-create", "削除済みアイテム/整理", "--root", "mailbox"])
        self.assertEqual(code, 2)
        self.assertIn("作れません", err)


class MoveTests(OutlookTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.app = self.sample_app()
        self.app.inbox.Folders.Add("案件A")
        _, listing, _ = self.run_cli(["mail-list"], self.app)
        self.aliases = re.findall(r"\] (m[0-9a-f]{6}) ", listing)  # 新しい順: 見積, 会議, 先月

    def folder(self, name: str) -> FakeFolder:
        return [f for f in self.app.inbox.Folders if f.Name == name][0]

    def test_移動する_元から消え_先に入り_新しいIDと記録が残る(self) -> None:
        code, out, _ = self.run_cli(["mail-move", self.aliases[0], self.aliases[1], "--to", "案件A"], self.app)
        self.assertEqual(code, 0)
        self.assertEqual([m.Subject for m in self.folder("案件A").Items], ["見積のご連絡", "会議の日程"])
        self.assertEqual(self.app.inbox.Items.Count, 1)
        self.assertIn("成功 2 / 失敗 0", out)
        self.assertIn("受信トレイ → 受信トレイ/案件A", out)
        self.assertIn("mail-undo", out)
        new_ids = re.findall(r"新ID (m[0-9a-f]{6})", out)
        self.assertEqual(len(new_ids), 2)
        # 新しいIDで、移動後のメールを読める
        code, body, _ = self.run_cli(["mail-get", new_ids[0]], self.app)
        self.assertEqual(code, 0)
        self.assertIn("見積のご連絡", body)

    def test_dry_runは移動しない(self) -> None:
        _, out, _ = self.run_cli(["mail-move", self.aliases[0], "--to", "案件A", "--dry-run"], self.app)
        self.assertIn("dry-run", out)
        self.assertIn("移動予定", out)
        self.assertEqual(self.app.inbox.Items.Count, 3)
        self.assertEqual(self.folder("案件A").Items.Count, 0)

    def test_存在しない移動先はエラーで_候補を示す(self) -> None:
        code, _, err = self.run_cli(["mail-move", self.aliases[0], "--to", "案件Z"], self.app)
        self.assertEqual(code, 2)
        self.assertIn("案件A", err)  # 既存のフォルダを案内する
        self.assertEqual(self.app.inbox.Items.Count, 3)

    def test_create_missingで移動先を作る(self) -> None:
        code, out, _ = self.run_cli(["mail-move", self.aliases[0], "--to", "新規/2026", "--create-missing"], self.app)
        self.assertEqual(code, 0)
        self.assertIn("新規作成: 新規/2026", out)
        self.assertEqual(self.folder("新規").Folders._items[0].Items.Count, 1)

    def test_削除済みアイテムと迷惑メールへは移動できない(self) -> None:
        for target in ("削除済みアイテム", "迷惑メール"):
            code, _, err = self.run_cli(["mail-move", self.aliases[0], "--to", target, "--root", "mailbox"], self.app)
            self.assertEqual(code, 2, target)
            self.assertIn("移動できません", err)
        self.assertEqual(self.app.inbox.Items.Count, 3)
        self.assertEqual(self.app.deleted.Items.Count, 0)

    def test_削除済みアイテムの下のフォルダへも移動できない(self) -> None:
        self.app.deleted.Folders.Add("古いもの")
        code, _, _ = self.run_cli(["mail-move", self.aliases[0], "--to", "削除済みアイテム/古いもの", "--root", "mailbox"], self.app)
        self.assertEqual(code, 2)

    def test_一度に移動できる通数の上限(self) -> None:
        ids = [f"m{n:06x}" for n in range(oc.MOVE_LIMIT + 1)]
        code, _, err = self.run_cli(["mail-move", *ids, "--to", "案件A"], self.app)
        self.assertEqual(code, 2)
        self.assertIn(str(oc.MOVE_LIMIT), err)

    def test_一部が失敗しても残りは移動し_終了コードは1(self) -> None:
        code, out, _ = self.run_cli(["mail-move", "mzzzzzz", self.aliases[0], "--to", "案件A"], self.app)
        self.assertEqual(code, 1)
        self.assertIn("成功 1 / 失敗 1", out)
        self.assertEqual(self.folder("案件A").Items.Count, 1)

    def test_すでにそのフォルダにあるメールは対象外(self) -> None:
        _, out, _ = self.run_cli(["mail-move", self.aliases[0], "--to", ".", "--root", "inbox"], self.app)
        self.assertIn("対象外", out)
        self.assertEqual(self.app.inbox.Items.Count, 3)

    def test_受信トレイ名つきのパスも受け付ける(self) -> None:
        code, _, _ = self.run_cli(["mail-move", self.aliases[0], "--to", "受信トレイ/案件A"], self.app)
        self.assertEqual(code, 0)
        self.assertEqual(self.folder("案件A").Items.Count, 1)

    def test_送信_削除は呼ばれない(self) -> None:
        # Trap は Send / Delete を呼ぶと AssertionError。移動の一連の流れで例外が出ないことを確認する
        code, _, _ = self.run_cli(["mail-move", *self.aliases, "--to", "案件A"], self.app)
        self.assertEqual(code, 0)


class UndoTests(OutlookTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.app = self.sample_app()
        self.app.inbox.Folders.Add("案件A")
        _, listing, _ = self.run_cli(["mail-list"], self.app)
        self.aliases = re.findall(r"\] (m[0-9a-f]{6}) ", listing)
        _, out, _ = self.run_cli(["mail-move", self.aliases[0], self.aliases[1], "--to", "案件A"], self.app)
        self.new_ids = re.findall(r"新ID (m[0-9a-f]{6})", out)

    def test_新しいIDで元のフォルダへ戻せる(self) -> None:
        code, out, _ = self.run_cli(["mail-undo", self.new_ids[0]], self.app)
        self.assertEqual(code, 0)
        self.assertIn("元に戻しました", out)
        self.assertEqual(self.app.inbox.Items.Count, 2)
        self.assertEqual([m.Subject for m in [f for f in self.app.inbox.Folders][0].Items], ["会議の日程"])

    def test_lastで直近を戻す_戻し済みは繰り返さない(self) -> None:
        code, out, _ = self.run_cli(["mail-undo", "--last", "2"], self.app)
        self.assertEqual(code, 0)
        self.assertEqual(self.app.inbox.Items.Count, 3)
        code, out, _ = self.run_cli(["mail-undo", "--last", "2"], self.app)
        self.assertIn("成功 0", out)  # もう戻すものが無い

    def test_記録に無いIDは失敗として知らせる(self) -> None:
        code, out, _ = self.run_cli(["mail-undo", "mzzzzzz"], self.app)
        self.assertEqual(code, 1)
        self.assertIn("記録がありません", out)

    def test_dry_runは戻さない(self) -> None:
        _, out, _ = self.run_cli(["mail-undo", "--last", "1", "--dry-run"], self.app)
        self.assertIn("戻す予定", out)
        self.assertEqual(self.app.inbox.Items.Count, 1)

    def test_指定が無ければエラー(self) -> None:
        code, _, err = self.run_cli(["mail-undo"], self.app)
        self.assertEqual(code, 2)

    def test_移動の記録は_消えにくい場所に置き_以前の記録を引き継ぐ(self) -> None:
        # 一時フォルダは、ディスクの掃除で消える。記録が消えると、元に戻せなくなる
        legacy_dir = self.tmp / "temp"
        legacy_dir.mkdir()
        (legacy_dir / "opencode-outlook-moves.jsonl").write_text('{"action": "move", "new_alias": "m000001"}\n', encoding="utf-8")
        with patch.dict(os.environ, {"LOCALAPPDATA": str(self.tmp / "local")}), patch.object(oc.tempfile, "gettempdir", lambda: str(legacy_dir)):
            os.environ.pop("OPENCODE_OUTLOOK_MOVELOG")
            path = oc.movelog_path()
            self.assertEqual(path, self.tmp / "local" / "opencode-harness" / "outlook-moves.jsonl")
            self.assertEqual(oc.read_movelog()[0]["new_alias"], "m000001")
            self.assertTrue((legacy_dir / "opencode-outlook-moves.jsonl").exists())  # 以前の記録は消さない

    def test_移動の記録を見られる(self) -> None:
        self.run_cli(["mail-undo", self.new_ids[0]], self.app)
        _, out, _ = self.run_cli(["move-log"], self.app)
        self.assertIn("見積のご連絡", out)
        self.assertIn("会議の日程", out)
        self.assertIn("元に戻し済み", out)


# ---------------------------------------------------------------------------
# キャッシュ
# ---------------------------------------------------------------------------

class CountingMail(FakeMail):
    """本文を読んだ回数を数える (キャッシュ済みのメールの本文を、読み直していないことを確かめる)。"""

    body_reads = 0

    @property
    def Body(self) -> str:  # noqa: N802
        CountingMail.body_reads += 1
        return self._body

    @Body.setter
    def Body(self, value: str) -> None:  # noqa: N802
        self._body = value


NOW = datetime(2026, 11, 10, 9, 0)


class CacheTests(OutlookTestCase):
    def setUp(self) -> None:
        super().setUp()
        clock = patch.object(cli, "now", lambda: NOW)
        clock.start()
        self.addCleanup(clock.stop)
        CountingMail.body_reads = 0
        self.app = FakeApp([
            CountingMail(long_id("a"), "見積のご連絡", "山田", datetime(2026, 11, 6, 9, 0), body="見積を送ります。金額は 120 万円です。", attachments=("見積.xlsx",)),
            CountingMail(long_id("b"), "会議の日程", "佐藤", datetime(2026, 11, 5, 15, 30), body="来週の会議です。ＡＢＣ会議室。"),
            CountingMail(long_id("c"), "夏の報告", "山田", datetime(2026, 7, 1, 10, 0), body="90 日より前のメール。"),
        ])
        project = self.app.inbox.Folders.Add("案件A")
        self.add(project, CountingMail(long_id("d"), "RE: 見積のご連絡", "山田", datetime(2026, 11, 8, 10, 0), body="承知しました。\n\n差出人: 自分\n送信日時: 2026年11月7日\n昔の本文"))
        self.add(self.app.sent, CountingMail(long_id("e"), "RE: 見積のご連絡", "テスト 太郎", datetime(2026, 11, 7, 11, 0), body="見積を受け取りました。検討します。"))
        self.add(self.app.deleted, CountingMail(long_id("f"), "捨てたメール", "広告", datetime(2026, 11, 9, 9, 0)))

    @staticmethod
    def add(folder: FakeFolder, mail: FakeMail) -> FakeMail:
        mail.Parent = folder
        folder.Items._items.append(mail)
        return mail

    def offline(self, argv: list[str]) -> tuple[int, str, str]:
        """Outlook に接続したら失敗にする。"""
        def factory():
            raise AssertionError("Outlook に接続しました")

        out, err = io.StringIO(), io.StringIO()
        return cli.main(argv, client_factory=factory, stdout=out, stderr=err), out.getvalue(), err.getvalue()

    def test_取り込みは_受信トレイの下と送信済みで_期間の中だけ(self) -> None:
        code, out, _ = self.run_cli(["cache-sync"], self.app)
        self.assertEqual(code, 0)
        self.assertIn("新規 4 通 (受信 3 / 送信 1)", out)
        self.assertIn("キャッシュ: 4 通", out)
        _, listing, _ = self.offline(["cache-search", "--no-sync"])
        self.assertIn("受信 受信トレイ/案件A", listing)
        self.assertIn("送信 送信済みアイテム", listing)
        self.assertNotIn("夏の報告", listing)      # 90 日より前
        self.assertNotIn("捨てたメール", listing)  # 削除済みアイテムは取り込まない
        self.assertNotIn(long_id("a"), listing)    # 長い EntryID は出さない

    def test_2回目は新しい分だけを読む(self) -> None:
        self.run_cli(["cache-sync"], self.app)
        first = CountingMail.body_reads
        self.assertEqual(first, 4)
        _, out, _ = self.run_cli(["cache-sync"], self.app)
        self.assertIn("新規 0 通", out)
        self.assertEqual(CountingMail.body_reads, first)  # キャッシュにあるメールの本文は、読み直さない
        self.add(self.app.inbox, CountingMail(long_id("g"), "新着", "鈴木", datetime(2026, 11, 10, 8, 0), body="今朝のメール"))
        _, out, _ = self.run_cli(["cache-sync"], self.app)
        self.assertIn("新規 1 通 (受信 1 / 送信 0)", out)
        self.assertEqual(CountingMail.body_reads, first + 1)

    def test_期間を広げると_古いメールも取り込む(self) -> None:
        self.run_cli(["cache-sync"], self.app)
        _, out, _ = self.run_cli(["cache-sync", "--days", "365"], self.app)
        self.assertIn("新規 1 通", out)
        self.assertIn("直近 365 日", out)
        _, listing, _ = self.offline(["cache-search", "夏", "--no-sync"])
        self.assertIn("夏の報告", listing)
        _, status, _ = self.offline(["cache-status"])
        self.assertIn("直近 365 日", status)  # 以後も、広げた期間を使う

    def test_語_差出人_期間_フォルダで探せる(self) -> None:
        self.run_cli(["cache-sync"], self.app)
        _, out, _ = self.offline(["cache-search", "見積", "金額", "--no-sync"])
        self.assertIn("表示 1 件 / 該当 1 件", out)
        self.assertIn("120 万円", out)  # 抜粋
        self.assertIn("添付1", out)
        _, out, _ = self.offline(["cache-search", "abc", "--no-sync"])  # 全角・半角、大文字・小文字を区別しない
        self.assertIn("会議の日程", out)
        _, out, _ = self.offline(["cache-search", "--from", "山田", "--since", "2026-11-07", "--no-sync"])
        self.assertIn("表示 1 件", out)
        self.assertIn("案件A", out)
        _, out, _ = self.offline(["cache-search", "--folder", "sent", "--no-sync"])
        self.assertIn("表示 1 件", out)
        self.assertIn("テスト 太郎 → me@example.com", out)
        _, out, _ = self.offline(["cache-search", "--until", "2026-11-05", "--no-sync"])
        self.assertIn("会議の日程", out)
        self.assertNotIn("見積のご連絡", out)
        _, out, _ = self.offline(["cache-search", "100%", "--no-sync"])  # % は、そのままの文字として探す
        self.assertIn("見つかりませんでした", out)

    def test_件数が多いときは_残りを知らせる(self) -> None:
        self.run_cli(["cache-sync"], self.app)
        _, out, _ = self.offline(["cache-search", "--limit", "2", "--no-sync"])
        self.assertIn("表示 2 件 / 該当 4 件", out)
        self.assertIn("残り 2 件", out)

    def test_同じ件のやり取りを_受信も送信も古い順に出す(self) -> None:
        self.run_cli(["cache-sync"], self.app)
        _, listing, _ = self.offline(["cache-search", "金額", "--no-sync"])
        alias = re.search(r"\] (m[0-9a-f]{6}) ", listing).group(1)
        code, out, _ = self.offline(["cache-search", "--thread", alias, "--no-sync"])
        self.assertEqual(code, 0)
        rows = [l for l in out.splitlines() if l.startswith("[")]
        self.assertEqual(len(rows), 3)
        self.assertIn("2026-11-06", rows[0])
        self.assertIn("送信", rows[1])
        self.assertIn("2026-11-08", rows[2])
        code, _, err = self.offline(["cache-search", "--thread", "mzzzzzz", "--no-sync"])
        self.assertEqual(code, 2)

    def test_検索は_先に差分を取り込む_新しければ接続しない(self) -> None:
        code, out, _ = self.run_cli(["cache-search", "見積"], self.app)  # 取り込みをしていなくても、探せる
        self.assertEqual(code, 0)
        self.assertIn("取り込み (差分): 新規 4 通", out)
        self.assertIn("見積のご連絡", out)
        code, out, _ = self.offline(["cache-search", "見積"])  # 直前に取り込んだので、接続しない
        self.assertEqual(code, 0)
        self.assertNotIn("取り込み", out.splitlines()[0])

    def test_Outlookにつながらなくても_キャッシュで答える(self) -> None:
        self.run_cli(["cache-sync"], self.app)

        @contextmanager
        def broken():
            raise RuntimeError("Outlook に接続できません")
            yield  # pragma: no cover

        out, err = io.StringIO(), io.StringIO()
        with patch.object(cli, "now", lambda: datetime(2026, 11, 11, 9, 0)):  # 翌日。キャッシュは古い
            code = cli.main(["cache-search", "見積"], client_factory=broken, stdout=out, stderr=err)
        self.assertEqual(code, 0)
        self.assertIn("注意: Outlook から最新を取り込めませんでした", out.getvalue())
        self.assertIn("最終の取り込み: 2026-11-10 09:00", out.getvalue())
        self.assertIn("見積のご連絡", out.getvalue())

    def test_本文は_複数をまとめて_接続せずに読める(self) -> None:
        self.run_cli(["cache-sync"], self.app)
        _, listing, _ = self.offline(["cache-search", "見積", "--no-sync"])
        aliases = re.findall(r"\] (m[0-9a-f]{6}) ", listing)
        self.assertEqual(len(aliases), 3)
        code, out, _ = self.offline(["cache-show", *aliases, "--no-quote"])
        self.assertEqual(code, 0)
        self.assertEqual(out.count("件名: "), 3)
        self.assertIn("金額は 120 万円です。", out)
        self.assertIn("承知しました。", out)
        self.assertNotIn("昔の本文", out)  # 引用を省いた
        self.assertIn("添付: 1 件", out)
        code, out, _ = self.offline(["cache-show", aliases[0], "mzzzzzz"])
        self.assertEqual(code, 1)
        self.assertIn("キャッシュにありません", out)
        code, _, err = self.offline(["cache-show", *["m000000"] * (cli.SHOW_LIMIT + 1)])
        self.assertEqual(code, 2)

    def test_検索で出たIDで_返信の下書きを作れる(self) -> None:
        _, listing, _ = self.run_cli(["cache-search", "金額"], self.app)
        alias = re.search(r"\] (m[0-9a-f]{6}) ", listing).group(1)
        body_file = self.tmp / "reply.md"
        body_file.write_text("承知しました。", encoding="utf-8")
        code, out, _ = self.run_cli(["reply-draft", alias, "--body-file", str(body_file)], self.app)
        self.assertEqual(code, 0)
        self.assertIn("送信はしていません", out)

    def test_移動すると_キャッシュのIDと場所も変わる(self) -> None:
        _, listing, _ = self.run_cli(["cache-search", "会議"], self.app)
        alias = re.search(r"\] (m[0-9a-f]{6}) ", listing).group(1)
        _, moved, _ = self.run_cli(["mail-move", alias, "--to", "案件A"], self.app)
        new_id = re.search(r"新ID (m[0-9a-f]{6})", moved).group(1)
        _, listing, _ = self.offline(["cache-search", "会議", "--no-sync"])
        self.assertIn(new_id, listing)
        self.assertNotIn(alias, listing)
        self.assertIn("受信トレイ/案件A", listing)
        _, undone, _ = self.run_cli(["mail-undo", new_id], self.app)
        back_id = re.search(r"新ID (m[0-9a-f]{6})", undone).group(1)
        code, out, _ = self.offline(["cache-show", back_id])
        self.assertEqual(code, 0)
        self.assertIn("フォルダ: 受信 受信トレイ\n", out)
        _, out, _ = self.run_cli(["cache-sync", "--full"], self.app)  # 取り直しても、増えも減りもしない
        self.assertIn("新規 0 通", out)
        self.assertIn("キャッシュ: 4 通", out)

    def test_全体の取り直しで_Outlookで動かした_消したメールが合う(self) -> None:
        self.run_cli(["cache-sync"], self.app)
        estimate = [m for m in self.app.inbox.Items if m.Subject == "見積のご連絡"][0]
        estimate.Move([f for f in self.app.inbox.Folders][0])  # 人が Outlook で移動した (ID が変わる)
        meeting = [m for m in self.app.inbox.Items if m.Subject == "会議の日程"][0]
        self.app.inbox.Items._items.remove(meeting)  # 人が Outlook で削除した
        _, out, _ = self.run_cli(["cache-sync", "--full"], self.app)
        self.assertIn("全体の取り直し", out)
        self.assertIn("キャッシュ: 3 通", out)
        _, listing, _ = self.offline(["cache-search", "--no-sync"])
        self.assertEqual(listing.count("| 添付1 見積のご連絡"), 1)  # 同じメールが 2 つにならない
        self.assertRegex(listing, r"受信トレイ/案件A \| 山田 \| 添付1 見積のご連絡")  # 移動先の場所になっている
        self.assertNotIn("会議の日程", listing)

    def test_時間切れで止まっても_次回に続きを取り込む(self) -> None:
        ticks = iter(range(1000))
        with cache.CacheStore() as store:
            client = oc.OutlookClient(self.app)
            result = cache.sync(client, store, max_seconds=2, now=NOW, clock=lambda: next(ticks))
            self.assertTrue(result["timed_out"])
            self.assertEqual(result["added"]["inbox"], 2)
            self.assertIsNone(store.last_sync())  # 途中なので、取り込み済みにしない
            self.assertIn("途中", cli.format_sync(result))
            result = cache.sync(client, store, now=NOW)
            self.assertFalse(result["timed_out"])
            self.assertEqual(result["added"], {"inbox": 1, "sent": 1})
            self.assertEqual(store.status()["count"], 4)

    def test_長い本文は切って_印を付ける(self) -> None:
        self.add(self.app.inbox, CountingMail(long_id("h"), "長文", "田中", datetime(2026, 11, 9, 12, 0), body="あ" * (cache.BODY_MAX_CHARS + 50)))
        _, listing, _ = self.run_cli(["cache-search", "長文"], self.app)
        alias = re.search(r"\] (m[0-9a-f]{6}) ", listing).group(1)
        _, out, _ = self.offline(["cache-show", alias, "--max-chars", "10"])
        self.assertIn(f"10 / 全 {cache.BODY_MAX_CHARS} 文字", out)
        self.assertIn(f"mail-get {alias}", out)

    def test_キャッシュの場所は_作業フォルダの外(self) -> None:
        with patch.dict(os.environ, {"LOCALAPPDATA": r"C:\Users\u\AppData\Local"}):
            os.environ.pop("OPENCODE_OUTLOOK_MAILCACHE")
            self.assertEqual(cache.cache_db_path().name, "outlook-mail-cache.sqlite3")
            self.assertIn("opencode-harness", str(cache.cache_db_path()))


# ---------------------------------------------------------------------------
# 出力ファイル / 接続確認 / 変換
# ---------------------------------------------------------------------------

class OutputTests(OutlookTestCase):
    def in_tmp(self):
        """--out は、作業フォルダ直下の .handoff を基準にするので、一時フォルダを作業フォルダにする。"""
        previous = os.getcwd()
        os.chdir(self.tmp)
        self.addCleanup(os.chdir, previous)

    def test_outは_handoffの中だけ_上書きしない(self) -> None:
        self.in_tmp()
        target = self.tmp / ".handoff" / "outlook_一覧.md"
        code, out, _ = self.run_cli(["mail-list", "--out", str(target)])
        self.assertEqual(code, 0)
        self.assertTrue(target.exists())
        self.assertIn("見積のご連絡", target.read_text(encoding="utf-8"))
        self.assertIn("出力:", out)
        self.assertNotIn("見積のご連絡", out)  # 画面には要約だけ
        code, _, err = self.run_cli(["mail-list", "--out", str(target)])
        self.assertEqual(code, 2)
        self.assertIn("すでにあります", err)

    def test_handoff以外への出力は拒否(self) -> None:
        self.in_tmp()
        code, _, err = self.run_cli(["mail-list", "--out", str(self.tmp / "other.md")])
        self.assertEqual(code, 2)
        self.assertIn(".handoff", err)

    def test_handoffを含んでも_外へ出る出力は拒否(self) -> None:
        # メールの本文は外から届く文章。`.handoff/../..` で、作業フォルダの外に置けてはいけない (以前は通っていた)
        self.in_tmp()
        for escape in (".handoff/../../escaped.md", ".handoff/../escaped.md", str(self.tmp / "other" / ".handoff" / "x.md"), ".handoff/.."):
            code, _, err = self.run_cli(["mail-list", "--out", escape])
            self.assertEqual(code, 2, escape)
            self.assertIn(".handoff", err)
        self.assertFalse((self.tmp.parent / "escaped.md").exists())
        self.assertFalse((self.tmp / "escaped.md").exists())

    def test_checkで接続を確認できる(self) -> None:
        code, out, _ = self.run_cli(["check"])
        self.assertEqual(code, 0)
        self.assertIn("接続OK", out)
        self.assertIn("受信トレイ 3 件", out)

    def test_Outlookに接続できないときは分かるエラー(self) -> None:
        @contextmanager
        def factory():
            raise RuntimeError("Outlook に接続できません")
            yield  # pragma: no cover

        out, err = io.StringIO(), io.StringIO()
        code = cli.main(["check"], client_factory=factory, stdout=out, stderr=err)
        self.assertEqual(code, 3)
        self.assertIn("接続できません", err.getvalue())


class ConversionTests(unittest.TestCase):
    def test_htmlからテキスト(self) -> None:
        self.assertEqual(oc.html_to_text("<div>A<br>B</div><p>C</p>"), "A\nB\nC")

    def test_日付だけのuntilはその日を含む(self) -> None:
        self.assertEqual(cli.parse_when("2026-11-05", upper_bound=True), datetime(2026, 11, 6))
        self.assertEqual(cli.parse_when("2026-11-05 10:00", upper_bound=True), datetime(2026, 11, 5, 10, 0))

    def test_タイムゾーン付きの日時は時計の値のまま(self) -> None:
        from datetime import timezone

        aware = datetime(2026, 11, 6, 9, 0, tzinfo=timezone.utc)
        self.assertEqual(oc.naive(aware), datetime(2026, 11, 6, 9, 0))


if __name__ == "__main__":
    unittest.main()
