"""vault_cli のテスト。実行: python -m unittest discover -s skills/vault-notes/tests -v   (リポジトリのルートから)"""
from __future__ import annotations

import datetime as dt
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR / "scripts"))

import vault_cli as cli  # noqa: E402

NOW = dt.datetime(2026, 11, 7, 9, 5, 3)  # 土曜日


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()
        self.vault = self.tmp / "vault"
        (self.vault / ".obsidian").mkdir(parents=True)
        (self.vault / ".handoff").mkdir()
        self.cwd = self.vault

    def run_cli(self, *argv: str, cwd: Path | None = None, config: Path | None = None, now: dt.datetime = NOW) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        code = cli.main(list(argv), stdout=out, stderr=err, cwd=cwd or self.cwd, now=now, config_path=config or self.tmp / "none.json")
        return code, out.getvalue(), err.getvalue()

    def draft(self, text: str = "# 検討\n\n結論: やる。\n", name: str = "draft.md") -> str:
        (self.vault / ".handoff" / name).write_text(text, encoding="utf-8")
        return f".handoff/{name}"

    def files(self) -> set[str]:
        return {p.relative_to(self.vault).as_posix() for p in self.vault.rglob("*") if p.is_file()}


class TodayTests(Base):
    def test_日付_時刻_フォルダー(self) -> None:
        code, out, _ = self.run_cli("today")
        self.assertEqual(code, 0)
        self.assertIn("日付: 2026-11-07 (土) / いま: 2026-11-07 09:05:03", out)
        self.assertIn("今日のフォルダー: 01_data/2026/11/07 (まだありません", out)
        self.assertIn("frontmatter の created: 2026-11-07 09:05:03", out)
        self.assertFalse((self.vault / "01_data").exists())  # 作らない

    def test_ゼロ埋め(self) -> None:
        _, out, _ = self.run_cli("today", now=dt.datetime(2026, 2, 3, 0, 0, 0))
        self.assertIn("01_data/2026/02/03", out)
        self.assertIn("(火)", out)

    def test_createで作る_あれば数を言う(self) -> None:
        self.run_cli("today", "--create")
        self.assertTrue((self.vault / "01_data/2026/11/07").is_dir())
        (self.vault / "01_data/2026/11/07/a.md").write_text("x", encoding="utf-8")
        _, out, _ = self.run_cli("today")
        self.assertIn("あります。ファイル 1 個", out)

    def test_Vaultの中のサブフォルダーから実行しても同じVault(self) -> None:
        sub = self.vault / "01_data" / "2026"
        sub.mkdir(parents=True)
        code, out, _ = self.run_cli("today", "--create", cwd=sub)
        self.assertEqual(code, 0)
        self.assertTrue((self.vault / "01_data/2026/11/07").is_dir())  # サブフォルダーの下には作らない
        self.assertFalse((sub / "01_data").exists())

    def test_Vaultの外では動かない(self) -> None:
        outside = self.tmp / "plain"
        outside.mkdir()
        code, _, err = self.run_cli("today", cwd=outside)
        self.assertEqual(code, 2)
        self.assertIn("Vault が見つかりません", err)

    def test_設定でフォルダーの形を変える(self) -> None:
        config = self.tmp / "c.json"
        config.write_text(json.dumps({"daily_dir": "Daily/{yyyy}-{mm}/{dd}"}), encoding="utf-8")
        self.assertIn("Daily/2026-11/07", self.run_cli("today", config=config)[1])
        for bad in ("../x/{dd}", "/abs/{dd}", "C:/x/{dd}", "x/{yy}", ".hidden/{dd}", "", "{"):
            config.write_text(json.dumps({"daily_dir": bad}), encoding="utf-8")
            self.assertEqual(self.run_cli("today", config=config)[0], 2, bad)


class CalendarTests(Base):
    """0.11.0: 「来週の水曜まで」を、モデルが date コマンドで計算しようとして止まった。曜日つきの日付を、today が出す。"""

    def test_今週と来週と_これから14日(self) -> None:
        _, out, _ = self.run_cli("today")  # 2026-11-07 は土曜日
        self.assertIn("今週: 11/02(月)〜11/08(日) / 来週: 11/09(月)〜11/15(日)", out)
        self.assertIn("これから 14 日: 11/07(土) 11/08(日) 11/09(月) 11/10(火) 11/11(水) 11/12(木) 11/13(金) 11/14(土) 11/15(日) 11/16(月) 11/17(火) 11/18(水) 11/19(木) 11/20(金)", out)

    def test_年をまたぐ(self) -> None:
        _, out, _ = self.run_cli("today", now=dt.datetime(2026, 12, 30, 8, 0, 0))
        self.assertIn("来週: 2027/01/04(月)〜2027/01/10(日)", out)
        self.assertIn("2027/01/01(金)", out)


