"""SQLite/CSV保存処理（初期化・原子的な書き込み・お気に入り）のテスト。"""
from __future__ import annotations

import sqlite3
import unittest
from unittest.mock import patch

from backend import db
from backend.testing import TempEnvironmentTestCase


class EnsureDbTest(TempEnvironmentTestCase):
    def test_schema_is_created_only_once_per_database_file(self) -> None:
        connections: list[int] = []
        real_connect = sqlite3.connect

        def counting_connect(*args, **kwargs):
            connections.append(1)
            return real_connect(*args, **kwargs)

        with patch.object(db.sqlite3, "connect", counting_connect):
            db.ensure_db()
            after_first = len(connections)
            db.ensure_db()
            db.ensure_db()

        self.assertGreater(after_first, 0)
        self.assertEqual(len(connections), after_first)

    def test_schema_is_recreated_when_database_file_disappears(self) -> None:
        db.ensure_db()
        self.db_path.unlink()

        db.ensure_db()

        self.assertEqual(db.get_settings()["keyword_interval_minutes"], 60)

    def test_reading_does_not_modify_existing_database_file(self) -> None:
        db.ensure_db()
        before = self.db_path.stat().st_mtime_ns

        db.get_settings()
        db.list_favorites()
        db.list_keyword_matches()

        self.assertEqual(self.db_path.stat().st_mtime_ns, before)


class RecipientsCsvTest(TempEnvironmentTestCase):
    def test_write_is_atomic_and_leaves_no_temporary_files(self) -> None:
        db.write_recipients_csv([("山田 太郎", 3), ("佐藤 一郎", 1)])

        self.assertEqual(db.read_recipients_csv(self.public_csv), {"山田 太郎": 3, "佐藤 一郎": 1})
        self.assertEqual(db.read_recipients_csv(self.dist_csv), {"山田 太郎": 3, "佐藤 一郎": 1})
        self.assertEqual(sorted(p.name for p in self.public_csv.parent.iterdir()), ["recipients.csv"])

    def test_failed_write_keeps_previous_csv_intact(self) -> None:
        db.write_recipients_csv([("残る宛先", 5)])

        with patch.object(db.csv, "writer", side_effect=OSError("disk full")), self.assertRaises(OSError):
            db.write_recipients_csv([("壊れる宛先", 1)])

        self.assertEqual(db.read_recipients_csv(self.public_csv), {"残る宛先": 5})
        self.assertEqual(sorted(p.name for p in self.public_csv.parent.iterdir()), ["recipients.csv"])


class FavoritesTest(TempEnvironmentTestCase):
    def test_saving_unchanged_favorite_keeps_its_updated_at(self) -> None:
        db.save_favorites({"favorites": [{"name": "A", "addresses": ["x"], "cc_addresses": []}]})
        first = {f["name"]: f["updated_at"] for f in db.list_favorites()}

        with patch.object(db, "utc_now", return_value="2099-01-01T00:00:00+00:00"):
            db.save_favorites({"favorites": [
                {"name": "A", "addresses": ["x"], "cc_addresses": []},
                {"name": "B", "addresses": ["y"], "cc_addresses": ["z"]},
            ]})

        saved = {f["name"]: f["updated_at"] for f in db.list_favorites()}
        self.assertEqual(saved["A"], first["A"])
        self.assertEqual(saved["B"], "2099-01-01T00:00:00+00:00")

    def test_saving_changed_favorite_updates_its_timestamp(self) -> None:
        db.save_favorites({"favorites": [{"name": "A", "addresses": ["x"], "cc_addresses": []}]})

        with patch.object(db, "utc_now", return_value="2099-01-01T00:00:00+00:00"):
            db.save_favorites({"favorites": [{"name": "A", "addresses": ["x", "y"], "cc_addresses": []}]})

        self.assertEqual(db.list_favorites()[0]["updated_at"], "2099-01-01T00:00:00+00:00")


