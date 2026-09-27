"""
テキスト差分表示スタイルと折り返しセルのレイアウト検証テスト。

【仕様】
1. 追加行（added / insert / replace-new）:
   - 背景は視認性の高いグリーン背景とし、文字色は黒文字（#000000）で表示する。
   - インライン変更箇所（mark.changed）も濃いグリーン背景＋黒文字（#000000）で表示する。
2. 削除行（removed / delete / replace-old）:
   - 背景は視認性の高いレッド背景とし、文字色は黒文字（#000000）で表示する。
   - インライン変更箇所（mark.changed）も濃いレッド背景＋黒文字（#000000）で表示する。
3. 複数行折り返し時のセルの重なり防止（CSS Grid オーバーレイ設計）:
   - .diff-line-editor-wrap を CSS Grid 重ね合わせ（grid-template-columns: 100% / rows: 100%）とし、
     .diff-line-highlight と .diff-line-editor を同一グリッドセル（grid-area: 1 / 1 / 2 / 2）に配置する。
   - .diff-line-highlight を通常フローのブロック要素としてテキスト行数に応じて自然に高さを押し広げさせ、
     textarea はその広がった高さに完全に追従することで、下の行との重なりを物理的に防止する。
   - 空行や末尾改行時にも正確な高さを保つため、ゼロ幅スペース（\\u200B）を出力に含める。
"""

import re
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
STYLES_CSS = ROOT_DIR / "frontend" / "src" / "styles.css"
MAIN_JSX = ROOT_DIR / "frontend" / "src" / "main.jsx"


class TestTextDiffViewStyle(unittest.TestCase):
    def setUp(self):
        self.css_content = STYLES_CSS.read_text(encoding="utf-8")
        self.jsx_content = MAIN_JSX.read_text(encoding="utf-8")

    def test_added_and_removed_lines_have_black_text(self):
        """
        追加行（added）と削除行（removed）において、
        背景に対する文字色が黒文字（#000000）であり、見づらい白文字（#ffffff）になっていないこと、
        およびcode要素の背景が透明（transparent）で親セルの緑/赤背景を透過させることを検証する。
        """
        # .diff-code-cell.added code の文字色が #000000 であること
        self.assertRegex(
            self.css_content,
            r"\.diff-code-cell\.added\s+code[^{]*\{[^}]*color:\s*#000000",
            "追加行のコード文字色は黒文字（#000000）である必要があります",
        )
        # .diff-code-cell.removed code の文字色が #000000 であること
        self.assertRegex(
            self.css_content,
            r"\.diff-code-cell\.removed\s+code[^{]*\{[^}]*color:\s*#000000",
            "削除行のコード文字色は黒文字（#000000）である必要があります",
        )
        # .diff-code-cell code が background: transparent !important であること
        self.assertRegex(
            self.css_content,
            r"\.diff-code-cell\s+code\s*\{[^}]*background:\s*transparent\s*!important",
            ".diff-code-cell code は親セルの背景を透過させるために background: transparent !important である必要があります",
        )
        # .diff-line-editor（入力欄）のテキスト色も黒文字であること
        self.assertRegex(
            self.css_content,
            r"\.diff-code-cell\.added\s+\.diff-line-editor[^{]*\{[^}]*color:\s*#000000",
            "追加行のエディタ文字色は黒文字（#000000）である必要があります",
        )

    def test_diff_line_editor_grid_overlay_for_multiline_wrap(self):
        """
        折り返し時のセル重なりを防ぐため、.diff-code-cell が display: flex で自然な高さを持ち、
        .diff-code-cell に固定 height: 100% がなく、.diff-line-sizer が存在することを検証する。
        """
        # .diff-code-cell が display: flex であること
        self.assertRegex(
            self.css_content,
            r"\.diff-code-cell\s*\{[^}]*display:\s*flex",
            ".diff-code-cell は中身の高さに応じて自動拡張するために display: flex である必要があります",
        )
        # .diff-line-sizer が定義されていること
        self.assertIn(".diff-line-sizer", self.css_content)
        # .diff-code-cell に height: 100% が指定されていないこと（auto拡張を阻害するため）
        cell_match = re.search(r"\.diff-code-cell\s*\{([^}]+)\}", self.css_content)
        self.assertIsNotNone(cell_match)
        self.assertNotIn("height: 100%", cell_match.group(1))

    def test_grid_auto_rows_allows_multiline_expansion(self):
        """
        CSS Grid の親コンテナ .text-diff-columns の grid-auto-rows が
        minmax(24px, auto) だと折り返し時に24pxに固定される問題を防ぐため、
        grid-auto-rows: max-content （または auto）が指定されていることを検証する。
        """
        grid_match = re.search(r"\.text-diff-columns\s*\{([^}]+)\}", self.css_content)
        self.assertIsNotNone(grid_match, ".text-diff-columns のスタイル定義が存在すること")
        body = grid_match.group(1)
        self.assertIn("grid-auto-rows: max-content;", body, "折り返しセルを拡張可能にするため grid-auto-rows: max-content; を指定する必要があります")
        self.assertNotIn("minmax(24px, auto)", body, "minmax(24px, auto) はBlink系ブラウザで高さを24pxに固定してしまうため使用しないでください")

    def test_sizer_element_in_editor(self):
        """
        Reactコンポーネント（DiffLineEditor）内に、高さを自動拡張するための不可視サイザー（diff-line-sizer）が含まれていることを検証する。
        """
        self.assertIn("diff-line-sizer", self.jsx_content)


if __name__ == "__main__":
    unittest.main()
