"""
AIインプットPDFエクスポートAPIのテスト。
仕様:
- POST /api/export/ai-pdf/download:
    - HTMLまたはファイル指定を受け取り、Content-Type: application/pdf でPDFバイナリを返却する。
    - Content-Disposition ヘッダーに .pdf ファイル名が含まれること。
- POST /api/export/ai-pdf/save:
    - HTMLまたはファイル指定を受け取り、指定ディレクトリ（またはDownloads）にPDFファイルを保存する。
    - 保存されたファイルの絶対パス（saved_path）、ファイル名、サイズ（size_bytes）を返却する。
    - 実際にディスク上にPDFファイルが保存され、先頭が '%PDF-' であること。
"""

from pathlib import Path
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_api_export_pdf_download():
    """/api/export/ai-pdf/download でPDFファイルがダウンロードできること"""
    payload = {
        "html_content": "<html><body><h1>API Test Download</h1><p>Content</p></body></html>",
        "file_name": "custom_test.pdf",
    }
    response = client.post("/api/export/ai-pdf/download", json=payload)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert "custom_test.pdf" in response.headers.get("content-disposition", "")
    assert response.content.startswith(b"%PDF-")


def test_api_export_pdf_save(tmp_path: Path):
    """/api/export/ai-pdf/save でローカルにPDFが保存され、絶対パスが返却されること"""
    payload = {
        "html_content": "<html><body><h1>API Test Save</h1><p>Content</p></body></html>",
        "file_name": "saved_doc.pdf",
        "target_dir": str(tmp_path),
    }
    response = client.post("/api/export/ai-pdf/save", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["file_name"] == "saved_doc.pdf"
    assert data["size_bytes"] > 0

    saved_file = Path(data["saved_path"])
    assert saved_file.is_file()
    assert saved_file.read_bytes().startswith(b"%PDF-")
