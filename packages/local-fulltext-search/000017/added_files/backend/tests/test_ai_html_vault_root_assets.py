"""
AI用HTMLの書き出しで、ノートと別のフォルダにある画像・図面を Vault 全体から探して埋め込むテスト。

仕様:
- ノートを絶対パスで選んだとき（file_paths）、画像・図面の探索はノートのフォルダ配下とその親フォルダ配下だけでなく、
  ノートが属する Obsidian Vault のルート（`.obsidian` フォルダがあるフォルダ）配下まで広げる。
  例: 01_data/2026/04/11/ノート.md の `![[図.excalidraw]]` が 01_data/2026/05/02/図.excalidraw.md を指す。
- 見つかった画像・図面は Data URL として埋め込み、skipped_links に「見つからない画像」として記録しない。
- Vault ルートが見つからないとき（`.obsidian` が無い）は従来どおりノートのフォルダとその親フォルダだけを探す。
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, Dict, List

from app.vector.html_exporter import export_documents_to_html

PNG_BYTES = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")

EXCALIDRAW_NOTE = """---
excalidraw-plugin: parsed
tags: [excalidraw]
---

# Excalidraw Data

## Text Elements
別フォルダの図 ^abc12345

## Drawing
```json
{
  "type": "excalidraw",
  "version": 2,
  "elements": [
    {"id": "r1", "type": "rectangle", "x": 0, "y": 0, "width": 100, "height": 50,
     "strokeColor": "#000000", "backgroundColor": "transparent"}
  ],
  "files": {}
}
```
"""


def _image_skips(stats: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [s for s in stats["skipped_links"] if s["kind"] == "image"]


def _make_vault(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    (vault / ".obsidian").mkdir(parents=True)
    return vault


def test_figure_in_other_date_folder_of_vault_is_embedded(tmp_path: Path) -> None:
    vault = _make_vault(tmp_path)
    note_dir = vault / "01_data" / "2026" / "04" / "11"
    fig_dir = vault / "01_data" / "2026" / "05" / "02"
    note_dir.mkdir(parents=True)
    fig_dir.mkdir(parents=True)
    (fig_dir / "図_別フォルダ.excalidraw.md").write_text(EXCALIDRAW_NOTE, encoding="utf-8")
    note = note_dir / "ノート.md"
    note.write_text("# ノート\n![[図_別フォルダ.excalidraw|1475]]\n", encoding="utf-8")

    html, stats = export_documents_to_html(file_paths=[str(note)], file_depths={})

    assert _image_skips(stats) == []
    assert "![[図_別フォルダ.excalidraw" not in html
    assert 'alt="図_別フォルダ.excalidraw" width="1475"' in html
    assert "data:image/svg+xml;base64," in html


def test_image_in_vault_attachment_folder_is_embedded(tmp_path: Path) -> None:
    vault = _make_vault(tmp_path)
    note_dir = vault / "01_data" / "2026" / "04" / "11"
    img_dir = vault / "99_attachments"
    note_dir.mkdir(parents=True)
    img_dir.mkdir(parents=True)
    (img_dir / "Pasted image 20260215201159.png").write_bytes(PNG_BYTES)
    note = note_dir / "ノート.md"
    note.write_text("# ノート\n![[Pasted image 20260215201159.png]]\n", encoding="utf-8")

    html, stats = export_documents_to_html(file_paths=[str(note)], file_depths={})

    assert _image_skips(stats) == []
    assert "data:image/png;base64," in html


def test_without_vault_root_search_stays_near_the_note(tmp_path: Path) -> None:
    """`.obsidian` が無ければ、ノートの親フォルダより上へは探しに行かない（従来どおり）。"""
    top = tmp_path / "top"
    note_dir = top / "a" / "b"
    far_dir = top / "far"
    note_dir.mkdir(parents=True)
    far_dir.mkdir(parents=True)
    (far_dir / "遠い画像.png").write_bytes(PNG_BYTES)
    note = note_dir / "ノート.md"
    note.write_text("# ノート\n![[遠い画像.png]]\n", encoding="utf-8")

    _, stats = export_documents_to_html(file_paths=[str(note)], file_depths={})

    assert [s["target"] for s in _image_skips(stats)] == ["遠い画像.png"]
