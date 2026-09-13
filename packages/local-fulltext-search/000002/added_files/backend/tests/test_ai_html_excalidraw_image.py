"""
.excalidraw.md を画像ファイル（図面アセット）として取り扱う挙動の単体テスト

仕様:
1. export_documents_to_html に .excalidraw.md が渡された場合、文書本文としては出力せずスキップする（obsidian-dagnetz 仕様準拠）。
2. replace_obsidian_image_embeds において、![[xxx.excalidraw.md]] や ![[xxx.excalidraw.md|300]] の埋め込みが Base64 <img> タグに置換される。
3. replace_obsidian_image_embeds において、[[xxx.excalidraw.md]] や [[xxx.excalidraw.md|300]]、[[xxx.excalidraw.md|明和高校]]（! なしの通常リンク）も画像ファイルとして検出され、Base64 <img> タグに置換される。
"""

import json
from pathlib import Path
import pytest

from app.vector.html_exporter import (
    export_documents_to_html,
    replace_obsidian_image_embeds,
)


@pytest.fixture
def temp_vault_with_excalidraw(tmp_path: Path) -> Path:
    """テスト用のObsidian Vaultディレクトリを作成する"""
    vault = tmp_path / "test_vault"
    vault.mkdir()

    # 1. .excalidraw.md ファイル（図面データを含む）
    excal_file = vault / "明和高校.excalidraw.md"
    excal_content = """---
excalidraw-plugin: parsed
tags: [excalidraw]
---
# Excalidraw Data
```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [
    {
      "id": "rect1",
      "type": "rectangle",
      "x": 100,
      "y": 100,
      "width": 200,
      "height": 100,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "transparent"
    }
  ],
  "appState": {
    "viewBackgroundColor": "#ffffff"
  }
}
```
"""
    excal_file.write_text(excal_content, encoding="utf-8")

    # 2. 通常のマークダウンノート（明和高校.excalidraw.md へのリンク・埋め込みを含む）
    note_file = vault / "高校レポート.md"
    note_content = """# 高校レポート

## 埋め込み図面
![[明和高校.excalidraw.md|300]]

## 通常リンク図面
[[明和高校.excalidraw.md]]

## 別名付き通常リンク図面
[[明和高校.excalidraw.md|明和高校の校舎配置図]]
"""
    note_file.write_text(note_content, encoding="utf-8")

    return vault


def test_export_documents_to_html_skips_excalidraw_md(temp_vault_with_excalidraw: Path):
    """
    export_documents_to_html に .excalidraw.md が直接指定された場合、
    文書記事（<article>）としては出力されずスキップされることを検証する。
    """
    excal_path = temp_vault_with_excalidraw / "明和高校.excalidraw.md"
    html_content, meta = export_documents_to_html(
        vault_path=str(temp_vault_with_excalidraw),
        file_paths=[str(excal_path)],
        title="テスト",
    )

    assert meta["total_documents"] == 0
    assert "明和高校.excalidraw.md" not in html_content
    assert "<article" not in html_content


def test_replace_obsidian_image_embeds_handles_excalidraw_embed(temp_vault_with_excalidraw: Path):
    """
    ![[明和高校.excalidraw.md|300]] が Base64 <img> タグに置換され、width="300" が反映されることを検証する。
    """
    content = "![[明和高校.excalidraw.md|300]]"
    replaced, count = replace_obsidian_image_embeds(
        content=content,
        vault_path=str(temp_vault_with_excalidraw),
        current_file_path="高校レポート.md",
    )

    assert count == 1
    assert "<img src=\"data:image/svg+xml;base64," in replaced
    assert 'width="300"' in replaced
    assert "excalidraw-export-embed" in replaced


def test_replace_obsidian_image_embeds_handles_wikilink_without_exclamation(temp_vault_with_excalidraw: Path):
    """
    [[明和高校.excalidraw.md]] や [[明和高校.excalidraw.md|明和高校]] のような ! なしの Wikilink も
    画像ファイルとして検出され、Base64 <img> タグに置換されることを検証する。
    """
    content = "図面参照: [[明和高校.excalidraw.md|明和高校の校舎配置図]]"
    replaced, count = replace_obsidian_image_embeds(
        content=content,
        vault_path=str(temp_vault_with_excalidraw),
        current_file_path="高校レポート.md",
    )

    assert count == 1
    assert "<img src=\"data:image/svg+xml;base64," in replaced
    assert "明和高校の校舎配置図" in replaced or "明和高校.excalidraw.md" in replaced
    assert "excalidraw-export-embed" in replaced
