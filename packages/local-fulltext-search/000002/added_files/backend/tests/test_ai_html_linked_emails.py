"""
AIコンテキストエクスポート時の呼び出されたメール（.msg / .eml）展開とBase64画像埋め込みの単体テスト。
仕様:
- Markdownファイル内でリンク（[[...]], [text](...)）されているメールファイル（.msg, .eml）を自動検出する。
- include_linked_emails=True の場合、HTML末尾に APPENDIX としてメール情報（件名・送信者・宛先・日時・本文）を展開し、目次（TOC）にも追加する。
- include_linked_emails=False の場合、メールセクションは出力しない。
- include_images=True の場合、メール内のインライン画像（CID画像）および添付画像を Base64 Data URL として埋め込む。
- Outlook特有のOfficeメタデータ（<!--[if ...]>、<xml>、<o:p> 等）をクリーンにサニタイズする。
"""

import email
from email.message import EmailMessage
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import pytest

from app.vector.html_exporter import (
    extract_linked_email_paths,
    sanitize_outlook_html,
    export_documents_to_html,
)


def test_sanitize_outlook_html() -> None:
    """Outlook/Word特有のOfficeメタデータ、条件付きコメント、名前空間タグが完全除去されること"""
    dirty_html = """
    <!DOCTYPE html>
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:v="urn:schemas-microsoft-com:vml">
    <head>
        <title>メールタイトル</title>
        <style>
            <!-- /* Font Definitions */ @font-face { font-family: "Meiryo"; } -->
        </style>
    </head>
    <body>
        <!--[if gte mso 9]>
        <xml>
            <o:OfficeDocumentSettings>
                <o:AllowPNG/>
            </o:OfficeDocumentSettings>
        </xml>
        <![endif]-->
        <p class="MsoNormal">
            お疲れ様です。<o:p></o:p>
        </p>
        <p>
            明日の会議のアジェンダです。<w:WordDocument>不要なXML</w:WordDocument>
        </p>
    </body>
    </html>
    """
    clean = sanitize_outlook_html(dirty_html)

    assert "<!--[if" not in clean
    assert "<xml>" not in clean
    assert "</xml>" not in clean
    assert "<o:p>" not in clean
    assert "</o:p>" not in clean
    assert "<w:WordDocument>" not in clean
    assert "<style>" not in clean
    assert "<title>" not in clean
    assert "<!DOCTYPE" not in clean
    assert "お疲れ様です。" in clean
    assert "明日の会議のアジェンダです。" in clean


def test_extract_linked_email_paths(tmp_path: Path) -> None:
    """MarkdownからWikilink形式およびMarkdownリンク形式のメールファイル参照が正しく抽出されること"""
    # テスト用メールファイル作成
    mail1 = tmp_path / "meeting.msg"
    mail1.write_text("dummy msg 1", encoding="utf-8")

    sub_dir = tmp_path / "sub"
    sub_dir.mkdir()
    mail2 = sub_dir / "report.eml"
    mail2.write_text("dummy eml 2", encoding="utf-8")

    mail3 = tmp_path / "detail.msg"
    mail3.write_text("dummy msg 3", encoding="utf-8")

    md_content = f"""
    # 議事録
    昨日の打ち合わせ内容は [[meeting.msg]] を参照してください。
    また、詳細報告は [[sub/report.eml|報告書メール]] に記載されています。
    埋め込み形式 ![[detail.msg]] も確認してください。
    標準リンク形式: [補足資料]({mail3.name})
    関係のないリンク: [[document.pdf]] [ウェブ](https://example.com)
    """

    doc_file = tmp_path / "doc.md"
    doc_file.write_text(md_content, encoding="utf-8")

    found_paths = extract_linked_email_paths(md_content, base_dir=tmp_path, vault_path=tmp_path)
    resolved_names = [p.name for p in found_paths]

    assert "meeting.msg" in resolved_names
    assert "report.eml" in resolved_names
    assert "detail.msg" in resolved_names
    assert "document.pdf" not in resolved_names