class DatabaseTest(TempEnvironmentTestCase):
    def test_list_keyword_matches_does_not_mark_history_as_new(self) -> None:
        db.ensure_db()
        db.persist_keyword_matches([
            db.KeywordMatch(
                received_time="2026-04-28T10:00:00",
                subject="職アドからのお知らせ",
                line="棚卸の通知です",
                keyword="棚卸",
                is_new=False,
            )
        ])

        matches = db.list_keyword_matches()
        new_only_matches = db.list_keyword_matches(new_only=True)

        self.assertEqual(len(matches), 1)
        self.assertFalse(matches[0]["is_new"])
        self.assertEqual(new_only_matches, [])

    def test_list_database_orders_latest_rows_first(self) -> None:
        db.ensure_db()
        with db.db_connection() as conn:
            conn.execute(
                "INSERT INTO recipients(name, count, updated_at) VALUES(?, ?, ?)",
                ("古い宛先", 1, "2026-05-12T00:00:00+00:00"),
            )
            conn.execute(
                "INSERT INTO recipients(name, count, updated_at) VALUES(?, ?, ?)",
                ("新しい宛先", 2, "2026-05-14T00:00:00+00:00"),
            )
            conn.execute(
                """
                INSERT INTO keyword_matches(received_time, subject, line, keyword, first_seen_at)
                VALUES(?, ?, ?, ?, ?)
                """,
                ("2026-05-13T00:00:00+09:00", "職アドからのお知らせ", "古い通知", "棚卸", "2026-05-13T00:00:00+00:00"),
            )
            conn.execute(
                """
                INSERT INTO keyword_matches(received_time, subject, line, keyword, first_seen_at)
                VALUES(?, ?, ?, ?, ?)
                """,
                (
                    "2026-05-14T00:00:00+09:00",
                    "職アドからのお知らせ",
                    "新しい通知",
                    "棚卸",
                    "2026-05-14T00:00:00+00:00",
                ),
            )
            conn.commit()

        snapshot = db.list_database()

        self.assertEqual(snapshot["recipients"][0]["name"], "新しい宛先")
        self.assertEqual(snapshot["keyword_matches"][0]["line"], "新しい通知")

    def test_save_and_add_favorites(self) -> None:
        db.ensure_db()
        saved = db.save_favorites({
            "favorites": [
                {"name": "開発チーム", "addresses": ["山田 太郎", "佐藤 一郎"], "cc_addresses": ["鈴木 三郎"]},
            ],
        })
        added = db.add_favorite({
            "name": "経理",
            "addresses": "keiri@example.com; 山田 花子",
            "cc_addresses": "cc-keiri@example.com",
        })
        favorites = db.list_favorites()

        self.assertEqual(saved[0]["name"], "開発チーム")
        self.assertEqual(saved[0]["addresses"], ["山田 太郎", "佐藤 一郎"])
        self.assertEqual(saved[0]["cc_addresses"], ["鈴木 三郎"])
        self.assertEqual(added["name"], "経理")
        self.assertEqual(added["addresses"], ["keiri@example.com", "山田 花子"])
        self.assertEqual(added["cc_addresses"], ["cc-keiri@example.com"])
        self.assertEqual({favorite["name"] for favorite in favorites}, {"開発チーム", "経理"})

    def test_ensure_db_adds_cc_addresses_column(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        # 古いスキーマ（cc_addressesなし）でfavoritesテーブルを作成
        import sqlite3
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS favorites (
              name TEXT PRIMARY KEY,
              addresses TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )
        # 古いお気に入りデータを1件登録
        conn.execute(
            "INSERT INTO favorites(name, addresses, updated_at) VALUES(?, ?, ?)",
            ("開発チーム", '["山田 太郎"]', "2026-05-18T10:00:00")
        )
        conn.commit()
        conn.close()

        # ensure_db を呼び出してカラムが追加されるか確認
        db.ensure_db()
        # 既存データが宛先（To）として残り、CCが空で取得できることを確認
        favorites = db.list_favorites()
        self.assertEqual(favorites[0]["name"], "開発チーム")
        self.assertEqual(favorites[0]["addresses"], ["山田 太郎"])
        self.assertEqual(favorites[0]["cc_addresses"], []) # DEFAULT値の '[]' がパースされて空配列になること

    def test_delete_database_records_removes_selected_rows(self) -> None:
        db.ensure_db()
        db.save_recipients([("削除する宛先", 1), ("残す宛先", 2)])
        result = db.delete_database_records("recipients", ["削除する宛先"])
        snapshot = db.list_database()

        self.assertEqual(result["deleted"], 1)
        self.assertEqual([row["name"] for row in snapshot["recipients"]], ["残す宛先"])

    def test_delete_recipient_records_updates_csv_files(self) -> None:
        db.ensure_db()
        db.save_recipients([("削除する宛先", 1), ("残す宛先", 2)])
        db.write_recipients_csv([("残す宛先", 2), ("削除する宛先", 1)])
        db.delete_database_records("recipients", ["削除する宛先"])

        public_rows = db.read_recipients_csv(self.public_csv)
        dist_rows = db.read_recipients_csv(self.dist_csv)

        self.assertEqual(public_rows, {"残す宛先": 2})
        self.assertEqual(dist_rows, {"残す宛先": 2})

    def test_delete_database_records_rejects_settings(self) -> None:
        with self.assertRaises(ValueError):
            db.delete_database_records("settings", ["keywords"])

    def test_ensure_db_adds_confirmed_column(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        # 古いスキーマ（confirmedなし）でテーブルを作成
        import sqlite3
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS keyword_matches (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              received_time TEXT NOT NULL,
              subject TEXT NOT NULL,
              line TEXT NOT NULL,
              keyword TEXT NOT NULL,
              first_seen_at TEXT NOT NULL,
              UNIQUE(received_time, subject, line, keyword)
            )
            """
        )
        conn.commit()
        conn.close()

        # ensure_db を呼び出してカラムが追加されるか確認
        db.ensure_db()
        with db.db_connection() as conn:
            # confirmed カラムが存在するかチェック
            cursor = conn.execute("PRAGMA table_info(keyword_matches)")
            columns = [row[1] for row in cursor.fetchall()]
            self.assertIn("confirmed", columns)

    def test_list_keyword_matches_unconfirmed_only(self) -> None:
        db.ensure_db()
        # confirmed=0 (未確認) と confirmed=1 (確認済み) のマッチを追加
        # まず普通に登録 (confirmed=0)
        db.persist_keyword_matches([
            db.KeywordMatch(
                received_time="2026-05-18T10:00:00",
                subject="職アドからのお知らせ",
                line="未確認の通知です",
                keyword="棚卸",
                is_new=False,
            ),
            db.KeywordMatch(
                received_time="2026-05-18T11:00:00",
                subject="職アドからのお知らせ",
                line="確認済みの通知です",
                keyword="棚卸",
                is_new=False,
            )
        ])

        # 2つ目のIDを取得して確認済みに更新する
        with db.db_connection() as conn:
            row = conn.execute("SELECT id FROM keyword_matches WHERE line = '確認済みの通知です'").fetchone()
            target_id = row[0]
            # 現在はconfirmedカラムがないため、このテストはここで失敗するはず
            conn.execute("UPDATE keyword_matches SET confirmed = 1 WHERE id = ?", (target_id,))
            conn.commit()

        # unconfirmed_only=True で取得
        unconfirmed_matches = db.list_keyword_matches(unconfirmed_only=True)
        self.assertEqual(len(unconfirmed_matches), 1)
        self.assertEqual(unconfirmed_matches[0]["line"], "未確認の通知です")

    def test_confirm_keyword_matches(self) -> None:
        db.ensure_db()
        db.persist_keyword_matches([
            db.KeywordMatch(
                received_time="2026-05-18T10:00:00",
                subject="職アドからのお知らせ",
                line="テスト通知",
                keyword="棚卸",
                is_new=False,
            )
        ])

        # IDを取得
        with db.db_connection() as conn:
            row = conn.execute("SELECT id, confirmed FROM keyword_matches").fetchone()
            match_id = row[0]
            self.assertEqual(row[1], 0) # 初期値は0

        # 確認処理を実行
        result = db.confirm_keyword_matches([match_id])
        self.assertEqual(result["updated"], 1)

        # 確認済みになっているか検証
        with db.db_connection() as conn:
            row = conn.execute("SELECT confirmed FROM keyword_matches WHERE id = ?", (match_id,)).fetchone()
            self.assertEqual(row[0], 1)

    def test_profile_settings_initialization_and_save(self) -> None:
        """初期状態でプロフィール項目が存在すること、および save_settings で保存できることをテストする"""

        # データベース初期化
        db.ensure_db()

        # 初期値の確認
        settings = db.get_settings()
        self.assertIn("my_email", settings)
        self.assertEqual(settings["my_email"], "")
        self.assertIn("my_phone", settings)
        self.assertEqual(settings["my_phone"], "")
        self.assertIn("my_address", settings)
        self.assertEqual(settings["my_address"], "")
        self.assertIn("my_dept", settings)
        self.assertEqual(settings["my_dept"], "")
        self.assertIn("my_home_email", settings)
        self.assertEqual(settings["my_home_email"], "")

        # 設定の保存
        payload = {
            "my_email": " user@example.com ",
            "my_phone": " 090-0000-0000 ",
            "my_address": " 東京都千代田区 ",
            "my_dept": " 開発部 ",
            "my_home_email": " home@example.com "
        }
        updated = db.save_settings(payload)

        # トリムされた状態で保存されていることを検証
        self.assertEqual(updated["my_email"], "user@example.com")
        self.assertEqual(updated["my_phone"], "090-0000-0000")
        self.assertEqual(updated["my_address"], "東京都千代田区")
        self.assertEqual(updated["my_dept"], "開発部")
        self.assertEqual(updated["my_home_email"], "home@example.com")

        # 再度取得した値もトリムされた状態であることを検証
        settings_again = db.get_settings()
        self.assertEqual(settings_again["my_email"], "user@example.com")
        self.assertEqual(settings_again["my_phone"], "090-0000-0000")
        self.assertEqual(settings_again["my_address"], "東京都千代田区")
        self.assertEqual(settings_again["my_dept"], "開発部")
        self.assertEqual(settings_again["my_home_email"], "home@example.com")


class SettingsValidationTest(TempEnvironmentTestCase):
    def test_keywords_must_be_a_string_array_and_are_trimmed(self) -> None:
        with self.assertRaises(ValueError):
            db.save_settings({"keywords": "棚卸"})
        with self.assertRaises(ValueError):
            db.save_settings({"keywords": ["棚卸", 1]})

        saved = db.save_settings({"keywords": [" 棚卸 ", "", "  ", "-除外"]})

        self.assertEqual(saved["keywords"], ["棚卸", "-除外"])
        self.assertEqual(db.get_settings()["keywords"], ["棚卸", "-除外"])

    def test_intervals_must_be_positive_integers(self) -> None:
        for key in ("address_interval_minutes", "keyword_interval_minutes"):
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    db.save_settings({key: 0})
                with self.assertRaises(ValueError):
                    db.save_settings({key: "abc"})

        self.assertEqual(db.save_settings({"keyword_interval_minutes": "15"})["keyword_interval_minutes"], 15)

    def test_unknown_keys_are_ignored(self) -> None:
        db.save_settings({"unknown": "x"})

        self.assertNotIn("unknown", db.get_settings())


class FavoriteNormalizationTest(TempEnvironmentTestCase):
    def test_addresses_accept_lists_and_delimited_strings(self) -> None:
        self.assertEqual(db.normalize_favorite_addresses("a; b、c,d\n"), ["a", "b", "c", "d"])
        self.assertEqual(db.normalize_favorite_addresses([" a ", "", "b"]), ["a", "b"])
        self.assertEqual(db.normalize_favorite_addresses(None), [])

    def test_add_favorite_requires_name_and_at_least_one_address(self) -> None:
        with self.assertRaises(ValueError):
            db.add_favorite({"name": " ", "addresses": ["a"]})
        with self.assertRaises(ValueError):
            db.add_favorite({"name": "空", "addresses": [], "cc_addresses": []})

    def test_add_favorite_accepts_cc_only(self) -> None:
        favorite = db.add_favorite({"name": "CCのみ", "cc_addresses": ["c@example.com"]})

        self.assertEqual(favorite["addresses"], [])
        self.assertEqual(favorite["cc_addresses"], ["c@example.com"])

    def test_save_favorites_rejects_non_array_and_skips_invalid_items(self) -> None:
        with self.assertRaises(ValueError):
            db.save_favorites({"favorites": "x"})

        saved = db.save_favorites({"favorites": [
            "not-a-dict",
            {"name": "", "addresses": ["a"]},
            {"name": "空"},
            {"name": "OK", "addresses": ["a"]},
        ]})

        self.assertEqual([f["name"] for f in saved], ["OK"])


class KeywordMatchPersistenceTest(TempEnvironmentTestCase):
    def match(self, line: str = "棚卸の通知") -> db.KeywordMatch:
        return db.KeywordMatch(
            received_time="2026-05-18T10:00:00", subject="職アドからのお知らせ", line=line, keyword="棚卸", is_new=False
        )

    def test_same_match_is_new_only_the_first_time_and_keeps_its_confirmed_state(self) -> None:
        first = db.persist_keyword_matches([self.match()])[0]
        assert first.id is not None
        db.confirm_keyword_matches([first.id])

        again = db.persist_keyword_matches([self.match()])[0]

        self.assertTrue(first.is_new)
        self.assertFalse(again.is_new)
        self.assertEqual(again.id, first.id)
        self.assertTrue(again.confirmed)

    def test_confirm_with_no_ids_updates_nothing(self) -> None:
        self.assertEqual(db.confirm_keyword_matches([]), {"updated": 0})

    def test_delete_rejects_unknown_tables_and_ignores_empty_keys(self) -> None:
        with self.assertRaises(ValueError):
            db.delete_database_records("sqlite_master", ["x"])

        self.assertEqual(db.delete_database_records("job_runs", []), {"table": "job_runs", "deleted": 0})

    def test_job_runs_record_latest_status_per_job(self) -> None:
        db.ensure_db()
        db.record_job_run("check_keywords", "error", "boom")
        db.record_job_run("check_keywords", "success", "ok")

        runs = db.list_job_runs()

        self.assertEqual(runs["check_keywords"]["status"], "success")
        self.assertEqual(runs["check_keywords"]["message"], "ok")


if __name__ == "__main__":
    unittest.main()