class NewNoteTests(Base):
    def test_今日のフォルダーに作る(self) -> None:
        code, out, err = self.run_cli("new-note", "--title", "検討メモ", "--body-file", self.draft(), "--tags", "検討,メモ")
        self.assertEqual((code, err), (0, ""))
        self.assertIn("作りました: 01_data/2026/11/07/検討メモ.md", out)
        text = (self.vault / "01_data/2026/11/07/検討メモ.md").read_text(encoding="utf-8")
        self.assertEqual(text, "---\ncreated: 2026-11-07 09:05:03\nai_generated: opencode\nai_reviewed: false\ntags:\n  - 検討\n  - メモ\n---\n\n# 検討\n\n結論: やる。\n")

    def test_タグ無しは空のtags(self) -> None:
        self.run_cli("new-note", "--title", "a", "--body-file", self.draft())
        text = (self.vault / "01_data/2026/11/07/a.md").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\ncreated: 2026-11-07 09:05:03\nai_generated: opencode\nai_reviewed: false\ntags:\n---\n"))

    def test_上書きしない(self) -> None:
        for i in range(3):
            code, out, _ = self.run_cli("new-note", "--title", "同名", "--body-file", self.draft(f"本文{i}"))
        names = sorted(p.name for p in (self.vault / "01_data/2026/11/07").iterdir())
        self.assertEqual(names, ["同名.md", "同名_2.md", "同名_3.md"])
        self.assertIn("上書きしていません", out)
        self.assertIn("本文0", (self.vault / "01_data/2026/11/07/同名.md").read_text(encoding="utf-8"))

    def test_指定のフォルダー(self) -> None:
        self.run_cli("new-note", "--title", "t", "--body-file", self.draft(), "--dir", "02_MOC/案件")
        self.assertTrue((self.vault / "02_MOC/案件/t.md").exists())

    def test_保存先の制限(self) -> None:
        for bad in ("../outside", ".obsidian", ".obsidian/plugins", "01_data/.hidden", "/abs", "C:/x", ".handoff"):
            code, _, err = self.run_cli("new-note", "--title", "t", "--body-file", self.draft(), "--dir", bad)
            self.assertEqual(code, 2, bad)
        self.assertEqual({f for f in self.files() if not f.startswith(".handoff/")}, set())

    def test_シンボリックリンクで外に出られない(self) -> None:
        outside = self.tmp / "outside"
        outside.mkdir()
        try:
            os.symlink(outside, self.vault / "link")
        except (OSError, NotImplementedError):
            self.skipTest("シンボリックリンクを作れない環境")
        code, _, _ = self.run_cli("new-note", "--title", "t", "--body-file", self.draft(), "--dir", "link")
        self.assertEqual(code, 2)
        self.assertEqual(list(outside.iterdir()), [])

    def test_題名の安全化(self) -> None:
        self.assertEqual(cli.safe_title('a:b*c?"d<e>f|g/h\\i'), "a_b_c__d_e_f_g_h_i")
        self.assertEqual(cli.safe_title("見出し#1 [メモ] ^x"), "見出し_1 _メモ_ _x")  # Obsidian のリンクを壊す文字
        self.assertEqual(cli.safe_title("CON"), "_CON")
        self.assertEqual(cli.safe_title("末尾の点. "), "末尾の点")
        self.assertLessEqual(len(cli.safe_title("あ" * 300)), 100)
        for bad in ("", "   ", "...", "   . "):
            with self.assertRaises(cli.VaultError, msg=repr(bad)):
                cli.safe_title(bad)

    def test_タグの検査(self) -> None:
        for bad in ("a/b", "a b", "a:b", "a|b"):
            code, _, err = self.run_cli("new-note", "--title", "t", "--body-file", self.draft(), "--tags", bad)
            self.assertEqual(code, 2, bad)
        self.assertEqual(cli.parse_tags("#a, b、c,a"), ["a", "b", "c"])

    def test_本文の検査(self) -> None:
        self.assertEqual(self.run_cli("new-note", "--title", "t", "--body-file", self.draft("---\ncreated: x\n---\n本文"))[0], 2)
        self.assertEqual(self.run_cli("new-note", "--title", "t", "--body-file", self.draft("   \n"))[0], 2)
        self.assertEqual(self.run_cli("new-note", "--title", "t", "--body-file", "ない.md")[0], 2)
        outside = self.tmp / "outside.md"
        outside.write_text("外の本文", encoding="utf-8")
        code, _, err = self.run_cli("new-note", "--title", "t", "--body-file", str(outside))
        self.assertEqual(code, 2)
        self.assertIn("Vault の中", err)

    def test_dry_runは作らない(self) -> None:
        code, out, _ = self.run_cli("new-note", "--title", "t", "--body-file", self.draft(), "--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("実際には何も作っていません", out)
        self.assertIn("01_data/2026/11/07/t.md", out)
        self.assertFalse((self.vault / "01_data").exists())

    def test_本文は変えずに入る_日本語と改行(self) -> None:
        body = "結論: A案。\n\n- 理由1\n- 理由2\n\n[[関連ノート]] と ![[図.png]]\n"
        self.run_cli("new-note", "--title", "n", "--body-file", self.draft(body))
        text = (self.vault / "01_data/2026/11/07/n.md").read_bytes().decode("utf-8")
        self.assertTrue(text.endswith(body))
        self.assertNotIn("\r", text)


class BackupTests(Base):
    def test_コピーを残す_元は変えない(self) -> None:
        note = self.vault / "01_data" / "a.md"
        note.parent.mkdir()
        note.write_text("元の内容", encoding="utf-8")
        code, out, _ = self.run_cli("backup", "01_data/a.md")
        self.assertEqual(code, 0)
        self.assertIn("バックアップしました: .handoff/backup/20261107-090503_a.md", out)
        self.assertEqual((self.vault / ".handoff/backup/20261107-090503_a.md").read_text(encoding="utf-8"), "元の内容")
        self.assertEqual(note.read_text(encoding="utf-8"), "元の内容")

    def test_同じ秒でも上書きしない(self) -> None:
        note = self.vault / "a.md"
        note.write_text("1", encoding="utf-8")
        self.run_cli("backup", "a.md")
        note.write_text("2", encoding="utf-8")
        self.run_cli("backup", "a.md")
        contents = sorted(p.read_text(encoding="utf-8") for p in (self.vault / ".handoff/backup").iterdir() if p.suffix == ".md")
        self.assertEqual(contents, ["1", "2"])

    def test_対象の制限(self) -> None:
        (self.vault / ".obsidian" / "app.json").write_text("{}", encoding="utf-8")
        (self.vault / "dir").mkdir()
        outside = self.tmp / "outside.md"
        outside.write_text("外", encoding="utf-8")
        for bad in (".obsidian/app.json", "ない.md", "dir", str(outside), ".handoff/draft.md"):
            self.draft()
            self.assertEqual(self.run_cli("backup", bad)[0], 2, bad)
        self.assertFalse((self.vault / ".handoff/backup").exists())


class GanttIdTests(Base):
    """ガントのタスクとノートをつなぐ: ファイル名の末尾に【タスクID】(ガントの「O」・Vault の「ganttに追加」と同じ形)。"""

    def test_gantt_idでファイル名に付く(self) -> None:
        code, out, _ = self.run_cli("new-note", "--title", "見直しのまとめ", "--body-file", self.draft(), "--gantt-id", "272")
        self.assertEqual(code, 0)
        self.assertIn("作りました: 01_data/2026/11/07/見直しのまとめ【272】.md", out)
        self.assertIn("ガントのタスク 272", out)

    def test_すでに付いていれば二重にしない_dry_runでも名前が分かる(self) -> None:
        _, out, _ = self.run_cli("new-note", "--title", "見直し【272】", "--body-file", self.draft(), "--gantt-id", "272", "--dry-run")
        self.assertIn("01_data/2026/11/07/見直し【272】.md", out)
        self.assertNotIn("【272】【272】", out)

    def test_IDは正の整数だけ(self) -> None:
        for bad in ("0", "-1", "abc"):
            code, _, _ = self.run_cli("new-note", "--title", "a", "--body-file", self.draft(), "--gantt-id", bad)
            self.assertEqual(code, 2, bad)


class LinkAndIgnoreTests(Base):
    """0.10.1: Mac の試験 (個人のノートのまとめ) で、存在しないノートへのリンクと、.gitignore に .handoff が無い Vault が見つかった。"""

    def setUp(self) -> None:
        super().setUp()
        (self.vault / "01_data/2026/07/14").mkdir(parents=True)
        (self.vault / "01_data/2026/07/14/第4回会議_要約.md").write_text("x", encoding="utf-8")
        (self.vault / "01_data/2026/11/07").mkdir(parents=True)
        (self.vault / "01_data/2026/11/07/図_全体像.excalidraw.md").write_text("x", encoding="utf-8")
        (self.vault / "Media").mkdir()
        (self.vault / "Media/図.png").write_bytes(b"x")

    def test_存在しないノートへのリンクを知らせる(self) -> None:
        body = ("![[図_全体像.excalidraw]] ![[図.png]] [[第4回会議_要約]] [[第4回会議_要約#結論|要約]]\n"
                "[[サンプル社|1234 サンプル社]] [[無いノート]] [[無いノート]]\n")
        for extra in (["--dry-run"], []):
            code, out, _ = self.run_cli("new-note", "--title", "まとめ", "--body-file", self.draft(body), *extra)
            self.assertEqual(code, 0)
            self.assertIn("注意: 見つからないリンクが 2 個あります: [[サンプル社]]、[[無いノート]]", out)
            self.assertNotIn("第4回会議_要約]]、", out)
        self.assertTrue((self.vault / "01_data/2026/11/07/まとめ.md").exists(), "注意だけで、作るのは止めない")

    def test_リンクがすべてあれば何も言わない(self) -> None:
        _, out, _ = self.run_cli("new-note", "--title", "a", "--body-file", self.draft("[[第4回会議_要約]] ![[図_全体像.excalidraw]]"), "--dry-run")
        self.assertNotIn("見つからないリンク", out)

    def test_gitの管理下で_handoffが無視されていなければ知らせる(self) -> None:
        (self.vault / ".git").mkdir()
        _, out, _ = self.run_cli("today")
        self.assertIn(".gitignore に .handoff/ が入っていません", out)
        _, out, _ = self.run_cli("new-note", "--title", "a", "--body-file", self.draft(), "--dry-run")
        self.assertIn(".gitignore に .handoff/ が入っていません", out)
        (self.vault / ".gitignore").write_text("node_modules/\n.handoff/\n", encoding="utf-8")
        _, out, _ = self.run_cli("today")
        self.assertNotIn(".gitignore", out)
        self.assertEqual((self.vault / ".gitignore").read_text(encoding="utf-8"), "node_modules/\n.handoff/\n", "自分では .gitignore を書き換えない")

    def test_gitでなければ言わない(self) -> None:
        _, out, _ = self.run_cli("today")
        self.assertNotIn(".gitignore", out)


class QuoteAndAiSourceTests(Base):
    """0.12.0: レビューで、言い換えに「」が付き、AI のまとめを元にした誤りが別の資料に広がったことが分かった。"""

    def setUp(self) -> None:
        super().setUp()
        (self.vault / "01_data").mkdir()
        (self.vault / "01_data/会議_要約.md").write_text("---\ncreated: 2026-06-22\n---\n「汚いポジション」を相殺する。220でかって､240で売るを繰り返してもOK\n", encoding="utf-8")
        (self.vault / "01_data/AIのまとめ【1】.md").write_text("---\nai_generated: opencode\nai_reviewed: false\n---\n本文\n", encoding="utf-8")
        (self.vault / "01_data/確認済みのまとめ.md").write_bytes("---\r\nai_generated: opencode\r\nai_reviewed: true\r\n---\r\n本文\r\n".encode("utf-8"))
        (self.vault / "10_summary").mkdir()
        (self.vault / "10_summary/古い要約_summary.md").write_text("# 要約\n", encoding="utf-8")

    def test_原文に無い引用を知らせる(self) -> None:
        body = "- 「汚いポジション」([[会議_要約]])\n- 「220→240を繰り返す」([[会議_要約]])\n- 「220でかって、240で売る」([[会議_要約]])\n"
        _, out, _ = self.run_cli("new-note", "--title", "a", "--body-file", self.draft(body), "--dry-run")
        self.assertIn("注意: 「」の引用が 1 個、リンクした出典のノートに原文のまま見つかりません: 「220→240を繰り返す」", out)
        self.assertIn("言い換えなら「」を外す", out)

    def test_未レビューのAIのまとめを出典にしていたら知らせる(self) -> None:
        body = "[[AIのまとめ【1】]] [[確認済みのまとめ]] [[古い要約_summary]] [[会議_要約]]\n"
        _, out, _ = self.run_cli("new-note", "--title", "a", "--body-file", self.draft(body), "--dry-run")
        self.assertIn("注意: 未レビューの AI のまとめを、出典にしています: [[AIのまとめ【1】]]、[[古い要約_summary]]", out)
        self.assertNotIn("[[確認済みのまとめ]]、", out)

    def test_印のない人のノートと引用なしは何も言わない(self) -> None:
        _, out, _ = self.run_cli("new-note", "--title", "a", "--body-file", self.draft("[[会議_要約]] によると、相殺する。\n"), "--dry-run")
        self.assertNotIn("引用", out)
        self.assertNotIn("AI のまとめ", out)


class MarkEditTests(Base):
    """AI が既存のノートを直したら、状態を「未レビュー」にする (根拠には使ってよい。レビュー漏れを人が確かめるため)。"""

    def note(self, text: str, name: str = "01_data/a.md") -> Path:
        path = self.vault / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="")
        return path

    def test_既存のfrontmatterに足し_他の行は変えない(self) -> None:
        path = self.note("---\ncreated: 2025-01-01 00:00:00\ntags:\n  - 設計\n---\n# 本文\n\n--- 区切り\n")
        code, out, _ = self.run_cli("mark-edit", "01_data/a.md")
        self.assertEqual(code, 0, out)
        self.assertEqual(path.read_text(encoding="utf-8"), "---\ncreated: 2025-01-01 00:00:00\ntags:\n  - 設計\nai_edited: 2026-11-07 09:05:03\nai_reviewed: false\n---\n# 本文\n\n--- 区切り\n")
        self.assertIn("ai_reviewed: なし → false", out)

    def test_レビュー済をfalseに戻し_日時を更新する_trueにはしない(self) -> None:
        path = self.note("---\nai_edited: 2026-01-01 00:00:00\nai_reviewed: true\ncreated: x\n---\n本文\n")
        self.run_cli("mark-edit", "01_data/a.md")
        self.assertEqual(path.read_text(encoding="utf-8"), "---\nai_edited: 2026-11-07 09:05:03\nai_reviewed: false\ncreated: x\n---\n本文\n")
        source = (SKILL_DIR / "scripts" / "vault_cli.py").read_text(encoding="utf-8")
        self.assertNotIn('"ai_reviewed": "true"', source)

    def test_CRLFのノートで既存のキーを書き換えても_CRを保つ(self) -> None:
        """Windows のエディタで保存したノート。書き換えた行だけ CR が落ちて、改行が混ざらないこと。"""
        path = self.note("---\r\nai_edited: 2026-01-01 00:00:00\r\nai_reviewed: true\r\ncreated: x\r\n---\r\n本文\r\n")
        code, out, _ = self.run_cli("mark-edit", "01_data/a.md")
        self.assertEqual(code, 0, out)
        self.assertEqual(path.read_bytes(), "---\r\nai_edited: 2026-11-07 09:05:03\r\nai_reviewed: false\r\ncreated: x\r\n---\r\n本文\r\n".encode("utf-8"))
        self.assertIn("ai_reviewed: true → false", out)

    def test_frontmatterが無ければ作る_CRLFとBOMを保つ(self) -> None:
        path = self.vault / "b.md"
        path.write_bytes("\ufeff# 見出し\r\n本文\r\n".encode("utf-8"))
        code, out, _ = self.run_cli("mark-edit", "b.md")
        self.assertEqual(code, 0, out)
        self.assertEqual(path.read_bytes(), "\ufeff---\r\nai_edited: 2026-11-07 09:05:03\r\nai_reviewed: false\r\n---\r\n# 見出し\r\n本文\r\n".encode("utf-8"))
        self.assertIn("frontmatter が無かったので", out)

    def test_対象の制限と_閉じていないfrontmatter(self) -> None:
        self.note("---\ncreated: x\n本文だけ\n", "c.md")
        self.note("図", "d.excalidraw.md")
        (self.vault / "e.txt").write_text("x", encoding="utf-8")
        for bad in ("c.md", "d.excalidraw.md", "e.txt", ".handoff/draft.md", "無い.md"):
            self.draft()
            code, _, err = self.run_cli("mark-edit", bad)
            self.assertEqual(code, 2, bad)
        self.assertEqual((self.vault / "c.md").read_text(encoding="utf-8"), "---\ncreated: x\n本文だけ\n")

    def test_バックアップが無ければ知らせる(self) -> None:
        self.note("本文\n")
        _, out, _ = self.run_cli("mark-edit", "01_data/a.md")
        self.assertIn("バックアップが .handoff/backup/ にありません", out)
        self.run_cli("backup", "01_data/a.md")
        _, out, _ = self.run_cli("mark-edit", "01_data/a.md")
        self.assertNotIn("バックアップが", out)


