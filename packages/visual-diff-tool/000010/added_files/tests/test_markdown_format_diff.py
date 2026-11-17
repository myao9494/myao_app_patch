"""
Markdown のテキスト差分で「書式の違いを無視」したときのテスト（text_diff.py の ignore_format）。
- 空白（行頭・行中・全角・表の位置合わせ）、空行の追加・削除、箇条書き記号の種類、番号の振り直し、
  強調の記号（_ と *）、区切り線の書き方、末尾の改行は kind "format"（変更として扱わない）
- 行末の空白（改行の意味がある）、見出しのレベル、記号の有無、チェックボックスは変更のまま
- フロントマターとコードブロックの中は書式に意味があるので、空白の違いも変更のまま
- API は ignore_format を Markdown のときだけ効かせ、1行復元も同じ規則で照合する
"""

import subprocess
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.text_diff import build_markdown_text_diff_rows, inline_diff_pair


def kinds(old: str, new: str, **kwargs) -> list[str]:
    return [row["kind"] for row in build_markdown_text_diff_rows(old, new, ignore_format=True, **kwargs)]


class TestMarkdownFormatRows(unittest.TestCase):
    def assert_format_only(self, old: str, new: str):
        result = kinds(old, new)
        self.assertIn("format", result, (old, new))
        self.assertTrue(all(kind in {"equal", "format"} for kind in result), (old, new, result))

    def assert_changed(self, old: str, new: str):
        result = kinds(old, new)
        self.assertTrue(any(kind in {"replace", "insert", "delete"} for kind in result), (old, new, result))

    def test_whitespace_differences_are_format(self):
        self.assert_format_only("  indented\n", "indented\n")
        self.assert_format_only("\tindented\n", "    indented\n")
        self.assert_format_only("a  b\n", "a b\n")
        self.assert_format_only("日本語 English\n", "日本語English\n")
        self.assert_format_only("全角\u3000空白\n", "全角空白\n")
        self.assert_format_only("|a|b|\n|-|-|\n", "| a | b |\n| - | - |\n")
        self.assert_format_only(">quote\n", "> quote\n")

    def test_blank_lines_are_format_and_keep_alignment(self):
        rows = build_markdown_text_diff_rows("# T\n- a\n- b\n", "# T\n\n- a\n- b\n\n", ignore_format=True)
        self.assertEqual([row["kind"] for row in rows], ["equal", "format", "equal", "equal", "format"])
        self.assertEqual(rows[1]["old"], None)
        self.assertEqual(rows[1]["new_number"], "A")
        # 共通行の番号は空行の追加でずれない
        self.assertEqual([row["old_number"] for row in rows if row["kind"] == "equal"], [1, 2, 3])
        # 空行を消した側も書式の行
        self.assertEqual(kinds("a\n\n\nb\n", "a\nb\n"), ["equal", "format", "format", "equal"])

    def test_marker_styles_are_format(self):
        self.assert_format_only("- a\n* b\n+ c\n", "* a\n- b\n- c\n")
        self.assert_format_only("1. one\n2. two\n", "3) one\n1. two\n")
        self.assert_format_only("_em_ and __strong__\n", "*em* and **strong**\n")
        self.assert_format_only("---\n", "***\n")
        self.assert_format_only("- - -\n", "___\n")
        self.assert_format_only("  - nested\n", "    * nested\n")
        self.assert_format_only("> - quoted item\n", ">* quoted item\n")

    def test_terminal_newline_is_format(self):
        self.assertEqual(kinds("a\n", "a"), ["equal", "format"])

    def test_meaningful_changes_stay_changes(self):
        self.assert_changed("hard  \n", "hard\n")  # 行末の空白2つは改行
        self.assert_changed("# a\n", "## a\n")
        self.assert_changed("a\n", "- a\n")
        self.assert_changed("a\n", "# a\n")
        self.assert_changed("# a\n", "#a\n")  # Obsidian のタグになる
        self.assert_changed("- a\n", "1. a\n")
        self.assert_changed("- [ ] task\n", "- [x] task\n")
        self.assert_changed("old text\n", "new text\n")

    def test_front_matter_and_code_blocks_compare_exactly(self):
        self.assert_changed("---\ntags:\n  - a\n---\nbody\n", "---\ntags:\n- a\n---\nbody\n")
        self.assert_changed("```python\nif x:\n    y()\n```\n", "```python\nif x:\ny()\n```\n")
        self.assert_changed("~~~\n- a\n~~~\n", "~~~\n* a\n~~~\n")
        # コードブロックの後は、また書式を無視する
        self.assert_format_only("```\ncode\n```\n- a\n", "```\ncode\n```\n* a\n")

    def test_format_rows_have_exact_highlight_and_no_revert_kind(self):
        row = build_markdown_text_diff_rows("* item\n", "- item\n", ignore_format=True)[0]
        self.assertEqual(row["kind"], "format")
        self.assertEqual(row["old_number"], 1)
        self.assertEqual(row["new_number"], 1)
        self.assertTrue(any(segment["changed"] for segment in row["old_segments"]))

    def test_changed_rows_do_not_highlight_format(self):
        old_segments, new_segments = inline_diff_pair("- foo  bar", "* foo baz", ignore_format=True)
        self.assertEqual([s["text"] for s in old_segments if s["changed"]], ["bar"])
        self.assertEqual([s["text"] for s in new_segments if s["changed"]], ["baz"])
        old_segments, _ = inline_diff_pair("hard  ", "hard", ignore_format=True)
        self.assertEqual([s["text"] for s in old_segments if s["changed"]], ["  "])

    def test_line_indexes_point_to_the_original_lines(self):
        old = "a\nb\nc\n"
        new = "a\n\nB\nc\n"
        rows = build_markdown_text_diff_rows(old, new, ignore_format=True)
        replace = next(row for row in rows if row["kind"] == "replace")
        self.assertEqual((replace["old_index"], replace["new_index"]), (1, 2))
        inserted = next(row for row in rows if row["kind"] == "format")
        self.assertEqual(inserted["new_index"], 1)

    def test_default_is_exact(self):
        self.assertEqual(
            [row["kind"] for row in build_markdown_text_diff_rows("* a\n", "- a\n")],
            ["replace"],
        )


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True)


