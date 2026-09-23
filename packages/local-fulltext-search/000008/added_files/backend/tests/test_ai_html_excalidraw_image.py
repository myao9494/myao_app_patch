"""
Excalidraw図面内の貼り付け画像（PNG等）のHTML表示・復元テスト。
Markdownの ## Embedded Files セクションのWikiLink解決、fileIdハッシュファイル名の解決、
および自己完結HTMLエクスポート時の画像埋め込みを検証する。
"""

import base64
import json
from pathlib import Path
import pytest

from app.vector.html_exporter import (
    extract_excalidraw_data,
    excalidraw_to_svg,
    resolve_image_or_figure_data_url,
    export_documents_to_html,
)


def _create_sample_png_bytes() -> bytes:
    """1x1ピクセルの透明PNGバイトデータを生成する"""
    return base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")


def test_extract_excalidraw_data_embedded_files() -> None:
    """## Embedded Files セクションから fileId と画像リンクのマッピングが正しく抽出されること"""
    md_content = """---
excalidraw-plugin: parsed
tags: [excalidraw]
---

# Excalidraw Data

## Text Elements
サンプルテキスト ^abc12345

## Embedded Files
770205659062816e77d5f61a7f516ad2749aa5fe: [[windows.png]]
0cc49df267a7ab626d20b99d7df69df791f48d52: [[01_data/common_image/obsidian_logo.png]]

## Drawing
```json
{
  "type": "excalidraw",
  "version": 2,
  "elements": [
    {
      "id": "elem1",
      "type": "image",
      "fileId": "770205659062816e77d5f61a7f516ad2749aa5fe",
      "x": 100,
      "y": 100,
      "width": 200,
      "height": 150
    }
  ],
  "files": {}
}
```
"""
    data = extract_excalidraw_data(md_content)
    assert data is not None
    assert "embedded_files" in data
    assert data["embedded_files"]["770205659062816e77d5f61a7f516ad2749aa5fe"] == "windows.png"
    assert data["embedded_files"]["0cc49df267a7ab626d20b99d7df69df791f48d52"] == "01_data/common_image/obsidian_logo.png"


def test_excalidraw_to_svg_embedded_files_link(tmp_path: Path) -> None:
    """## Embedded Files でWikiLink指定されたローカルPNG画像がSVG内に正しく埋め込まれること"""
    vault_dir = tmp_path / "vault"
    vault_dir.mkdir()

    # 画像ファイルの作成
    img_dir = vault_dir / "images"
    img_dir.mkdir()
    png_file = img_dir / "sample_pic.png"
    png_file.write_bytes(_create_sample_png_bytes())

    file_id = "abc1234567890abcdef1234567890abcdef1234"
    excalidraw_data = {
        "type": "excalidraw",
        "elements": [
            {
                "id": "im1",
                "type": "image",
                "fileId": file_id,
                "x": 50,
                "y": 50,
                "width": 120,
                "height": 80,
            }
        ],
        "files": {},
        "embedded_files": {
            file_id: "images/sample_pic.png"
        },
    }

    # SVG生成
    svg_output = excalidraw_to_svg(excalidraw_data, vault_path=vault_dir, current_file_path=vault_dir / "note.excalidraw.md")
    assert "<image" in svg_output
    assert 'href="data:image/png;base64,' in svg_output
    assert 'x="50"' in svg_output
    assert 'width="120"' in svg_output


def test_excalidraw_to_svg_hash_file(tmp_path: Path) -> None:
    """filesにdataURLがなくとも、同フォルダまたはVault内に {fileId}.png があればSVG内に埋め込まれること"""
    vault_dir = tmp_path / "vault"
    vault_dir.mkdir()

    note_dir = vault_dir / "sub"
    note_dir.mkdir()

    file_id = "0fd5abb9830e51ddaf1d5b4f9e3b493519bb6318"
    hash_png = note_dir / f"{file_id}.png"
    hash_png.write_bytes(_create_sample_png_bytes())

    excalidraw_data = {
        "type": "excalidraw",
        "elements": [
            {
                "id": "im2",
                "type": "image",
                "fileId": file_id,
                "x": 10,
                "y": 20,
                "width": 300,
                "height": 200,
            }
        ],
        "files": {
            file_id: {
                "mimeType": "image/png",
                "id": file_id,
            }
        },
    }

    svg_output = excalidraw_to_svg(excalidraw_data, vault_path=vault_dir, current_file_path=note_dir / "test.excalidraw.md")
    assert "<image" in svg_output
    assert 'href="data:image/png;base64,' in svg_output