class UnreviewedTests(Base):
    def write(self, name: str, text: str) -> Path:
        path = self.vault / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def test_作った_直した_レビュー済_人のノートを分ける(self) -> None:
        self.write("01_data/作った.md", "---\ncreated: 2026-11-07 08:00:00\nai_generated: opencode\nai_reviewed: false\n---\nx\n")
        self.write("01_data/作った済.md", "---\nai_generated: opencode\nai_reviewed: true\n---\nx\n")
        self.write("01_data/直した.md", "---\nai_edited: 2026-11-07 09:00:00\nai_reviewed: false\n---\nx\n")
        self.write("01_data/直した済.md", "---\nai_edited: 2026-11-07 09:00:00\nai_reviewed: true\n---\nx\n")
        self.write("01_data/図.excalidraw.md", "---\nai_generated: opencode\nai_reviewed: false\n---\nx\n")
        self.write("01_data/人.md", "---\ncreated: x\n---\nx\n")
        self.write(".handoff/隠れ.md", "---\nai_generated: opencode\n---\n")
        code, out, _ = self.run_cli("unreviewed")
        self.assertEqual(code, 0, out)
        self.assertIn("AI が作った 2 個 / AI が直した 1 個 / 印の付け忘れの疑い 0 個", out)
        self.assertIn("- 01_data/作った.md (created: 2026-11-07 08:00:00)", out)
        self.assertIn("- 01_data/図.excalidraw.md", out)
        self.assertIn("- 01_data/直した.md (ai_edited: 2026-11-07 09:00:00)", out)
        for name in ("作った済", "直した済", "人.md", "隠れ"):
            self.assertNotIn(name, out)

    def test_バックアップの後に変わったのに印が無いものを疑う(self) -> None:
        path = self.write("01_data/a.md", "---\ncreated: x\n---\n元\n")
        same = self.write("01_data/b.md", "変えない\n")
        self.run_cli("backup", "01_data/a.md")
        self.run_cli("backup", "01_data/b.md")
        path.write_text("---\ncreated: x\n---\n直した\n", encoding="utf-8")
        _, out, _ = self.run_cli("unreviewed", now=NOW + dt.timedelta(minutes=1))
        self.assertIn("印の付け忘れの疑い 1 個", out)
        self.assertIn("- 01_data/a.md (バックアップ: .handoff/backup/20261107-090503_a.md)", out)
        self.run_cli("mark-edit", "01_data/a.md", now=NOW + dt.timedelta(minutes=1))
        _, out, _ = self.run_cli("unreviewed")
        self.assertIn("AI が直した 1 個 / 印の付け忘れの疑い 0 個", out)
        self.assertEqual(same.read_text(encoding="utf-8"), "変えない\n")

    def test_同名のノートは記録で元を見分ける_md以外は見ない(self) -> None:
        one = self.write("01_data/1/無題.md", "一\n")
        two = self.write("01_data/2/無題.md", "二\n")
        self.write("80_script/a.js", "x\n")
        self.run_cli("backup", "01_data/1/無題.md")
        self.run_cli("backup", "80_script/a.js")
        (self.vault / "80_script/a.js").write_text("y\n", encoding="utf-8")
        two.write_text("二を人が直した\n", encoding="utf-8")
        _, out, _ = self.run_cli("unreviewed")
        self.assertIn("印の付け忘れの疑い 0 個", out)
        one.write_text("一を直した\n", encoding="utf-8")
        _, out, _ = self.run_cli("unreviewed")
        self.assertIn("- 01_data/1/無題.md (バックアップ:", out)
        self.assertNotIn("01_data/2/無題.md", out)
        self.assertNotIn("a.js", out)


