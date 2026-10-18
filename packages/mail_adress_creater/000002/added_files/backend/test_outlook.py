"""Outlook COM接続まわりのテスト（pywin32はモックする）。"""
from __future__ import annotations

import sys
import tempfile
import types
import unittest
from typing import Any
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from backend import config, db, outlook, services
from backend.testing import FakeAppointment, FakeOutlook


def fake_client(ensure_dispatch: MagicMock, dispatch: MagicMock) -> SimpleNamespace:
    return SimpleNamespace(gencache=SimpleNamespace(EnsureDispatch=ensure_dispatch), Dispatch=dispatch)


class OutlookApplicationTest(unittest.TestCase):
    def test_returns_early_when_ensure_dispatch_works(self) -> None:
        app = object()
        ensure, dispatch = MagicMock(return_value=app), MagicMock()

        with patch.object(outlook, "_import_win32com_client", return_value=fake_client(ensure, dispatch)):
            self.assertIs(outlook.outlook_application(), app)

        ensure.assert_called_once_with("Outlook.Application")
        dispatch.assert_not_called()

    def test_clears_cache_and_retries_when_first_attempt_fails(self) -> None:
        app = object()
        ensure = MagicMock(side_effect=[RuntimeError("stale gen_py"), app])

        with (
            patch.object(outlook, "_import_win32com_client", return_value=fake_client(ensure, MagicMock())),
            patch.object(outlook, "clear_outlook_gen_py_cache") as clear,
            self.assertLogs(config.LOGGER, level="WARNING"),
        ):
            self.assertIs(outlook.outlook_application(), app)

        clear.assert_called_once()
        self.assertEqual(ensure.call_count, 2)

    def test_falls_back_to_plain_dispatch_after_two_failures(self) -> None:
        app = object()
        ensure = MagicMock(side_effect=RuntimeError("broken"))
        dispatch = MagicMock(return_value=app)

        with (
            patch.object(outlook, "_import_win32com_client", return_value=fake_client(ensure, dispatch)),
            patch.object(outlook, "clear_outlook_gen_py_cache"),
            self.assertLogs(config.LOGGER, level="WARNING"),
        ):
            self.assertIs(outlook.outlook_application(), app)

    def test_reports_actionable_error_when_every_strategy_fails(self) -> None:
        ensure = MagicMock(side_effect=RuntimeError("broken"))
        dispatch = MagicMock(side_effect=RuntimeError("not registered"))

        with (
            patch.object(outlook, "_import_win32com_client", return_value=fake_client(ensure, dispatch)),
            patch.object(outlook, "clear_outlook_gen_py_cache"),
            self.assertLogs(config.LOGGER, level="WARNING"),self.assertRaises(RuntimeError) as context
        ):
            outlook.outlook_application()

        self.assertIn("クラシック版Outlook", str(context.exception))

    def test_missing_pywin32_is_reported_without_traceback_noise(self) -> None:
        with (
            patch.dict("sys.modules", {"win32com": None, "win32com.client": None}),
            self.assertLogs(config.LOGGER, level="WARNING") as logs,
            self.assertRaises(RuntimeError) as context,
        ):
            outlook.outlook_application()

        self.assertIn("pywin32", str(context.exception))
        self.assertFalse(any(record.exc_info for record in logs.records))