class TestMarkdownFormatApi(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp_dir.name)
        _git(self.repo, "init", "--quiet")
        _git(self.repo, "config", "user.email", "test@example.com")
        _git(self.repo, "config", "user.name", "Tester")

    def tearDown(self):
        self.temp_dir.cleanup()

    def _commit(self, name: str, content: bytes) -> Path:
        path = self.repo / name
        path.write_bytes(content)
        _git(self.repo, "add", name)
        _git(self.repo, "commit", "--quiet", "-m", f"add {name}")
        return path

    def _payload(self, name: str, **extra) -> dict:
        return {"folder": str(self.repo), "path": name, "head_path": name, "text_extensions": [".md", ".txt"], **extra}

    def test_item_ignores_format_only_for_markdown(self):
        self._commit("note.md", b"* a\n")
        self._commit("note.txt", b"* a\n")
        (self.repo / "note.md").write_bytes(b"- a\n")
        (self.repo / "note.txt").write_bytes(b"- a\n")
        md = self.client.post("/api/git/item", json=self._payload("note.md", ignore_format=True)).json()
        txt = self.client.post("/api/git/item", json=self._payload("note.txt", ignore_format=True)).json()
        exact = self.client.post("/api/git/item", json=self._payload("note.md")).json()
        self.assertEqual([row["kind"] for row in md["rows"]], ["format"])
        self.assertEqual([row["kind"] for row in txt["rows"]], ["replace"])
        self.assertEqual([row["kind"] for row in exact["rows"]], ["replace"])

    def test_text_diff_and_revert_use_same_rule(self):
        path = self._commit("note.md", b"a\nb\n")
        path.write_bytes(b"a\n\nB\n")
        preview = self.client.post("/api/git/text-diff", json=self._payload("note.md", text="a\n\nB\n", ignore_format=True))
        self.assertEqual(preview.status_code, 200, preview.text)
        row = next(row for row in preview.json()["rows"] if row["kind"] == "replace")
        reverted = self.client.post("/api/git/revert-line", json=self._payload("note.md", row=row, ignore_format=True))
        self.assertEqual(reverted.status_code, 200, reverted.text)
        self.assertEqual(path.read_bytes(), b"a\n\nb\n")
        self.assertEqual([r["kind"] for r in reverted.json()["rows"]], ["equal", "format", "equal"])


if __name__ == "__main__":
    unittest.main()