class AdviceBase(Base):
    """0.25.0: 関連ノートへのリンクと、既存のタグを使うことの支援。"""

    def setUp(self) -> None:
        super().setUp()
        day = self.vault / "01_data/2026/10/01"
        day.mkdir(parents=True)
        (day / "銘柄分析_トヨタ.md").write_text("---\ncreated: 2026-10-01 10:00:00\ntags:\n  - 株\n  - 銘柄分析\n---\n\n# トヨタ\n配当は「年 2 回」である。\n", encoding="utf-8")
        (day / "優待メモ.md").write_text("---\ntags: [株, 優待]\n---\n本文に銘柄分析の語がある\n", encoding="utf-8")
        (day / "生活.md").write_text("---\ntags: 生活, AI\n---\n洗濯の話\n", encoding="utf-8")
        (day / "AI未確認.md").write_text("---\nai_generated: opencode\nai_reviewed: false\ntags:\n  - 株\n---\n銘柄分析のまとめ\n", encoding="utf-8")
        (day / "図_全体.excalidraw.md").write_text("---\ntags:\n  - excalidraw\n---\n銘柄分析\n", encoding="utf-8")
        (self.vault / "00_templates").mkdir()
        (self.vault / "00_templates/テンプレ.md").write_text("---\ntags:\n  - テンプレ専用\n---\n銘柄分析\n", encoding="utf-8")
        (self.vault / ".handoff/下書き.md").write_text("---\ntags:\n  - 隠し\n---\n銘柄分析\n", encoding="utf-8")
        other = self.vault / "01_data/2026/09/01"
        other.mkdir(parents=True)
        (other / "同名.md").write_text("---\ntags:\n  - 株\n---\n銘柄分析\n", encoding="utf-8")
        (day / "同名.md").write_text("---\ntags:\n  - 株\n---\n銘柄分析\n", encoding="utf-8")


