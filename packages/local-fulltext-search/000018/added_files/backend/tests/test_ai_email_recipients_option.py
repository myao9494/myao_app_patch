"""
AIインプット書き出しで、リンクされたメールの宛先（To・Cc・Bcc）を含めるかを切り替える include_email_recipients のテスト。

仕様:
- 既定（False）は宛先を含めない。メールの見出し枠に「宛先」を出さず、本文の引用・転送ヘッダーからも To / Cc / Bcc の行を除く。
- True のときは見出し枠に宛先を出し、本文の宛先行も残す。
- トークン最適化（optimize_tokens）とは独立に切り替わる。
- HTML（export_documents_to_html）と Markdown＋画像（export_documents_to_markdown_and_image）の両方に効く。
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.vector.html_exporter import export_documents_to_html
from app.vector.markdown_image_exporter import export_documents_to_markdown_and_image

_EML = """Subject: 進捗報告
From: leader@example.com
To: member@example.com
Cc: boss@example.com
Date: Wed, 24 Sep 2026 10:00:00 +0900
Content-Type: text/plain; charset=utf-8

本日の報告です。

-----Original Message-----
From: client@example.com
To: quoted_to@example.com
Cc: quoted_cc@example.com
Subject: 依頼
元の依頼本文です。
"""


def _note_with_mail(tmp_path: Path) -> Path:
    (tmp_path / "report.eml").write_text(_EML, encoding="utf-8")
    note = tmp_path / "note.md"
    note.write_text("# メモ\n\n参照: [[report.eml]]\n", encoding="utf-8")
    return note


def test_html_excludes_recipients_by_default(tmp_path: Path) -> None:
    note = _note_with_mail(tmp_path)
    html_content, _ = export_documents_to_html(file_paths=[str(note)], include_linked_emails=True)

    assert "<dt>宛先:</dt>" not in html_content
    for address in ("member@example.com", "quoted_to@example.com", "quoted_cc@example.com"):
        assert address not in html_content
    assert "leader@example.com" in html_content
    assert "client@example.com" in html_content
    assert "元の依頼本文です。" in html_content


def test_html_includes_recipients_when_enabled_even_with_token_optimization(tmp_path: Path) -> None:
    note = _note_with_mail(tmp_path)
    html_content, _ = export_documents_to_html(
        file_paths=[str(note)],
        include_linked_emails=True,
        optimize_tokens=True,
        include_email_recipients=True,
    )

    assert "<dt>宛先:</dt><dd>member@example.com</dd>" in html_content
    assert "quoted_to@example.com" in html_content
    assert "quoted_cc@example.com" in html_content


def test_html_excludes_recipients_without_token_optimization(tmp_path: Path) -> None:
    note = _note_with_mail(tmp_path)
    html_content, _ = export_documents_to_html(
        file_paths=[str(note)],
        include_linked_emails=True,
        optimize_tokens=False,
        include_email_recipients=False,
    )

    assert "quoted_to@example.com" not in html_content
    assert "quoted_cc@example.com" not in html_content


def test_markdown_excludes_recipients_by_default(tmp_path: Path) -> None:
    note = _note_with_mail(tmp_path)
    md_content, _, _ = export_documents_to_markdown_and_image(file_paths=[str(note)], vault_path=str(tmp_path))

    for address in ("member@example.com", "quoted_to@example.com", "quoted_cc@example.com"):
        assert address not in md_content
    assert "宛先およびCCは除外" in md_content
    assert "元の依頼本文です。" in md_content


def test_markdown_includes_recipients_when_enabled(tmp_path: Path) -> None:
    note = _note_with_mail(tmp_path)
    md_content, _, _ = export_documents_to_markdown_and_image(
        file_paths=[str(note)],
        vault_path=str(tmp_path),
        include_email_recipients=True,
    )

    assert "- **宛先**: member@example.com" in md_content
    assert "quoted_to@example.com" in md_content
    assert "quoted_cc@example.com" in md_content
    assert "宛先およびCCは除外" not in md_content


def test_api_passes_include_email_recipients(tmp_path: Path) -> None:
    note = _note_with_mail(tmp_path)
    client = TestClient(app)

    default = client.post("/api/export/ai-html", json={"file_paths": [str(note)]})
    assert default.status_code == 200
    assert "member@example.com" not in default.json()["html_content"]

    included = client.post("/api/export/ai-html", json={"file_paths": [str(note)], "include_email_recipients": True})
    assert included.status_code == 200
    assert "member@example.com" in included.json()["html_content"]

    bundle = client.post(
        "/api/export/ai-bundle/generate",
        json={"file_paths": [str(note)], "vault_path": str(tmp_path), "include_email_recipients": True},
    )
    assert bundle.status_code == 200
    assert "member@example.com" in bundle.json()["markdown_content"]