class GenPyCacheDirTest(unittest.TestCase):
    def test_is_none_when_temp_is_not_set(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            self.assertIsNone(outlook.gen_py_cache_dir())


def add_schedule_with_body(body: str, appointment: FakeAppointment) -> None:
    with (
        patch.object(outlook, "outlook_com_context"),
        patch.object(outlook, "outlook_application", return_value=FakeOutlook(appointment)),
        patch.object(db, "record_job_run"),
    ):
        services.add_schedule({
            "event": {
                "start": "2026-05-21T10:15",
                "end": "2026-05-21T11:45",
                "subject": "会議",
                "location": "",
                "body": body,
                "all_day": False,
            },
        })


class LooksLikeHtmlTest(unittest.TestCase):
    def test_detects_any_html_tag(self) -> None:
        for body in ("<p>x</p>", "foo<br>bar", "foo <b>bar</b> baz", "<br/>", "a<A HREF='x'>b</A>"):
            with self.subTest(body=body):
                self.assertTrue(outlook.looks_like_html(body))

    def test_plain_text_and_escaped_entities_are_not_html(self) -> None:
        for body in ("", "plain", "A &amp; B", "1 &lt; 2 &gt; 0", "a < b and c > d", "3<4"):
            with self.subTest(body=body):
                self.assertFalse(outlook.looks_like_html(body))


class HtmlToTextTest(unittest.TestCase):
    def test_converts_block_tags_and_br_to_newlines(self) -> None:
        text = outlook.html_to_text("<div>一行目</div><div>二行目<br>三行目</div><p>四 &amp; 五</p>")
        self.assertEqual(text, "一行目\n二行目\n三行目\n四 & 五")

    def test_drops_script_and_style_content(self) -> None:
        self.assertEqual(outlook.html_to_text("<style>p{}</style><p>本文</p><script>x()</script>"), "本文")


class AddScheduleBodyTest(unittest.TestCase):
    def test_inline_br_body_is_imported_as_html(self) -> None:
        appointment = FakeAppointment()

        add_schedule_with_body("1行目<br>2行目", appointment)

        self.assertEqual(appointment.GetInspector.WordEditor.Range().inserted_content, "1行目<br>2行目")

    def test_html_body_with_link_is_imported_as_is_and_saved(self) -> None:
        appointment = FakeAppointment()
        html_body = "<p>議題を確認する <a href='http://example.com'>リンク</a></p>"

        add_schedule_with_body(html_body, appointment)

        self.assertEqual(appointment.GetInspector.WordEditor.Range().inserted_content, html_body)
        self.assertTrue(appointment.saved)

    def test_plain_body_with_entities_is_unescaped(self) -> None:
        appointment = FakeAppointment()

        add_schedule_with_body("A &amp; B &lt;C&gt;", appointment)

        self.assertEqual(appointment.Body, "A & B <C>")
        self.assertIsNone(appointment.GetInspector.WordEditor.Range().inserted_content)

    def test_html_import_failure_falls_back_to_readable_text(self) -> None:
        appointment = FakeAppointment()
        appointment.GetInspector = None  # type: ignore[assignment]

        with self.assertLogs(config.LOGGER, level="WARNING"):
            add_schedule_with_body("<div>議題</div><div>確認 &amp; 共有</div>", appointment)

        self.assertEqual(appointment.Body, "議題\n確認 & 共有")
        self.assertTrue(appointment.saved)


class OutlookIntegrationTest(unittest.TestCase):
    def add_schedule(self, payload: dict[str, Any]) -> tuple[dict[str, Any], FakeAppointment, FakeOutlook]:
        appointment = FakeAppointment()
        fake_outlook = FakeOutlook(appointment)
        with (
            patch.object(outlook, "outlook_com_context"),
            patch.object(outlook, "outlook_application", return_value=fake_outlook),
            patch.object(db, "record_job_run"),
        ):
            return services.add_schedule(payload), appointment, fake_outlook

    def test_add_schedule_saves_outlook_appointment(self) -> None:
        result, appointment, fake_outlook = self.add_schedule({"text": "2026/5/20 15:00から16:30 調整会議"})

        self.assertTrue(result["saved"])
        self.assertTrue(appointment.saved)
        self.assertEqual(fake_outlook.item_type, 1)
        self.assertEqual(appointment.Subject, "調整会議")
        self.assertEqual(appointment.Start, "2026/05/20 15:00:00")
        self.assertEqual(appointment.Duration, 90)

    def test_add_schedule_sets_reminder_and_busy_status(self) -> None:
        _, appointment, _ = self.add_schedule({"text": "2026/5/20 15:00から16:30 調整会議"})

        self.assertTrue(appointment.ReminderSet)
        self.assertEqual(appointment.ReminderMinutesBeforeStart, 5)
        self.assertEqual(appointment.BusyStatus, 2)
        self.assertFalse(appointment.AllDayEvent)

    def test_add_schedule_marks_all_day_events(self) -> None:
        _, appointment, _ = self.add_schedule({"text": "2026/5/20 研修"})

        self.assertTrue(appointment.AllDayEvent)

    def test_add_schedule_uses_edited_event_payload(self) -> None:
        result, appointment, _ = self.add_schedule({
            "text": "今週の水曜日 調整会議",
            "event": {
                "start": "2026-05-21T10:15",
                "end": "2026-05-21T11:45",
                "subject": "編集後会議",
                "location": "第1会議室",
                "body": "議題を確認する",
                "all_day": False,
                "normalized_text": "今週の水曜日 調整会議",
            },
        })

        self.assertEqual(result["event"]["subject"], "編集後会議")
        self.assertEqual(appointment.Subject, "編集後会議")
        self.assertEqual(appointment.Location, "第1会議室")
        self.assertEqual(appointment.Body, "議題を確認する")
        self.assertEqual(appointment.Start, "2026/05/21 10:15:00")
        self.assertEqual(appointment.Duration, 90)

    def test_outlook_com_context_initializes_and_uninitializes_com(self) -> None:
        calls: list[str] = []
        fake_pythoncom = types.SimpleNamespace(
            CoInitialize=lambda: calls.append("init"),
            CoUninitialize=lambda: calls.append("uninit"),
        )

        with patch.dict(sys.modules, {"pythoncom": fake_pythoncom}), outlook.outlook_com_context():
            calls.append("body")

        self.assertEqual(calls, ["init", "body", "uninit"])


    def test_find_keyword_matches_exclude_logic(self) -> None:
        """
        職アドのキーワード除外機能（マイナスキーワード指定）の判定ロジックをテストする。
        - 肯定キーワードが本文行に含まれ、かつ件名・該当行に除外キーワードが無い場合にヒットすること。
        - 件名に除外キーワードが含まれている場合、本文の該当行に肯定キーワードが含まれていても除外されること。
        - 本文の該当行に除外キーワードが含まれている場合、肯定キーワードが含まれていても除外されること。
        """
        class FakeMessage:
            def __init__(self, subject: str, body: str, received_time: str) -> None:
                self.Subject = subject
                self.Body = body
                self.ReceivedTime = received_time

        class FakeItems:
            def __init__(self, messages: list[FakeMessage]) -> None:
                self.messages = messages

            def Sort(self, key: str, descending: bool) -> None:
                pass

            def __iter__(self):
                return iter(self.messages)

        class FakeFolder:
            def __init__(self, items: FakeItems) -> None:
                self.Items = items

        class FakeNamespace:
            def __init__(self, folder: FakeFolder) -> None:
                self.folder = folder

            def GetDefaultFolder(self, index: int) -> FakeFolder:
                return self.folder

        # モックメッセージの準備
        msg1 = FakeMessage(
            subject="職アドからのお知らせ: RPA通知",
            body="RPAの実行結果を報告します。\nRPAG受付の準備が完了しました。",
            received_time="2026-05-26T10:00:00+09:00"
        )
        msg2 = FakeMessage(
            subject="職アドからのお知らせ: RPAG受付開始",
            body="RPAの処理を開始します。",
            received_time="2026-05-26T11:00:00+09:00"
        )
        msg3 = FakeMessage(
            subject="職アドからのお知らせ: 通常処理",
            body="RPAの処理が完了しました。\n別の処理も問題ありませんでした。",
            received_time="2026-05-26T12:00:00+09:00"
        )

        fake_namespace = FakeNamespace(FakeFolder(FakeItems([msg1, msg2, msg3])))

        with (
            patch.object(outlook, "outlook_com_context"),
            patch.object(outlook, "outlook_namespace", return_value=fake_namespace),
            patch.object(outlook, "message_received_time", side_effect=lambda m: m.ReceivedTime),
        ):
            # 1. 半角マイナス "-" での検証
            matches = outlook.find_keyword_matches(["RPA", "-RPAG受付"])
            lines = [m.line for m in matches]
            self.assertEqual(len(matches), 2)
            self.assertIn("RPAの実行結果を報告します。", lines)
            self.assertIn("RPAの処理が完了しました。", lines)
            self.assertNotIn("RPAG受付の準備が完了しました。", lines)
            self.assertNotIn("RPAの処理を開始します。", lines)

            # 2. 表記ゆれ（全角マイナス「－」）での検証
            matches_zen = outlook.find_keyword_matches(["RPA", "－RPAG受付"])
            lines_zen = [m.line for m in matches_zen]
            self.assertEqual(len(matches_zen), 2)
            self.assertIn("RPAの実行結果を報告します。", lines_zen)
            self.assertNotIn("RPAG受付の準備が完了しました。", lines_zen)

            # 3. 表記ゆれ（全角ハイフン/長音「ー」）での検証
            matches_cho = outlook.find_keyword_matches(["RPA", "ーRPAG受付"])
            lines_cho = [m.line for m in matches_cho]
            self.assertEqual(len(matches_cho), 2)
            self.assertIn("RPAの実行結果を報告します。", lines_cho)
            self.assertNotIn("RPAG受付の準備が完了しました。", lines_cho)


    def test_clear_outlook_gen_py_cache_removes_disk_and_sys_modules(self) -> None:
        """clear_outlook_gen_py_cache が、ディスクと sys.modules の両方のキャッシュを消去することを確認する"""
        import sys

        # 1. sys.modules のモック登録
        sys.modules["win32com.dummy_module"] = types.ModuleType("dummy")
        sys.modules["win32com.gen_py.dummy_sub"] = types.ModuleType("dummy_sub")

        # 2. ディスク上のキャッシュディレクトリのシミュレーション
        with tempfile.TemporaryDirectory() as tmp_temp_dir:
            temp_path = Path(tmp_temp_dir)
            gen_py_dir = temp_path / "gen_py" / f"{sys.version_info.major}.{sys.version_info.minor}"
            cache_folder = gen_py_dir / "000000000046_dummy"
            cache_folder.mkdir(parents=True)

            # ダミーファイルの作成
            dummy_file = cache_folder / "test.txt"
            dummy_file.write_text("dummy", encoding="utf-8")

            # 環境変数 TEMP をモックディレクトリに向ける
            with patch.dict("os.environ", {"TEMP": str(tmp_temp_dir)}):
                outlook.clear_outlook_gen_py_cache()

            # フォルダが削除されたことを検証
            self.assertFalse(cache_folder.exists())

        # 3. sys.modules から削除されたことを検証
        self.assertNotIn("win32com.dummy_module", sys.modules)
        self.assertNotIn("win32com.gen_py.dummy_sub", sys.modules)


if __name__ == "__main__":
    unittest.main()
