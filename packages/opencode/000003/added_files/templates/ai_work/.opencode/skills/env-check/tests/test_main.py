"""env-check の scripts/main.py のテスト。AI_work で実行する:
    python -m unittest discover -s .opencode/skills/env-check/tests
"""
from __future__ import annotations

import importlib.util
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "main.py"
spec = importlib.util.spec_from_file_location("env_check_main", SCRIPT)
main = importlib.util.module_from_spec(spec)
spec.loader.exec_module(main)


class CollectTests(unittest.TestCase):
    def test_日付と曜日_ハーネスと自動化の有無(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ai_work, harness = Path(tmp) / "AI_work", Path(tmp) / "harness"
            for name in ("automation-builder", "env-check", "kintai-input"):
                (ai_work / ".opencode" / "skills" / name).mkdir(parents=True)
                (ai_work / ".opencode" / "skills" / name / "SKILL.md").write_text("---\n", encoding="utf-8")
            (harness / "skills" / "browser-session").mkdir(parents=True)
            (harness / "skills" / "browser-session" / "SKILL.md").write_text("---\n", encoding="utf-8")

            info = main.collect(datetime(2026, 11, 12, 9, 5), ai_work, harness)

        self.assertEqual((info["今日"], info["曜日"], info["時刻"]), ("2026-11-12", "木", "09:05"))
        self.assertTrue(info["ハーネスのスキル"]["browser-session"])
        self.assertFalse(info["ハーネスのスキル"]["outlook-mail"])
        self.assertEqual(info["自動化"], ["kintai-input"])
        self.assertIn("今日: 2026-11-12 (木) 09:05", main.render(info))

    def test_skillsが無くても止まらない(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            info = main.collect(datetime(2026, 1, 1), Path(tmp), Path(tmp))
        self.assertEqual(info["自動化"], [])


if __name__ == "__main__":
    unittest.main()