def test_export_documents_to_html_with_embedded_excalidraw_image(tmp_path: Path) -> None:
    """Markdownノート内のExcalidraw埋め込み図面が、内部の貼り付け画像を含めて自己完結HTMLに出力されること"""
    vault_dir = tmp_path / "vault"
    vault_dir.mkdir()

    # 貼り付け対象のPNG
    png_path = vault_dir / "embedded_logo.png"
    png_path.write_bytes(_create_sample_png_bytes())

    # Excalidrawノート
    excal_file = vault_dir / "diagram.excalidraw.md"
    file_id = "770205659062816e77d5f61a7f516ad2749aa5fe"
    excal_content = f"""---
excalidraw-plugin: parsed
tags: [excalidraw]
---

# Excalidraw Data

## Embedded Files
{file_id}: [[embedded_logo.png]]

## Drawing
```json
{{
  "type": "excalidraw",
  "version": 2,
  "elements": [
    {{
      "id": "img_elem",
      "type": "image",
      "fileId": "{file_id}",
      "x": 20,
      "y": 30,
      "width": 160,
      "height": 90
    }}
  ],
  "files": {{}}
}}
```
"""
    excal_file.write_text(excal_content, encoding="utf-8")

    # 親のMarkdownノート（Excalidrawを埋め込み）
    main_doc = vault_dir / "main.md"
    main_doc.write_text("# システム概要\n\n以下は構成図です。\n\n![[diagram.excalidraw.md|400]]\n\n詳細説明テキスト。", encoding="utf-8")

    html_content, stats = export_documents_to_html(
        vault_path=str(vault_dir),
        file_paths=[str(main_doc)],
        prompt="テストプロンプト",
        title="システム仕様書",
        include_images=True,
    )

    assert stats["total_documents"] == 1
    assert stats["total_images_embedded"] >= 1
    assert "data:image/svg+xml;base64," in html_content
    # 生成されたSVG (Base64) をデコードして、内部に貼り付けPNGのData URLが含まれていることを検証
    import re
    img_match = re.search(r'src="data:image/svg\+xml;base64,([^"]+)"', html_content)
    assert img_match is not None
    svg_text = base64.b64decode(img_match.group(1)).decode("utf-8")
    assert "<image" in svg_text
    assert 'href="data:image/png;base64,' in svg_text


def test_export_documents_to_html_excalidraw_direct_file(tmp_path: Path) -> None:
    """Excalidrawノート自体が直接指定された場合も、図面画像として記事本文に出力されること"""
    vault_dir = tmp_path / "vault"
    vault_dir.mkdir()

    png_path = vault_dir / "logo.png"
    png_path.write_bytes(_create_sample_png_bytes())

    file_id = "abc000111222333444555666777888999aaabbbc"
    excal_file = vault_dir / "architecture.excalidraw.md"
    excal_content = f"""---
excalidraw-plugin: parsed
tags: [excalidraw]
---

# Excalidraw Data

## Embedded Files
{file_id}: [[logo.png]]

## Drawing
```json
{{
  "type": "excalidraw",
  "version": 2,
  "elements": [
    {{
      "id": "img1",
      "type": "image",
      "fileId": "{file_id}",
      "x": 10,
      "y": 10,
      "width": 100,
      "height": 100
    }}
  ],
  "files": {{}}
}}
```
"""
    excal_file.write_text(excal_content, encoding="utf-8")

    html_content, stats = export_documents_to_html(
        vault_path=str(vault_dir),
        file_paths=[str(excal_file)],
        title="アーキテクチャ図",
        include_images=True,
    )

    # スキップされず1件として出力されること
    assert stats["total_documents"] == 1
    assert "architecture" in html_content
    assert "data:image/" in html_content
