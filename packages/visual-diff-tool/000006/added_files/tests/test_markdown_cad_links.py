"""
Markdownファイル内のCADコードブロック（```step / ```cad 等）およびSTEPリンク解決のテスト
"""

import tempfile
import unittest
from pathlib import Path

from backend.app.markdown_links import (
    extract_markdown_links,
    related_markdown_paths,
)


class TestMarkdownCadLinks(unittest.TestCase):
    def test_extract_step_code_block_links(self):
        """```step や ```cad コードブロック内の path: / file: から STEP ファイルを抽出できること"""
        md_text = """
---
created: 2026-10-06
---
```step
path: 01_data/2026/10/06/CBES (50kg to 2000kg).step
width: 908
height: 629
view: custom
```

```cad
path: models/bracket_v2.stp
width: 800
```

```3d
file: parts/housing.step
```

![[drawings/gear.step]]
[Link](components/shaft.step)
"""
        links = extract_markdown_links(md_text)
        self.assertIn("01_data/2026/10/06/CBES (50kg to 2000kg).step", links)
        self.assertIn("models/bracket_v2.stp", links)
        self.assertIn("parts/housing.step", links)
        self.assertIn("drawings/gear.step", links)
        self.assertIn("components/shaft.step", links)

    def test_resolve_step_link_in_repo(self):
        """リポジトリ内のSTEPファイルへのパスが正しく解決されること"""
        with tempfile.TemporaryDirectory() as tmpdir:
            repo = Path(tmpdir)
            md_dir = repo / "01_data" / "2026" / "10" / "06"
            md_dir.mkdir(parents=True)
            step_file = md_dir / "test_model.step"
            step_file.write_bytes(b"ISO-10303-21;")

            md_file = md_dir / "note.md"
            md_file.write_text(
                "```step\npath: 01_data/2026/10/06/test_model.step\n```\n",
                encoding="utf-8",
            )

            source_rel = "01_data/2026/10/06/note.md"
            resolved = related_markdown_paths(repo, source_rel)
            self.assertIn("01_data/2026/10/06/test_model.step", resolved)


if __name__ == "__main__":
    unittest.main()
