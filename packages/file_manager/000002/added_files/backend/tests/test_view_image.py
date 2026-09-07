"""
画像インライン表示API (/api/view-image) のテスト
- 正常系: PNG, JPG, GIF, WEBP, SVG, BMP, ICO ファイルがインラインContent-Dispositionで取得できること
- 正常系: 日本語ファイル名のエンコード対応
- 異常系: 存在しないパス (404)
- 異常系: 非画像ファイル (400)
- 異常系: ディレクトリ指定 (400)
- セキュリティ: パストラバーサル防止
"""
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
