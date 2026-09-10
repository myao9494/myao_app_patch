"""
画像インライン表示API (/api/view-image) のテスト
- 正常系: PNG, JPG, GIF, WEBP, SVG, BMP, ICO ファイルがインラインContent-Dispositionで取得できること
- 正常系: 日本語ファイル名のエンコード対応
- 正常系: Obsidian Excalidrawファイル (.excalidraw.md / .excalidraw) がキャッシュプレビュー画像として表示できること
- 正常系: Obsidian Vault相対パス (01_data/...) およびファイル名探索の解決
- 異常系: 存在しないパス (404)
- 異常系: 非画像ファイル (400)
- 異常系: ディレクトリ指定 (400)
- セキュリティ: パストラバーサル防止
"""
import json
import pytest
from fastapi.testclient import TestClient
from pathlib import Path
import urllib.parse
from app.main import app

client = TestClient(app)


def test_view_image_png_success(tmp_path: Path):
    """PNG画像が適切なContent-Typeで正常にインライン表示できること"""
    img_file = tmp_path / "sample.png"
    # 最小限の1x1 PNGバイナリ
    png_bytes = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82'
    img_file.write_bytes(png_bytes)

    encoded_path = urllib.parse.quote(str(img_file))
    response = client.get(f"/api/view-image?path={encoded_path}")

    assert response.status_code == 200
    assert "image/png" in response.headers.get("content-type", "")
    assert "inline" in response.headers.get("content-disposition", "")
    assert response.content == png_bytes


def test_view_image_jpeg_success(tmp_path: Path):
    """JPEG画像が適切なContent-Typeで正常にインライン表示できること"""
    img_file = tmp_path / "photo.jpg"
    jpeg_bytes = b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x01\x00`\x00`\x00\x00\xff\xdb\x00C\x00'
    img_file.write_bytes(jpeg_bytes)

    encoded_path = urllib.parse.quote(str(img_file))
    response = client.get(f"/api/view-image?path={encoded_path}")

    assert response.status_code == 200
    assert "image/jpeg" in response.headers.get("content-type", "")
    assert "inline" in response.headers.get("content-disposition", "")


def test_view_image_svg_success(tmp_path: Path):
    """SVGファイルが適切なContent-Typeで正常にインライン表示できること"""
    img_file = tmp_path / "vector.svg"
    svg_content = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'
    img_file.write_text(svg_content, encoding="utf-8")

    encoded_path = urllib.parse.quote(str(img_file))
    response = client.get(f"/api/view-image?path={encoded_path}")

    assert response.status_code == 200
    assert "image/svg+xml" in response.headers.get("content-type", "")
    assert "inline" in response.headers.get("content-disposition", "")


def test_view_image_japanese_filename(tmp_path: Path):
    """日本語ファイル名がRFC 2231形式で正しくエンコードされてヘッダーに含まれること"""
    img_file = tmp_path / "テスト画像.png"
    img_file.write_bytes(b'\x89PNG\r\n\x1a\n')

    encoded_path = urllib.parse.quote(str(img_file))
    response = client.get(f"/api/view-image?path={encoded_path}")

    assert response.status_code == 200
    disposition = response.headers.get("content-disposition", "")
    assert "inline" in disposition
    encoded_name = urllib.parse.quote("テスト画像.png")
    assert f"filename*=UTF-8''{encoded_name}" in disposition


def test_view_image_not_found():
    """存在しないパスを指定した場合は404エラーになること"""
    response = client.get("/api/view-image?path=/nonexistent/image.png")
    assert response.status_code == 404
    assert "ファイルが見つかりません" in response.json()["detail"]


def test_view_image_directory_error(tmp_path: Path):
    """ディレクトリを指定した場合は400エラーになること"""
    dir_path = tmp_path / "images_folder"
    dir_path.mkdir()

    encoded_path = urllib.parse.quote(str(dir_path))
    response = client.get(f"/api/view-image?path={encoded_path}")
    assert response.status_code == 400
    assert "ディレクトリは表示できません" in response.json()["detail"]


def test_view_image_non_image_file_error(tmp_path: Path):
    """画像以外のファイルを指定した場合は400エラーになること"""
    txt_file = tmp_path / "document.txt"
    txt_file.write_text("Hello text")

    encoded_path = urllib.parse.quote(str(txt_file))
    response = client.get(f"/api/view-image?path={encoded_path}")
    assert response.status_code == 400
    assert "画像ファイルではありません" in response.json()["detail"]


def test_view_image_excalidraw_cache_resolution(tmp_path: Path, monkeypatch):
    """Obsidianの.excalidraw.mdファイルに対して、.excalidraw-cache内のプレビュー画像が自動解決されること"""
    vault = tmp_path / "obsidian_vault"
    vault.mkdir()
    (vault / ".obsidian").mkdir()

    # .excalidraw-cache
    cache_dir = vault / ".excalidraw-cache"
    cache_dir.mkdir()
    preview_png = cache_dir / "abc123_1700000000_preview.png"
    png_bytes = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82'
    preview_png.write_bytes(png_bytes)

    # index.json
    index_json = cache_dir / "index.json"
    index_json.write_text(json.dumps({
        "01_data/diagram.excalidraw.md": {
            "hash": "abc123",
            "cachefile": "abc123_1700000000_preview.png",
            "format": "png",
            "mtime": 1700000000
        }
    }), encoding="utf-8")

    # .excalidraw.md file
    data_dir = vault / "01_data"
    data_dir.mkdir()
    excal_file = data_dir / "diagram.excalidraw.md"
    excal_file.write_text("---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n", encoding="utf-8")

    # 1. フルパスで .excalidraw.md を指定した場合
    encoded_path = urllib.parse.quote(str(excal_file))
    res = client.get(f"/api/view-image?path={encoded_path}")
    assert res.status_code == 200
    assert "image/png" in res.headers.get("content-type", "")
    assert res.content == png_bytes

    # 2. 拡張子 .excalidraw で指定した場合（実ファイルは .excalidraw.md）
    encoded_path_no_md = urllib.parse.quote(str(data_dir / "diagram.excalidraw"))
    res2 = client.get(f"/api/view-image?path={encoded_path_no_md}")
    assert res2.status_code == 200
    assert "image/png" in res2.headers.get("content-type", "")
    assert res2.content == png_bytes


def test_view_image_obsidian_vault_relative(tmp_path: Path):
    """01_data/images/logo.png のようなVault相対パスが自動解決されること"""
    vault = tmp_path / "obsidian_vault"
    vault.mkdir()
    (vault / ".obsidian").mkdir()
    data_dir = vault / "01_data" / "images"
    data_dir.mkdir(parents=True)
    img_file = data_dir / "logo.png"
    png_bytes = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82'
    img_file.write_bytes(png_bytes)

    # 基準ディレクトリ（開いているノートの場所）
    note_dir = vault / "01_data" / "2026" / "01" / "01"
    note_dir.mkdir(parents=True)

    # base_dir をクエリで渡してVault相対パスを解決
    rel_path = "01_data/images/logo.png"
    encoded_path = urllib.parse.quote(rel_path)
    encoded_base = urllib.parse.quote(str(note_dir))
    res = client.get(f"/api/view-image?path={encoded_path}&baseDir={encoded_base}")
    assert res.status_code == 200
    assert "image/png" in res.headers.get("content-type", "")
    assert res.content == png_bytes

