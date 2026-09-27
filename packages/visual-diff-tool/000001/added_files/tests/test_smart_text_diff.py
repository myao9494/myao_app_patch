"""
PythonコードおよびMarkdownファイル向けスマートテキストDiffの動作検証テスト。
単語・トークン単位のインライン差分（Word-level Diff）と、
見出し・関数定義などのアンカー行を優先した自然な行マッチングを検証する。
"""

import unittest
from backend.app.main import (
    _build_markdown_text_diff_rows,
    _build_text_diff_rows,
    _inline_diff_segments,
)


class TestSmartTextDiff(unittest.TestCase):
    def test_python_token_level_inline_diff(self):
        """
        Pythonコードの変更において、文字単位で細切れにならず、
        変数名・識別子単位（トークン単位）で綺麗に差分セグメントが生成されることを検証する。
        """
        old_line = "def calculate_total_amount(order_item):"
        new_line = "def calculate_final_amount(order_item):"

        old_segs = _inline_diff_segments(old_line, new_line, "old")
        new_segs = _inline_diff_segments(old_line, new_line, "new")

        # 変更されたセグメントのテキストを抽出
        old_changed = [s["text"] for s in old_segs if s["changed"]]
        new_changed = [s["text"] for s in new_segs if s["changed"]]

        # 単語丸ごと（calculate_total_amount / calculate_final_amount）が変更対象として認識されること
        self.assertEqual(old_changed, ["calculate_total_amount"])
        self.assertEqual(new_changed, ["calculate_final_amount"])

        # 共通部分（def, 空白, (order_item):）は変更なし（changed: False）であること
        old_unchanged = "".join(s["text"] for s in old_segs if not s["changed"])
        self.assertIn("def ", old_unchanged)
        self.assertIn("(order_item):", old_unchanged)

    def test_japanese_markdown_word_level_inline_diff(self):
        """
        日本語Markdown文章において、1文字ずつではなく、
        単語（漢字・カタカナ・ひらがなの塊）単位で差分が綺麗に抽出されることを検証する。
        """
        old_line = "今日は晴天でした。"
        new_line = "明日は大雨でした。"

        old_segs = _inline_diff_segments(old_line, new_line, "old")
        new_segs = _inline_diff_segments(old_line, new_line, "new")

        old_changed = [s["text"] for s in old_segs if s["changed"]]
        new_changed = [s["text"] for s in new_segs if s["changed"]]

        # 「今日」->「明日」、「晴天」->「大雨」がそれぞれ単語単位で変更として認識されること
        self.assertEqual(old_changed, ["今日", "晴天"])
        self.assertEqual(new_changed, ["明日", "大雨"])

    def test_markdown_heading_anchor_preservation(self):
        """
        Markdownで見出しの直下に段落が挿入された場合、
        見出し行同士（# 見出し）がアンカーとして保護され、本文と入れ替わらず正しく一致（equal）することを検証する。
        """
        old_text = (
            "# はじめに\n"
            "最初の段落です。\n\n"
            "## 概要\n"
            "概要の説明です。\n"
        )
        new_text = (
            "# はじめに\n"
            "挿入された新しい段落です。\n\n"
            "最初の段落です。\n\n"
            "## 概要\n"
            "概要の説明です。\n"
        )

        rows = _build_markdown_text_diff_rows(old_text, new_text)

        # 見出し行「# はじめに」と「## 概要」が正しく kind == 'equal' として対応していること
        heading_rows = [r for r in rows if r.get("old") and r["old"].startswith("#")]
        for hr in heading_rows:
            self.assertEqual(hr["kind"], "equal", f"見出し {hr['old']} が equal ではなく {hr['kind']} になりました")
            self.assertEqual(hr["old"], hr["new"])

    def test_python_function_anchor_preservation(self):
        """
        Pythonスクリプトに関数が追加・修正された際、
        関数定義行（def foo():）がアンカーとして保護され、正しく位置合わせされることを検証する。
        """
        old_code = (
            "def alpha():\n"
            "    return 1\n\n"
            "def beta():\n"
            "    return 2\n"
        )
        new_code = (
            "def alpha():\n"
            "    # コメント追加\n"
            "    return 1\n\n"
            "def beta():\n"
            "    return 2\n"
        )

        rows = _build_text_diff_rows(old_code, new_code)
        beta_rows = [r for r in rows if r.get("old") == "def beta():"]
        self.assertEqual(len(beta_rows), 1)
        self.assertEqual(beta_rows[0]["kind"], "equal")


if __name__ == "__main__":
    unittest.main()
