"""
テキスト差分行番号の左右同期および追加行（A）・削除行（D）表示仕様テスト。

【仕様】
1. 左右の行番号同期:
   - 変更のない共通行（equal）および同一行数の置換行（replace）において、
     左右の行番号は完全に一致する通し番号（1, 2, 3...）を表示する。
2. 追加行の表示（A）:
   - 新規追加された行（insert）では、新側の行番号に "A"（Added）を表示し、旧側は None とする。
   - 通し行番号は消費（カウントアップ）しないため、後続の共通行の行番号は左右でズレずに一致する。
3. 削除行の表示（D）:
   - 削除された行（delete）では、旧側の行番号に "D"（Deleted）を表示し、新側は None とする。
   - 通し行番号は消費（カウントアップ）しないため、後続の共通行の行番号は左右でズレずに一致する。
4. Excalidraw埋め込みMarkdown対応:
   - Excalidrawデータ行を除外したテキストDiffにおいても、上記と同一の同期仕様を適用する。
"""

from __future__ import annotations

import unittest
from backend.app.main import _build_markdown_text_diff_rows, _build_text_diff_rows


class TestTextDiffLineNumbers(unittest.TestCase):
    def test_equal_lines_have_same_number(self):
        """共通行において、左右の行番号が1から順に同一の数値であること。"""
        old_text = "line1\nline2\nline3\n"
        new_text = "line1\nline2\nline3\n"
        rows = _build_text_diff_rows(old_text, new_text)

        self.assertEqual(len(rows), 3)
        for i, row in enumerate(rows, start=1):
            self.assertEqual(row["kind"], "equal")
            self.assertEqual(row["old_number"], i)
            self.assertEqual(row["new_number"], i)

    def test_insert_lines_have_A_and_keep_subsequent_numbers_aligned(self):
        """
        追加された行（insert）の new_number は 'A'、old_number は None であり、
        追加行を挟んだ後の共通行も左右で同一の行番号が継続すること。
        """
        old_text = "line1\nline2\nline3\n"
        new_text = "line1\nline2\nnew_a\nnew_b\nline3\n"
        rows = _build_text_diff_rows(old_text, new_text)

        # row 0: line1 (equal)
        self.assertEqual(rows[0]["kind"], "equal")
        self.assertEqual(rows[0]["old_number"], 1)
        self.assertEqual(rows[0]["new_number"], 1)

        # row 1: line2 (equal)
        self.assertEqual(rows[1]["kind"], "equal")
        self.assertEqual(rows[1]["old_number"], 2)
        self.assertEqual(rows[1]["new_number"], 2)

        # row 2: new_a (insert)
        self.assertEqual(rows[2]["kind"], "insert")
        self.assertIsNone(rows[2]["old_number"])
        self.assertEqual(rows[2]["new_number"], "A")

        # row 3: new_b (insert)
        self.assertEqual(rows[3]["kind"], "insert")
        self.assertIsNone(rows[3]["old_number"])
        self.assertEqual(rows[3]["new_number"], "A")

        # row 4: line3 (equal) -> 左右ともに 3 で揃うこと！
        self.assertEqual(rows[4]["kind"], "equal")
        self.assertEqual(rows[4]["old_number"], 3)
        self.assertEqual(rows[4]["new_number"], 3)

    def test_delete_lines_have_D_and_keep_subsequent_numbers_aligned(self):
        """
        削除された行（delete）の old_number は 'D'、new_number は None であり、
        削除行を挟んだ後の共通行も左右で同一の行番号が継続すること。
        """
        old_text = "line1\nline2\ndel_a\ndel_b\nline3\n"
        new_text = "line1\nline2\nline3\n"
        rows = _build_text_diff_rows(old_text, new_text)

        # row 0: line1 (equal)
        self.assertEqual(rows[0]["kind"], "equal")
        self.assertEqual(rows[0]["old_number"], 1)
        self.assertEqual(rows[0]["new_number"], 1)

        # row 1: line2 (equal)
        self.assertEqual(rows[1]["kind"], "equal")
        self.assertEqual(rows[1]["old_number"], 2)
        self.assertEqual(rows[1]["new_number"], 2)

        # row 2: del_a (delete)
        self.assertEqual(rows[2]["kind"], "delete")
        self.assertEqual(rows[2]["old_number"], "D")
        self.assertIsNone(rows[2]["new_number"])

        # row 3: del_b (delete)
        self.assertEqual(rows[3]["kind"], "delete")
        self.assertEqual(rows[3]["old_number"], "D")
        self.assertIsNone(rows[3]["new_number"])

        # row 4: line3 (equal) -> 左右ともに 3 で揃うこと！
        self.assertEqual(rows[4]["kind"], "equal")
        self.assertEqual(rows[4]["old_number"], 3)
        self.assertEqual(rows[4]["new_number"], 3)

    def test_replace_lines_and_alignment(self):
        """
        1対1の置換行は左右同一の番号を保ち、行数が増える置換では余剰行が 'A'、
        後続行が左右一致すること。
        """
        old_text = "line1\nmod_old\nline3\n"
        new_text = "line1\nmod_new1\nmod_new2\nline3\n"
        rows = _build_text_diff_rows(old_text, new_text)

        # row 0: line1 (equal) -> 1, 1
        self.assertEqual(rows[0]["old_number"], 1)
        self.assertEqual(rows[0]["new_number"], 1)

        # row 1: mod_old -> mod_new1 (replace) -> 2, 2
        self.assertEqual(rows[1]["kind"], "replace")
        self.assertEqual(rows[1]["old_number"], 2)
        self.assertEqual(rows[1]["new_number"], 2)

        # row 2: None -> mod_new2 (insert) -> None, "A"
        self.assertEqual(rows[2]["kind"], "insert")
        self.assertIsNone(rows[2]["old_number"])
        self.assertEqual(rows[2]["new_number"], "A")

        # row 3: line3 (equal) -> 3, 3
        self.assertEqual(rows[3]["kind"], "equal")
        self.assertEqual(rows[3]["old_number"], 3)
        self.assertEqual(rows[3]["new_number"], 3)

    def test_markdown_embedded_excalidraw_line_numbers(self):
        """Excalidraw埋め込み行を含むMarkdownでも同様に行番号が揃い、A/Dが表示されること。"""
        old_text = "title\n# Excalidraw Data\n```json\n{}\n```\nline2\n"
        new_text = "title\nnew_line\n# Excalidraw Data\n```json\n{}\n```\nline2\n"
        rows = _build_markdown_text_diff_rows(old_text, new_text)

        # row 0: title (equal) -> 1, 1
        self.assertEqual(rows[0]["kind"], "equal")
        self.assertEqual(rows[0]["old_number"], 1)
        self.assertEqual(rows[0]["new_number"], 1)

        # row 1: new_line (insert) -> None, "A"
        self.assertEqual(rows[1]["kind"], "insert")
        self.assertIsNone(rows[1]["old_number"])
        self.assertEqual(rows[1]["new_number"], "A")

        # row 2: line2 (equal) -> 2, 2 (Excalidraw部分は除外され、タイトル直後の共通行として2で揃う)
        self.assertEqual(rows[2]["kind"], "equal")
        self.assertEqual(rows[2]["old_number"], 2)
        self.assertEqual(rows[2]["new_number"], 2)


if __name__ == "__main__":
    unittest.main()
