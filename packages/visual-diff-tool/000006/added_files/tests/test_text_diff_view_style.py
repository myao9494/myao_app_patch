"""
テキスト差分表示スタイルと折り返しセルのレイアウトの回帰テスト（過去の表示崩れの再発防止）。

【仕様】
1. 追加行・削除行は明るい緑／赤の背景に黒文字（#000000）で表示し、白文字にしない。
   code 要素の背景は透明にして、セルの背景色が必ず見えるようにする。
2. 長い行の折り返しで下の行と重ならないこと:
   - 親グリッド .text-diff-columns は grid-auto-rows: max-content（minmax(24px, auto) は24pxに固定される）
   - 各セル .diff-code-cell は display: flex で中身の高さに伸び、height: 100% を指定しない
   - 行エディタは、通常フローの不可視サイザー（.diff-line-sizer）が折り返し行数ぶん高さを押し広げ、
     その上に絶対配置の textarea（.diff-line-editor）を重ねて同じ高さに追従させる
"""

import re
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
STYLES_CSS = ROOT_DIR / "frontend" / "src" / "styles.css"
TEXT_DIFF_VIEW_JSX = ROOT_DIR / "frontend" / "src" / "git" / "TextDiffView.jsx"


class TestTextDiffViewStyle(unittest.TestCase):
    def setUp(self):
        self.css_content = STYLES_CSS.read_text(encoding="utf-8")
        self.jsx_content = TEXT_DIFF_VIEW_JSX.read_text(encoding="utf-8")

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