class NoteTagsTests(unittest.TestCase):
    def test_tagsの書き方はどれも読める(self) -> None:
        self.assertEqual(cli.note_tags("---\ntags:\n  - a\n  - '#b'\n- c\nx: 1\n- z\n---\n"), ["a", "b", "c"])
        self.assertEqual(cli.note_tags("---\ntags: [a, b]\n---\n"), ["a", "b"])
        self.assertEqual(cli.note_tags("---\ntags: a, #b c\n---\n"), ["a", "b", "c"])
        self.assertEqual(cli.note_tags("---\ncreated: 1\ntags:\n---\n"), [])
        self.assertEqual(cli.note_tags(""), [])


class TagsCommandTests(AdviceBase):
    def test_件数の多い順に一覧する_触らない場所は数えない(self) -> None:
        code, out, err = self.run_cli("tags")
        self.assertEqual((code, err), (0, ""))
        self.assertIn("Vault のタグ: 5 種類", out)
        self.assertLess(out.index("- 株 (5)"), out.index("- 銘柄分析 (1)"))
        for hidden in ("テンプレ専用", "隠し", "excalidraw"):
            self.assertNotIn(hidden, out, "テンプレート、.handoff、図のタグは数えない")

    def test_grepは全角半角と大文字小文字を区別しない(self) -> None:
        _, out, _ = self.run_cli("tags", "--grep", "ai")
        self.assertIn("- AI (1)", out)
        self.assertNotIn("- 株", out)
        _, out, _ = self.run_cli("tags", "--grep", "優待", "生活")
        self.assertIn("- 優待 (1)", out)
        self.assertIn("- 生活 (1)", out)

    def test_無いときと_タグが1つも無いVault(self) -> None:
        _, out, _ = self.run_cli("tags", "--grep", "存在しない語")
        self.assertIn("該当するタグはありません", out)
        empty = self.tmp / "empty"
        (empty / ".obsidian").mkdir(parents=True)
        _, out, _ = self.run_cli("tags", cwd=empty)
        self.assertIn("まだタグがありません", out)


