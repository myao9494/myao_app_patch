"""new_automation.py (自動化のひな形・一覧・ランチャーのコマンド) のテスト。AI_work で実行する:
    python -m unittest discover -s .opencode/skills/automation-builder/tests

【仕様】
- new: 名前の決まり (英小文字・数字・ハイフン) を守り、AI_work とハーネスの既存のスキルと重ならないときだけ置く。上書きしない。
  --dry-run は何も書かない。置いたひな形の main.py とテストは、そのまま動く。.bat は ASCII と CRLF。
- list: 一覧と、足りないもの (【 】の残り、一覧への記載、テスト、設定) を出す。
- slash: ランチャーの決まり (名前に空白・/ を含まない) に合う JSON を出す。登録はしない。
"""
from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "new_automation.py"
spec = importlib.util.spec_from_file_location("new_automation", SCRIPT)
na = importlib.util.module_from_spec(spec)
spec.loader.exec_module(na)


class Base(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / "AI_work"
        self.harness = Path(tmp.name) / "harness"
        (self.root / ".opencode" / "skills" / "automation-builder").mkdir(parents=True)
        (self.harness / "skills" / "browser-session").mkdir(parents=True)

    def run_cli(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        code = na.main(["--root", str(self.root), "--harness", str(self.harness), *argv], stdout=out, stderr=err)
        return code, out.getvalue(), err.getvalue()

    def skill(self, name: str) -> Path:
        return self.root / ".opencode" / "skills" / name


class NewTests(Base):
    def test_種類ごとのファイルを置く(self) -> None:
        for name, kind, extra in (("calc-a", "python", "tests/test_main.py"), ("yotei-b", "outlook", "scripts/main.py"), ("kintai-c", "browser", "scripts/flow.py")):
            code, out, _ = self.run_cli("new", name, "--title", "題名", "--kind", kind)
            self.assertEqual(code, 0)
            for rel in ("SKILL.md", "run.bat", "run.sh", "config.sample.json", extra):
                self.assertTrue((self.skill(name) / rel).is_file(), f"{name}/{rel}")
            meta = na.read_frontmatter(self.skill(name) / "SKILL.md")
            self.assertEqual(meta["name"], name)
            bat = (self.skill(name) / "run.bat").read_bytes()
            bat.decode("ascii")
            self.assertIn(b"\r\n", bat)
            self.assertNotIn(b"\r", (self.skill(name) / "run.sh").read_bytes())
        self.assertFalse((self.skill("kintai-c") / "tests").exists())
        self.assertIn("--allow-submit", (self.skill("kintai-c") / "SKILL.md").read_text(encoding="utf-8"))

    def test_dry_runは何も書かない(self) -> None:
        code, out, _ = self.run_cli("new", "calc-a", "--title", "題名", "--kind", "python", "--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("置く予定", out)
        self.assertFalse(self.skill("calc-a").exists())

    def test_名前の誤りと重複は書かずにエラー(self) -> None:
        for bad in ("Kintai", "kintai_input", "a-", "a--b", "勤怠", "a" * 65):
            code, _, err = self.run_cli("new", bad, "--title", "題名", "--kind", "python")
            self.assertEqual(code, 2, bad)
            self.assertIn("名前は", err)
        code, _, err = self.run_cli("new", "browser-session", "--title", "題名", "--kind", "python")
        self.assertEqual(code, 2)
        self.assertIn("ハーネス", err)
        self.assertFalse(self.skill("browser-session").exists())
        (self.skill("calc-a")).mkdir()
        (self.skill("calc-a") / "SKILL.md").write_text("元のまま", encoding="utf-8")
        code, _, err = self.run_cli("new", "calc-a", "--title", "題名", "--kind", "python")
        self.assertEqual(code, 2)
        self.assertEqual((self.skill("calc-a") / "SKILL.md").read_text(encoding="utf-8"), "元のまま")

    def test_ひな形のmainとテストがそのまま動く(self) -> None:
        self.run_cli("new", "calc-a", "--title", "題名", "--kind", "python")
        main_py = self.skill("calc-a") / "scripts" / "main.py"
        result = subprocess.run([sys.executable, "-B", str(main_py), "例", "--dry-run"], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("日付", json.loads(result.stdout)[0])
        tests = subprocess.run([sys.executable, "-B", "-m", "unittest", "discover", "-s", str(self.skill("calc-a") / "tests")], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(tests.returncode, 0, tests.stderr)

    def test_flowは構文として正しい(self) -> None:
        self.run_cli("new", "kintai-c", "--title", "題名", "--kind", "browser")
        compile((self.skill("kintai-c") / "scripts" / "flow.py").read_text(encoding="utf-8"), "flow.py", "exec")


class ListTests(Base):
    def test_足りないものを出す(self) -> None:
        self.run_cli("new", "calc-a", "--title", "題名", "--kind", "python")
        code, out, _ = self.run_cli("list")
        self.assertEqual(code, 0)
        self.assertIn("- calc-a:", out)
        self.assertIn("【 】が残っている", out)
        self.assertIn("自動化一覧.md に載っていない", out)
        self.assertNotIn("automation-builder", out)

    def test_埋めて一覧に載せれば要確認は設定だけ(self) -> None:
        self.run_cli("new", "calc-a", "--title", "題名", "--kind", "python")
        skill_md = self.skill("calc-a") / "SKILL.md"
        skill_md.write_text("---\nname: calc-a\ndescription: 表を計算するときに使う\n---\n本文\n", encoding="utf-8")
        (self.root / "自動化一覧.md").write_text("| `calc-a` | 表の計算 |\n", encoding="utf-8")
        _, out, _ = self.run_cli("list")
        self.assertEqual(out.count("要確認"), 1, out)
        self.assertIn("config.local.json", out)

    def test_自動化が無いとき(self) -> None:
        _, out, _ = self.run_cli("list")
        self.assertIn("まだありません", out)


class SlashTests(Base):
    def test_ランチャーの形のJSONを出す(self) -> None:
        self.run_cli("new", "kintai-c", "--title", "勤怠入力", "--kind", "browser")
        code, out, _ = self.run_cli("slash", "kintai-c", "--command", "/kintai", "--description", "勤怠を入力")
        self.assertEqual(code, 0)
        entry = json.loads(out.split("\n(", 1)[0])
        self.assertEqual(entry["name"], "kintai")
        self.assertEqual(entry["description"], "勤怠を入力")
        self.assertIn("`kintai-c`", entry["prompt"])
        self.assertIn("$ARGUMENTS", entry["prompt"])

    def test_誤りはエラー(self) -> None:
        code, _, err = self.run_cli("slash", "none", "--command", "x")
        self.assertEqual(code, 2)
        self.run_cli("new", "kintai-c", "--title", "勤怠入力", "--kind", "browser")
        for bad in ("two words", "a/b", " "):
            code, _, _ = self.run_cli("slash", "kintai-c", "--command", bad)
            self.assertEqual(code, 2, bad)


if __name__ == "__main__":
    unittest.main()
