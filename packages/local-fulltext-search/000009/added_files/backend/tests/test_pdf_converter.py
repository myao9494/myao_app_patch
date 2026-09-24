"""
HTMLから高精度PDFを生成するコンバーター機能のテスト。
仕様:
- 端末インストール済みのChrome/Edgeを自動検出し、Playwright経由でヘッドレス実行する。
- HTML文字列を受け取り、A4サイズのPDFバイナリ（bytes）を生成する。
- Base64画像（data:image/png;base64,...）を含むHTMLでもレイアウトを維持して正常にPDF化できること。
- 生成されたバイナリが有効なPDFファイル形式（先頭が '%PDF-' で始まる）であることを検証する。
"""

import base64
import pytest
from app.services.pdf_converter import convert_html_to_pdf, PdfConverterError


def test_convert_html_to_pdf_basic():
    """基本的なHTMLから有効なPDFバイナリが生成されること"""
    html_content = """<!DOCTYPE html>
    <html>
    <head><title>Test Document</title></head>
    <body>
        <h1>タイトル</h1>
        <p>これはテスト用のドキュメントです。</p>
    </body>
    </html>"""

    pdf_bytes = convert_html_to_pdf(html_content)
    assert isinstance(pdf_bytes, bytes)
    assert len(pdf_bytes) > 0
    # PDFマジックナンバーの検証
    assert pdf_bytes.startswith(b"%PDF-")


def test_convert_html_to_pdf_with_base64_image():
    """Base64画像を含むHTMLが正常にPDF化されること"""
    # 1x1 透明PNGのBase64
    sample_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    html_content = f"""<!DOCTYPE html>
    <html>
    <head><title>Image Test</title></head>
    <body>
        <h1>画像付きドキュメント</h1>
        <img src="data:image/png;base64,{sample_b64}" alt="test image" width="100" height="100">
        <p>画像埋め込みテスト</p>
    </body>
    </html>"""

    pdf_bytes = convert_html_to_pdf(html_content)
    assert isinstance(pdf_bytes, bytes)
    assert len(pdf_bytes) > 0
    assert pdf_bytes.startswith(b"%PDF-")


def test_convert_html_to_pdf_empty_raises_error():
    """空のHTMLの場合はPdfConverterErrorが発生すること"""
    with pytest.raises(PdfConverterError):
        convert_html_to_pdf("")