class RelatedTests(AdviceBase):
    def test_名前_タグ_本文の順に点数が付く(self) -> None:
        code, out, err = self.run_cli("related", "銘柄分析")
        self.assertEqual((code, err), (0, ""))
        first = out.index("[[銘柄分析_トヨタ]]")  # 名前 3 + タグ 2 = 5 (本文には語が無い)
        self.assertIn("点数 5 / 一致: 銘柄分析(名前・タグ)", out)
        self.assertIn("[[優待メモ]]", out)
        self.assertLess(first, out.index("[[優待メモ]]"))
        self.assertIn("本文: 本文に銘柄分析の語がある", out)
        self.assertIn("タグ: 株, 銘柄分析 / created: 2026-10-01 10:00:00", out)
        self.assertIn("対象 6 ノート", out, "図・テンプレート・.handoff は対象にしない")
        for hidden in ("図_全体", "テンプレ", "下書き"):
            self.assertNotIn(hidden, out)

    def test_複数語は点数が合算され_全角半角を区別しない(self) -> None:
        _, out, _ = self.run_cli("related", "ＡＩ", "洗濯")
        self.assertIn("[[生活]]", out)
        self.assertIn("一致: ＡＩ(タグ) 洗濯(本文)", out)

    def test_未レビューのAIのノートと_同名のノートに注意を付ける(self) -> None:
        _, out, _ = self.run_cli("related", "銘柄分析")
        self.assertIn("※ AI の未レビューのまとめ: リンクしない", out)
        self.assertIn("[[01_data/2026/09/01/同名]]", out, "同名があるときは、フォルダーつきのリンクにする")
        self.assertIn("同名のノートが 2 個ある", out)
        self.assertNotIn("[[同名]]", out)

    def test_件数を絞る_見つからないときは推測しない(self) -> None:
        _, out, _ = self.run_cli("related", "銘柄分析", "--limit", "1")
        self.assertIn("(上位 1 個)", out)
        self.assertEqual(out.count(". [["), 1)
        _, out, _ = self.run_cli("related", "存在しない語")
        self.assertIn("該当 0 個", out)
        self.assertIn("ノートを推測で作らない", out)

    def test_キーワードが無ければエラー_書き込みはしない(self) -> None:
        before = self.files()
        code, _, err = self.run_cli("related", " , ")
        self.assertEqual(code, 2)
        self.assertIn("キーワード", err)
        self.run_cli("related", "銘柄分析")
        self.run_cli("tags")
        self.assertEqual(self.files(), before)