def test_export_documents_to_html_with_linked_eml(tmp_path: Path) -> None:
    """リンクされたEMLファイルがAPPENDIXとしてHTMLに出力され、目次にも追加されること"""
    # EMLファイルの作成
    eml_file = tmp_path / "discussion.eml"
    msg = EmailMessage()
    msg["Subject"] = "プロジェクト進捗報告"
    msg["From"] = "tanaka@example.com"
    msg["To"] = "team@example.com"
    msg["Date"] = "Mon, 14 Sep 2026 10:00:00 +0900"
    msg.set_content("今週の進捗は順調です。\n来週初めにテストを開始します。")

    eml_file.write_bytes(msg.as_bytes())

    # Markdownファイル作成
    doc = tmp_path / "project.md"
    doc.write_text(
        "# プロジェクト進捗\n\n進捗の詳細は [[discussion.eml]] を確認してください。",
        encoding="utf-8",
    )

    # 1. include_linked_emails=True の場合
    html_with_mail, stats_with = export_documents_to_html(
        file_paths=[str(doc)],
        title="進捗レポート",
        include_linked_emails=True,
    )

    assert "APPENDIX: 呼び出されたメール" in html_with_mail
    assert "discussion.eml" in html_with_mail
    assert "プロジェクト進捗報告" in html_with_mail
    assert "tanaka@example.com" in html_with_mail
    assert "今週の進捗は順調です。" in html_with_mail
    assert stats_with.get("total_linked_emails") == 1

    # 2. include_linked_emails=False の場合
    html_without_mail, stats_without = export_documents_to_html(
        file_paths=[str(doc)],
        title="進捗レポート",
        include_linked_emails=False,
    )

    assert "APPENDIX: 呼び出されたメール" not in html_without_mail
    assert "tanaka@example.com" not in html_without_mail
    assert stats_without.get("total_linked_emails", 0) == 0


def test_export_documents_to_html_with_linked_eml_and_base64_images(tmp_path: Path) -> None:
    """include_images=True のとき、メール内の画像がBase64でHTMLにインライン埋め込みされること"""
    # 1x1 PNG ダミーデータ
    png_bytes = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4"
        b"\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
    )

    eml_file = tmp_path / "with_image.eml"
    msg = EmailMessage()
    msg["Subject"] = "画像付き案内"
    msg["From"] = "design@example.com"
    msg["To"] = "team@example.com"
    msg["Date"] = "Mon, 14 Sep 2026 11:00:00 +0900"

    msg.set_content("テキスト本文です。")
    msg.add_alternative(
        """<html><body><p>HTML本文です。<img src="cid:sample_image_cid"></p></body></html>""",
        subtype="html",
    )
    msg.get_payload()[1].add_related(
        png_bytes,
        maintype="image",
        subtype="png",
        cid="<sample_image_cid>",
        filename="sample.png",
    )

    eml_file.write_bytes(msg.as_bytes())

    doc = tmp_path / "design_doc.md"
    doc.write_text("# デザイン\n\n詳細は [[with_image.eml]] を参照。", encoding="utf-8")

    # include_images=True
    html_content, stats = export_documents_to_html(
        file_paths=[str(doc)],
        title="デザイン案内",
        include_images=True,
        include_linked_emails=True,
    )

    assert "data:image/png;base64," in html_content
    assert "画像付き案内" in html_content
    assert stats.get("total_linked_emails") == 1


def test_export_documents_to_html_with_linked_msg(tmp_path: Path) -> None:
    """extract_msg の解析結果が正しくHTMLに出力されること（モックテスト）"""
    msg_file = tmp_path / "customer.msg"
    msg_file.write_bytes(b"dummy msg content")

    doc = tmp_path / "customer_doc.md"
    doc.write_text("# 顧客要望\n\n[[customer.msg]]", encoding="utf-8")

    class FakeMsgAttachment:
        def __init__(self):
            self.data = (
                b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4"
                b"\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
            )
            self.longFilename = "diagram.png"
            self.shortFilename = "diagram.png"
            self.mimetype = "image/png"
            self.cid = "cid_diagram_01"

    class FakeMsgMessage:
        subject = "顧客からの機能追加要望"
        sender = "client@corp.example.com"
        to = "support@example.com"
        date = "2026-09-14 12:00:00"
        body = "新しい検索機能の追加をお願いします。"
        htmlBody = (
            "<html><body>"
            "<!--[if gte mso 9]><xml><o:p></o:p></xml><![endif]-->"
            "<p>新しい検索機能の追加をお願いします。<o:p></o:p></p>"
            '<img src="cid:cid_diagram_01">'
            "</body></html>"
        )
        attachments = [FakeMsgAttachment()]

        def close(self):
            pass

    def fake_open_msg(path: str, **kwargs):
        assert "customer.msg" in path
        return FakeMsgMessage()

    with patch.dict("sys.modules", {"extract_msg": SimpleNamespace(openMsg=fake_open_msg, Message=fake_open_msg)}):
        html_content, stats = export_documents_to_html(
            file_paths=[str(doc)],
            title="顧客レポート",
            include_images=True,
            include_linked_emails=True,
        )

    assert "顧客からの機能追加要望" in html_content
    assert "client@corp.example.com" in html_content
    assert "新しい検索機能の追加をお願いします。" in html_content
    assert "<!--[if" not in html_content
    assert "<o:p>" not in html_content
    assert "data:image/png;base64," in html_content
    assert stats.get("total_linked_emails") == 1
