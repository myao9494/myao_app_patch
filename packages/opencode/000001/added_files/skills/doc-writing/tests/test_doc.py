"""doc_cli のテスト。実行: python -m unittest discover -s skills/doc-writing/tests -v   (リポジトリのルートから)"""
from __future__ import annotations

import io
import sys
import tempfile
import unittest
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR / "scripts"))

import doc_cli as cli  # noqa: E402

TERMS = """# 用語の表

| 用語 | 定義 | 使わない言い方 | 値 | 出典 |
|---|---|---|---|---|
| 締付トルク | ボルトを締める回転の力 | 締め付けトルク、トルク値 | 25 N·m | 作業標準.pdf p.4 |
| 作業票 | 作業の記録 | 作業シート | | 規程 3 条 |

<!--
| 例 | 例 | 用語の表 | | |
-->
"""


class DocTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.cwd = Path(self._tmp.name).resolve()

    def run_cli(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        code = cli.main(list(argv), stdout=out, stderr=err, cwd=self.cwd)
        return code, out.getvalue(), err.getvalue()

    def make(self, sections: dict[str, str], terms: str = TERMS, style: str = "である") -> Path:
        self.assertEqual(self.run_cli("init", "締付の手順", "--title", "締付の作業手順書")[0], 0)
        folder = self.cwd / ".handoff" / "doc_締付の手順"
        outline = "# 締付の作業手順書\n\n- 文体: " + style + "\n\n## 目次\n\n" + "".join(f"- {name}: 要点\n" for name in sections)
        (folder / "outline.md").write_text(outline, encoding="utf-8")
        (folder / "terms.md").write_text(terms, encoding="utf-8")
        for name, text in sections.items():
            if text is not None:
                (folder / name).write_text(text, encoding="utf-8")
        return folder

    def test_initはひな形を作り_上書きしない(self) -> None:
        code, out, _ = self.run_cli("init", "締付の手順")
        self.assertEqual(code, 0, out)
        folder = self.cwd / ".handoff" / "doc_締付の手順"
        self.assertIn("- 01_概要.md:", (folder / "outline.md").read_text(encoding="utf-8"))
        self.assertIn("| 用語 | 定義 |", (folder / "terms.md").read_text(encoding="utf-8"))
        self.assertEqual(self.run_cli("init", "締付の手順")[0], 2)
        self.assertEqual(self.run_cli("init", "../外")[0], 0)  # 話題の / は _ になり、外へ出ない
        self.assertTrue((self.cwd / ".handoff" / "doc_外").is_dir())

    def test_ひな形のままでも_用語の例の行は検査しない(self) -> None:
        self.run_cli("init", "a")
        code, out, _ = self.run_cli("check", ".handoff/doc_a")
        self.assertEqual(code, 0, out)
        self.assertIn("まだ無い節: 01_概要.md", out)
        self.assertIn("用語 0", out)

    def test_よい節は合格し_joinで目次の順につなぐ(self) -> None:
        folder = self.make({
            "01_概要.md": "## 概要\n\n締付トルクは 25 N·m とする。\n\n出典: 作業標準.pdf p.4\n",
            "02_手順.md": "## 手順\n\n1. 作業票を用意する。\n2. ボルトを締める。\n   締付トルクは25N·mである。\n\n> 注: 締めすぎない。\n\n3. 作業票に記録する。\n\n出典: 作業標準.pdf p.5\n",
        })
        code, out, _ = self.run_cli("check", ".handoff/doc_締付の手順")
        self.assertEqual(code, 0, out)
        self.assertIn("結果: 合格 (問題 0 件、注意 0 件、未確認の残り 0 件)", out)
        code, out, _ = self.run_cli("join", ".handoff/doc_締付の手順", "--with-title")
        self.assertEqual(code, 0, out)
        draft = (folder / "draft.md").read_text(encoding="utf-8")
        self.assertTrue(draft.startswith("# 締付の作業手順書\n\n## 概要"))
        self.assertLess(draft.index("## 概要"), draft.index("## 手順"))
        self.run_cli("join", ".handoff/doc_締付の手順")
        self.assertTrue((folder / "draft_2.md").exists())  # 上書きしない

    def test_用語_値_出典_番号_文体の問題を見つける(self) -> None:
        self.make({
            "01_概要.md": "## 概要\n\n締め付けトルクを確かめる。締付トルクは 30 N·m とする。「トルク値は 30」と書かれていた。\n\n`作業シート` はコードなので数えない。\n",
            "02_手順.md": "## 手順\n\n1. 作業シートを用意します。\n2. 締める。\n4. 記録する。\n\n出典: 作業標準.pdf p.5\n",
        })
        code, out, _ = self.run_cli("check", ".handoff/doc_締付の手順")
        self.assertEqual(code, 1)
        self.assertIn("01_概要.md:3: 「締め付けトルク」は使わない言い方です", out)
        self.assertIn("01_概要.md:3: 締付トルク の値が 30 です (用語の表: 25 N·m)", out)
        self.assertNotIn("「トルク値」は使わない", out)  # 「」の引用は原文どおりなので見ない
        self.assertNotIn("01_概要.md:5", out)
        self.assertIn("01_概要.md: 出典がありません", out)
        self.assertIn("02_手順.md:3: 「作業シート」は使わない言い方です", out)
        self.assertIn("02_手順.md:5: 手順の番号が飛んでいます (2. の次が 4.)", out)
        self.assertIn("02_手順.md:3: です・ます調の文があります", out)

    def test_推敲の後の最終稿だけを検査する(self) -> None:
        folder = self.make({"01_概要.md": "## 概要\n\n締付トルクは 25 N·m とする。\n\n出典: a.pdf\n"})
        (folder / "polish_draft.md").write_text("## 概要\n\n締め付けトルクは 30 N·m です。\n\n出典: a.pdf\n", encoding="utf-8")
        code, out, _ = self.run_cli("check", ".handoff/doc_締付の手順", "--file", "polish_draft.md")
        self.assertEqual(code, 1)
        self.assertIn("polish_draft.md だけ", out)
        self.assertIn("「締め付けトルク」は使わない言い方です", out)
        self.assertIn("です・ます調の文があります", out)
        self.assertNotIn("目次 (outline.md) にありません", out)
        self.assertEqual(self.run_cli("check", ".handoff/doc_締付の手順", "--file", "../外.md")[0], 2)

    def test_目次に無い節_まだ無い節_未確認の残り(self) -> None:
        folder = self.make({"01_概要.md": "## 概要\n\n手順は未確認である。\n\n出典: a.pdf\n", "02_手順.md": None})
        (folder / "03_おまけ.md").write_text("x\n", encoding="utf-8")
        code, out, _ = self.run_cli("check", ".handoff/doc_締付の手順")
        self.assertEqual(code, 1)
        self.assertIn("03_おまけ.md: 目次 (outline.md) にありません", out)
        self.assertIn("まだ無い節: 02_手順.md", out)
        self.assertIn("01_概要.md:3: 手順は未確認である。", out)
        (folder / "03_おまけ.md").rename(folder / "おまけ.txt")
        self.assertEqual(self.run_cli("check", ".handoff/doc_締付の手順")[0], 0)  # 書きかけは、注意だけ
        code, out, _ = self.run_cli("join", ".handoff/doc_締付の手順")
        self.assertEqual(code, 1)  # つなぐときは、全部の節が要る
        self.assertIn("問題があるので、つなぎませんでした", out)
        self.assertFalse((folder / "draft.md").exists())

    def test_です調の文書(self) -> None:
        self.make({"01_概要.md": "## 概要\n\nこれは手順書です。締付は重要である。\n\n出典: a.pdf\n"}, style="です・ます")
        _, out, _ = self.run_cli("check", ".handoff/doc_締付の手順")
        self.assertIn("である調の文があります (目次の文体: です・ます): …締付は重要である。", out)
        self.assertNotIn("これは手順書です", out)

    def test_Vaultのリンクと_未レビューのAIのノート(self) -> None:
        (self.cwd / ".obsidian").mkdir()
        (self.cwd / "01_data").mkdir()
        (self.cwd / "01_data" / "原典.md").write_text("本文\n", encoding="utf-8")
        (self.cwd / "01_data" / "AIのまとめ.md").write_text("---\nai_generated: opencode\nai_reviewed: false\n---\n本文\n", encoding="utf-8")
        (self.cwd / "01_data" / "レビュー済.md").write_bytes("---\r\nai_generated: opencode\r\nai_reviewed: true\r\n---\r\n本文\r\n".encode("utf-8"))
        (self.cwd / "01_data" / "直した.md").write_text("---\nai_edited: 2026-11-08 10:00:00\nai_reviewed: false\n---\n本文\n", encoding="utf-8")
        self.make({"01_概要.md": "## 概要\n\n[[原典]] と [[AIのまとめ]] と [[レビュー済]] と [[直した]] と [[無いノート]] による。\n", "02_図.md": "## 図\n\n![[原典]]\n"})
        code, out, _ = self.run_cli("check", ".handoff/doc_締付の手順")
        self.assertEqual(code, 1)
        self.assertIn("未レビューの AI のノートを出典にしています: [[AIのまとめ]]", out)
        self.assertIn("リンク先が Vault にありません: [[無いノート]]", out)
        self.assertNotIn("[[原典]]", out)
        self.assertNotIn("[[レビュー済]]", out)
        self.assertNotIn("[[直した]]", out)  # AI が直しただけのノートは、根拠に使ってよい
        self.assertNotIn("01_概要.md: 出典がありません", out)  # リンクがあれば出典あり
        self.assertIn("02_図.md: 出典がありません", out)  # 埋め込みは出典に数えない

    def test_フォルダは_handoffの中だけ(self) -> None:
        (self.cwd / "doc_x").mkdir()
        (self.cwd / "doc_x" / "outline.md").write_text("- 01_a.md\n", encoding="utf-8")
        for bad in ("doc_x", ".handoff", "無い"):
            (self.cwd / ".handoff").mkdir(exist_ok=True)
            code, _, err = self.run_cli("check", bad)
            self.assertEqual(code, 2, bad)

    def test_削除_実行_通信をしない(self) -> None:
        source = (SKILL_DIR / "scripts" / "doc_cli.py").read_text(encoding="utf-8")
        for needle in (".unlink(", "os.remove", "rmtree", "rmdir", "subprocess", "os.system", "urlopen", "socket", "eval(", "exec(", ".rename(", "os.replace"):
            self.assertNotIn(needle, source, needle)


if __name__ == "__main__":
    unittest.main()