class NewNoteAdviceTests(AdviceBase):
    def test_リンクが無ければ_関連を探すよう知らせる(self) -> None:
        _, out, _ = self.run_cli("new-note", "--title", "n", "--body-file", self.draft("# 検討\n\n結論: やる。\n"), "--tags", "株", "--dry-run")
        self.assertIn("注意: 本文に、ほかのノートへのリンクがありません", out)
        _, out, _ = self.run_cli("new-note", "--title", "n", "--body-file", self.draft("見る: [[優待メモ]]"), "--tags", "株", "--dry-run")
        self.assertNotIn("リンクがありません", out)

    def test_図や画像だけのリンクは_ノートへのリンクとは数えない(self) -> None:
        _, out, _ = self.run_cli("new-note", "--title", "n", "--body-file", self.draft("![[図_全体.excalidraw]]"), "--tags", "株", "--dry-run")
        self.assertIn("ほかのノートへのリンクがありません", out)

    def test_新しいタグは_似た既存のタグを示す(self) -> None:
        body = self.draft("[[優待メモ]]")
        _, out, _ = self.run_cli("new-note", "--title", "n", "--body-file", body, "--tags", "株,銘柄分析,銘柄分析メモ", "--dry-run")
        self.assertNotIn("タグです: '株'", out)
        self.assertNotIn("タグです: '銘柄分析'", out)
        self.assertIn("注意: 新しいタグです: '銘柄分析メモ' (Vault に無い)。似た既存のタグ: 銘柄分析 (1)", out)
        _, out, _ = self.run_cli("new-note", "--title", "n", "--body-file", body, "--tags", "まったく別の話", "--dry-run")
        self.assertIn("似た既存のタグも無い", out)

    def test_大文字小文字や全半角だけの違いは_既存の綴りを勧める(self) -> None:
        _, out, _ = self.run_cli("new-note", "--title", "n", "--body-file", self.draft("[[優待メモ]]"), "--tags", "ai,ＡＩ", "--dry-run")
        self.assertIn("タグ 'ai' は、既存の 'AI' と、大文字小文字・全半角だけが違います。'AI' を使う", out)
        self.assertIn("タグ 'ＡＩ' は、既存の 'AI' と", out)

    def test_タグが無ければ_既存のタグを探すよう知らせる_ただし作るのは止めない(self) -> None:
        code, out, _ = self.run_cli("new-note", "--title", "n", "--body-file", self.draft("[[優待メモ]]"))
        self.assertEqual(code, 0)
        self.assertIn("注意: タグがありません。`tags --grep 語`", out)
        self.assertTrue((self.vault / "01_data/2026/11/07/n.md").exists())

    def test_ノートもタグも無いVaultでは_何も言わない(self) -> None:
        empty = self.tmp / "empty"
        (empty / ".obsidian").mkdir(parents=True)
        (empty / ".handoff").mkdir()
        (empty / ".handoff/d.md").write_text("本文", encoding="utf-8")
        _, out, _ = self.run_cli("new-note", "--title", "n", "--body-file", ".handoff/d.md", "--dry-run", cwd=empty)
        self.assertNotIn("注意", out)


class SafetyTests(unittest.TestCase):
    def test_ソースに削除_実行_通信が無く_書き込み先が限られる(self) -> None:
        source = (SKILL_DIR / "scripts" / "vault_cli.py").read_text(encoding="utf-8")
        for needle in (".unlink(", "os.remove", "rmtree", "rmdir", "subprocess", "os.system", "urlopen", "socket", "eval(", "exec(", "rename(", "os.replace", ".replace(Path", "move("):
            self.assertNotIn(needle, source, f"vault_cli.py に {needle} があります")
        self.assertEqual(source.count(".write_text("), 1, "書き込みは new-note の 1 か所だけ")
        self.assertEqual(source.count(".write_bytes("), 1, "印の書き込みは mark-edit の 1 か所だけ")
        self.assertEqual(source.count("shutil.copy2("), 1, "コピーは backup の 1 か所だけ")


if __name__ == "__main__":
    unittest.main()
