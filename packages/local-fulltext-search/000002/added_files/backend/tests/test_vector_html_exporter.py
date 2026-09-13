"""
AIコンテキストHTMLエクスポート（HtmlExporter）の単体テスト。
自己完結型HTML生成、目次、AIプロンプト埋め込み、Markdownレンダリングを検証する。
"""

import pytest
from pathlib import Path
from app.vector.html_exporter import export_documents_to_html


def test_export_documents_to_html(tmp_path: Path) -> None:
    """Markdownファイルから自己完結HTMLが生成され、タイトル・プロンプト・本文が含まれること"""
    doc1 = tmp_path / "doc1.md"
    doc1.write_text("# 設計方針\nシステムの基本アーキテクチャについて。", encoding="utf-8")

    doc2 = tmp_path / "doc2.md"
    doc2.write_text("# 要件定義\n機能要件一覧と非機能要件。", encoding="utf-8")

    html_content, stats = export_documents_to_html(
        file_paths=[str(doc1), str(doc2)],
        prompt="この設計書の課題をレビューしてください。",
        title="統合仕様書",
        include_raw_markdown=True,
    )

    assert stats["total_documents"] == 2
    assert "<!DOCTYPE html>" in html_content
    assert "統合仕様書" in html_content
    assert "この設計書の課題をレビューしてください。" in html_content
    assert "設計方針" in html_content
    assert "要件定義" in html_content
    assert "マークダウンファイルの元データ" in html_content
