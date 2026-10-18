"""APIから呼ばれるユースケース（アドレス再取得・ダミーデータ投入）のテスト。"""
from __future__ import annotations

import csv
import unittest
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from unittest.mock import patch

from backend import db, outlook, services
from backend.testing import TempEnvironmentTestCase


class ServicesTest(TempEnvironmentTestCase):
    def test_refresh_addresses_keeps_missing_old_address_with_zero_count(self) -> None:
        with self.public_csv.open("w", encoding="utf-8", newline="") as fp:
            writer = csv.writer(fp)
            writer.writerow(["名前", "回数"])
            writer.writerow(["旧アドレス", "9"])
            writer.writerow(["継続アドレス", "3"])

        sent = ["継続アドレス", "新アドレス", "新アドレス"]
        with patch.object(outlook, "get_sent_item_recipients", return_value=sent):
            result = services.refresh_addresses()

        self.assertEqual(result["saved_count"], 3)
        self.assertEqual(result["zero_count"], 1)
        rows = db.read_recipients_csv(self.public_csv)
        self.assertEqual(rows["旧アドレス"], 0)
        self.assertEqual(rows["継続アドレス"], 1)
        self.assertEqual(rows["新アドレス"], 2)

    def test_refresh_addresses_skips_invalid_old_csv_count(self) -> None:
        with self.public_csv.open("w", encoding="utf-8", newline="") as fp:
            writer = csv.writer(fp)
            writer.writerow(["名前", "回数"])
            writer.writerow(["壊れた旧アドレス", "not-a-number"])
            writer.writerow(["正常な旧アドレス", "3"])

        with patch.object(outlook, "get_sent_item_recipients", return_value=["新アドレス"]):
            result = services.refresh_addresses()

        rows = db.read_recipients_csv(self.public_csv)
        self.assertEqual(result["saved_count"], 2)
        self.assertNotIn("壊れた旧アドレス", rows)
        self.assertEqual(rows["正常な旧アドレス"], 0)
        self.assertEqual(rows["新アドレス"], 1)

    def test_seed_dummy_data_populates_database(self) -> None:
        inserted = services.seed_dummy_data()
        snapshot = db.list_database()

        self.assertEqual(inserted["recipients"], 4)
        self.assertGreaterEqual(len(snapshot["keyword_matches"]), 3)
        self.assertEqual(snapshot["job_runs"][0]["status"], "success")

    def test_names_known_only_to_the_database_are_kept_with_zero_count(self) -> None:
        db.ensure_db()
        db.save_recipients([("DBだけの宛先", 4)])
        self.assertFalse(self.public_csv.exists())

        with patch.object(outlook, "get_sent_item_recipients", return_value=["新宛先"]):
            result = services.refresh_addresses()

        self.assertEqual(result["saved_count"], 2)
        self.assertEqual(db.read_recipients_csv(self.public_csv), {"新宛先": 1, "DBだけの宛先": 0})


class ScheduleDatetimeTest(unittest.TestCase):
    def test_naive_values_are_treated_as_jst(self) -> None:
        parsed = services.parse_schedule_datetime("2026-05-21T10:15")

        self.assertEqual(parsed.isoformat(), "2026-05-21T10:15:00+09:00")

    def test_utc_z_suffix_is_converted_to_jst(self) -> None:
        parsed = services.parse_schedule_datetime("2026-05-21T01:15:00Z")

        self.assertEqual(parsed, datetime(2026, 5, 21, 10, 15, tzinfo=ZoneInfo("Asia/Tokyo")))
        self.assertEqual(parsed.utcoffset(), timedelta(hours=9))

    def test_blank_or_malformed_values_are_rejected(self) -> None:
        for value in (None, "", "  ", 123, "yesterday"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                services.parse_schedule_datetime(value)


class ScheduleEventPayloadTest(unittest.TestCase):
    def payload(self, **overrides):
        event = {"subject": "会議", "start": "2026-05-21T10:00", "end": "2026-05-21T11:30", **overrides}
        return {"text": "元の文", "event": event}

    def test_builds_event_with_duration_and_trimmed_fields(self) -> None:
        event = services.schedule_event_from_payload(self.payload(subject=" 会議 ", location=" 会議室 ", all_day=True))

        self.assertEqual(event.subject, "会議")
        self.assertEqual(event.location, "会議室")
        self.assertEqual(event.duration_minutes, 90)
        self.assertTrue(event.all_day)

    def test_rejects_blank_subject_and_reversed_times(self) -> None:
        with self.assertRaises(ValueError):
            services.schedule_event_from_payload(self.payload(subject="  "))
        with self.assertRaises(ValueError):
            services.schedule_event_from_payload(self.payload(end="2026-05-21T10:00"))

    def test_rejects_non_object_event(self) -> None:
        with self.assertRaises(ValueError):
            services.schedule_event_from_payload({"event": "x"})

    def test_without_event_the_text_is_parsed(self) -> None:
        event = services.schedule_event_from_payload({"text": "2026/5/20 15:00から16:30 調整会議"})

        self.assertEqual(event.subject, "調整会議")
        self.assertEqual(event.duration_minutes, 90)


if __name__ == "__main__":
    unittest.main()
