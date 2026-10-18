"""自然文の予定解析（event_parser）のテスト。"""
from __future__ import annotations

import unittest
from typing import Any
from datetime import datetime
from zoneinfo import ZoneInfo

from backend.event_parser import parse_event_text


class EventParserTest(unittest.TestCase):
    def test_prefers_explicit_date_over_subject_keywords(self) -> None:
        base = datetime(2026, 7, 14, 9, 0, tzinfo=ZoneInfo("Asia/Tokyo"))

        event = parse_event_text(
            "2026年7月14日 15:00〜17:00 今日から始めるxxx( 7/17)", base
        )

        self.assertEqual(event.start.isoformat(timespec="minutes"), "2026-07-14T15:00+09:00")
        self.assertEqual(event.end.isoformat(timespec="minutes"), "2026-07-14T17:00+09:00")
        self.assertEqual(event.subject, "今日から始めるxxx( 7/17)")
        self.assertFalse(event.all_day)

    def test_extracts_weekday_time_range(self) -> None:
        base = datetime(2026, 5, 18, 9, 0, tzinfo=ZoneInfo("Asia/Tokyo"))

        event = parse_event_text("今週の水曜日 １５：００から１６：３０ 調整会議", base)

        self.assertEqual(event.start.isoformat(timespec="minutes"), "2026-05-20T15:00+09:00")
        self.assertEqual(event.end.isoformat(timespec="minutes"), "2026-05-20T16:30+09:00")
        self.assertEqual(event.duration_minutes, 90)
        self.assertEqual(event.subject, "調整会議")
        self.assertFalse(event.all_day)

    def test_extracts_spaces_around_colon(self) -> None:
        base = datetime(2026, 5, 18, 9, 0, tzinfo=ZoneInfo("Asia/Tokyo"))

        event = parse_event_text("2026年 5 月 28 日 (木)  15 : 00 〜 16 : 00 会議 @ aa", base)

        self.assertEqual(event.start.isoformat(timespec="minutes"), "2026-05-28T15:00+09:00")
        self.assertEqual(event.end.isoformat(timespec="minutes"), "2026-05-28T16:00+09:00")
        self.assertEqual(event.duration_minutes, 60)
        self.assertEqual(event.subject, "会議")
        self.assertEqual(event.location, "aa")
        self.assertFalse(event.all_day)

    def test_comprehensive_patterns(self) -> None:
        base = datetime(2026, 5, 18, 9, 0, tzinfo=ZoneInfo("Asia/Tokyo"))

        cases: list[dict[str, Any]] = [
            {
                "input": "5 / 28 15:00-16:00 会議",
                "start": "2026-05-28T15:00+09:00",
                "end": "2026-05-28T16:00+09:00",
                "duration": 60,
                "subject": "会議",
                "location": "",
                "all_day": False,
            },
            {
                "input": "2026.5.28 15:00 会議",
                "start": "2026-05-28T15:00+09:00",
                "end": "2026-05-28T16:00+09:00",
                "duration": 60,
                "subject": "会議",
                "location": "",
                "all_day": False,
            },
            {
                "input": "２０２６年５月２８日 １５：００から１６：００ 会議",
                "start": "2026-05-28T15:00+09:00",
                "end": "2026-05-28T16:00+09:00",
                "duration": 60,
                "subject": "会議",
                "location": "",
                "all_day": False,
            },
            {
                "input": "5/28木 15:00 会議",
                "start": "2026-05-28T15:00+09:00",
                "end": "2026-05-28T16:00+09:00",
                "duration": 60,
                "subject": "会議",
                "location": "",
                "all_day": False,
            },
            {
                "input": "来週木曜日 15:00 会議",
                "start": "2026-05-28T15:00+09:00",
                "end": "2026-05-28T16:00+09:00",
                "duration": 60,
                "subject": "会議",
                "location": "",
                "all_day": False,
            },
            {
                "input": "あした 15:00 定例",
                "start": "2026-05-19T15:00+09:00",
                "end": "2026-05-19T16:00+09:00",
                "duration": 60,
                "subject": "定例",
                "location": "",
                "all_day": False,
            },
            {
                "input": "5/28 １５　：　３０ 会議",
                "start": "2026-05-28T15:30+09:00",
                "end": "2026-05-28T16:30+09:00",
                "duration": 60,
                "subject": "会議",
                "location": "",
                "all_day": False,
            },
            {
                "input": "5/28 15時30分 会議",
                "start": "2026-05-28T15:30+09:00",
                "end": "2026-05-28T16:30+09:00",
                "duration": 60,
                "subject": "会議",
                "location": "",
                "all_day": False,
            },
            {
                "input": "5/28 15時半 会議",
                "start": "2026-05-28T15:30+09:00",
                "end": "2026-05-28T16:30+09:00",
                "duration": 60,
                "subject": "会議",
                "location": "",
                "all_day": False,
            },
            {
                "input": "5/28 15 時 30 分 会議",
                "start": "2026-05-28T15:30+09:00",
                "end": "2026-05-28T16:30+09:00",
                "duration": 60,
                "subject": "会議",
                "location": "",
                "all_day": False,
            },
            {
                "input": "5/28 午後 3:00 会議",
                "start": "2026-05-28T15:00+09:00",
                "end": "2026-05-28T16:00+09:00",
                "duration": 60,
                "subject": "会議",
                "location": "",
                "all_day": False,
            },
            {
                "input": "5/28 夕方 5 時 会議",
                "start": "2026-05-28T17:00+09:00",
                "end": "2026-05-28T18:00+09:00",
                "duration": 60,
                "subject": "会議",
                "location": "",
                "all_day": False,
            },
            {
                "input": "5/28 夜 8:30 会議",
                "start": "2026-05-28T20:30+09:00",
                "end": "2026-05-28T21:30+09:00",
                "duration": 60,
                "subject": "会議",
                "location": "",
                "all_day": False,
            },
            {
                "input": "5/28 正午 会議",
                "start": "2026-05-28T12:00+09:00",
                "end": "2026-05-28T13:00+09:00",
                "duration": 60,
                "subject": "会議",
                "location": "",
                "all_day": False,
            },
            {
                "input": "5/28 15:00 会議 @ 会議室A",
                "start": "2026-05-28T15:00+09:00",
                "end": "2026-05-28T16:00+09:00",
                "duration": 60,
                "subject": "会議",
                "location": "会議室A",
                "all_day": False,
            },
            {
                "input": "5/28 15:00 於 会議室B 会議",
                "start": "2026-05-28T15:00+09:00",
                "end": "2026-05-28T16:00+09:00",
                "duration": 60,
                "subject": "会議",
                "location": "会議室B",
                "all_day": False,
            },
            {
                "input": "5/28 15:00 会議 会場： オンライン",
                "start": "2026-05-28T15:00+09:00",
                "end": "2026-05-28T16:00+09:00",
                "duration": 60,
                "subject": "会議",
                "location": "オンライン",
                "all_day": False,
            },
            {
                "input": "5/28 15:00 【定例】進捗確認会議 @ 会議室1",
                "start": "2026-05-28T15:00+09:00",
                "end": "2026-05-28T16:00+09:00",
                "duration": 60,
                "subject": "【定例】進捗確認会議",
                "location": "会議室1",
                "all_day": False,
            },
        ]

        for i, c in enumerate(cases):
            with self.subTest(i=i, text=c["input"]):
                event = parse_event_text(c["input"], base)
                self.assertEqual(event.start.isoformat(timespec="minutes"), c["start"])
                self.assertEqual(event.end.isoformat(timespec="minutes"), c["end"])
                self.assertEqual(event.duration_minutes, c["duration"])
                self.assertEqual(event.subject, c["subject"])
                self.assertEqual(event.location, c["location"])
                self.assertEqual(event.all_day, c["all_day"])

    def test_extracts_slash_date_hyphen_time_range(self) -> None:
        base = datetime(2026, 5, 18, 9, 0, tzinfo=ZoneInfo("Asia/Tokyo"))

        event = parse_event_text("5/20 14:00ー15:00 会議", base)

        self.assertEqual(event.start.isoformat(timespec="minutes"), "2026-05-20T14:00+09:00")
        self.assertEqual(event.end.isoformat(timespec="minutes"), "2026-05-20T15:00+09:00")
        self.assertEqual(event.duration_minutes, 60)
        self.assertEqual(event.subject, "会議")
        self.assertFalse(event.all_day)

    def test_supports_various_time_range_delimiters(self) -> None:
        base = datetime(2026, 5, 18, 9, 0, tzinfo=ZoneInfo("Asia/Tokyo"))

        patterns = [
            "13:00-15:00 会議",
            "13:00 - 15:00 会議",
            "13:00ー15:00 会議",
            "13:00 ー 15:00 会議",
            "13:00―15:00 会議",
            "13:00 ― 15:00 会議",
            "13:00to15:00 会議",
            "13:00 to 15:00 会議",
            "13:00TO15:00 会議",
            "13:00 TO 15:00 会議",
            "13:00To15:00 会議",
            "13:00 To 15:00 会議",
            "13:00～15:00 会議",
            "13:00 ～ 15:00 会議",
            "13:00〜15:00 会議",
            "13:00 〜 15:00 会議",
            "１３：００－１５：００ 会議",
            "１３：００ー１５：００ 会議",
            "１３：００―１５：００ 会議",
            "１３：００ｔｏ１５：００ 会議",
            "１３：００ ＴＯ １５：００ 会議",
            "１３：００～１５：００ 会議",
            "13時ー15時 会議",
            "13時―15時 会議",
            "13時to15時 会議",
            "13時 TO 15時 会議",
            "13時～15時 会議",
            "13時-15時 会議",
            "13:00　to　15:00 会議",
            "13:00　ー　15:00 会議",
            "13:00　～　15:00 会議",
            "午後1:00-午後3:00 会議",
            "午後1:00to午後3:00 会議",
            "午後1:00ー午後3:00 会議",
            "午後1:00～午後3:00 会議",
            "午後1:00 - 3:00 会議",
            "午後1:00 to 3:00 会議",
            "午後1:00 ー 3:00 会議",
            "午後1:00 ～ 3:00 会議",
        ]

        for text in patterns:
            with self.subTest(text=text):
                event = parse_event_text(text, base)
                self.assertEqual(event.start.isoformat(timespec="minutes"), "2026-05-18T13:00+09:00")
                self.assertEqual(event.end.isoformat(timespec="minutes"), "2026-05-18T15:00+09:00")
                self.assertEqual(event.duration_minutes, 120)
                self.assertEqual(event.subject, "会議")
                self.assertFalse(event.all_day)

        date_patterns = [
            "5/20 13:00-15:00 会議",
            "5/20 13:00ー15:00 会議",
            "5/20 13:00―15:00 会議",
            "5/20 13:00to15:00 会議",
            "5/20 13:00 TO 15:00 会議",
            "5/20 13:00～15:00 会議",
            "5/20 13:00〜15:00 会議",
        ]
        for text in date_patterns:
            with self.subTest(text=text):
                event = parse_event_text(text, base)
                self.assertEqual(event.start.isoformat(timespec="minutes"), "2026-05-20T13:00+09:00")
                self.assertEqual(event.end.isoformat(timespec="minutes"), "2026-05-20T15:00+09:00")
                self.assertEqual(event.duration_minutes, 120)
                self.assertEqual(event.subject, "会議")
                self.assertFalse(event.all_day)

    def test_preserves_katakana_chouon_in_subject(self) -> None:
        base = datetime(2026, 5, 18, 9, 0, tzinfo=ZoneInfo("Asia/Tokyo"))
        cases = [
            ("13:00-15:00 セミナー", "セミナー"),
            ("13:00to15:00 ユーザーミーティング", "ユーザーミーティング"),
            ("13:00ー15:00 リーダー会議", "リーダー会議"),
        ]
        for text, expected_subject in cases:
            with self.subTest(text=text):
                event = parse_event_text(text, base)
                self.assertEqual(event.subject, expected_subject)
                self.assertEqual(event.start.isoformat(timespec="minutes"), "2026-05-18T13:00+09:00")
                self.assertEqual(event.end.isoformat(timespec="minutes"), "2026-05-18T15:00+09:00")

    def test_uses_one_hour_for_start_time_only(self) -> None:
        base = datetime(2026, 5, 18, 9, 0, tzinfo=ZoneInfo("Asia/Tokyo"))

        event = parse_event_text("5/20 14:00 会議", base)

        self.assertEqual(event.start.isoformat(timespec="minutes"), "2026-05-20T14:00+09:00")
        self.assertEqual(event.end.isoformat(timespec="minutes"), "2026-05-20T15:00+09:00")
        self.assertEqual(event.duration_minutes, 60)
        self.assertFalse(event.all_day)

    def test_treats_date_only_input_as_all_day(self) -> None:
        base = datetime(2026, 5, 18, 9, 0, tzinfo=ZoneInfo("Asia/Tokyo"))

        event = parse_event_text("明日、東京出張", base)

        self.assertEqual(event.start.isoformat(timespec="minutes"), "2026-05-19T00:00+09:00")
        self.assertEqual(event.duration_minutes, 1440)
        self.assertEqual(event.subject, "東京出張")
        self.assertEqual(event.location, "東京")
        self.assertTrue(event.all_day)

    def test_does_not_treat_room_number_as_time(self) -> None:
        base = datetime(2026, 5, 18, 9, 0, tzinfo=ZoneInfo("Asia/Tokyo"))

        event = parse_event_text("明日 第2会議室で定例", base)

        self.assertEqual(event.start.isoformat(timespec="minutes"), "2026-05-19T00:00+09:00")
        self.assertEqual(event.subject, "第2会議室で定例")
        self.assertTrue(event.all_day)

    def test_impossible_calendar_date_is_rejected_with_a_clear_message(self) -> None:
        base = datetime(2026, 5, 18, 9, 0, tzinfo=ZoneInfo("Asia/Tokyo"))

        for text in ("2026/2/30 15:00 会議", "4/31 会議", "2027/2/29 会議"):
            with self.subTest(text=text), self.assertRaises(ValueError) as context:
                parse_event_text(text, base)
            self.assertIn("日付が正しくありません", str(context.exception))

    def test_end_time_before_start_time_means_next_day(self) -> None:
        base = datetime(2026, 5, 18, 9, 0, tzinfo=ZoneInfo("Asia/Tokyo"))

        event = parse_event_text("2026/5/20 23:00〜1:00 夜間作業", base)

        self.assertEqual(event.start.isoformat(timespec="minutes"), "2026-05-20T23:00+09:00")
        self.assertEqual(event.end.isoformat(timespec="minutes"), "2026-05-21T01:00+09:00")
        self.assertEqual(event.duration_minutes, 120)

    def test_past_month_day_without_year_rolls_to_next_year(self) -> None:
        base = datetime(2026, 5, 18, 9, 0, tzinfo=ZoneInfo("Asia/Tokyo"))

        event = parse_event_text("3/1 15:00 会議", base)

        self.assertEqual(event.start.date().isoformat(), "2027-03-01")


if __name__ == "__main__":
    unittest.main()
