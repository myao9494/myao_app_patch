"""
AIインプットエクスポート時のリンク先再帰展開（HTML・Markdown・画像）統合テスト。
仕様:
- export_documents_to_html に file_depths を渡すことでリンク先ノートがHTMLに含まれる。
- export_documents_to_markdown_and_image に file_depths を渡すことでリンク先ノートと画像がマークダウン・画像に含まれる。
- APIエンドポイント（/api/export/ai-html, /api/export/ai-bundle/save, /api/export/resolve-links）が file_depths を正しく処理する。
"""

import pytest
from pathlib import Path
from fastapi.testclient import TestClient
from app.main import app
from app.vector.html_exporter import export_documents_to_html
from app.vector.markdown_image_exporter import export_documents_to_markdown_and_image


def test_export_documents_to_html_with_file_depths(tmp_path: Path) -> None:
    """HTMLエクスポート時に指定階層数に応じてリンク先ノートが含まれること"""
    note1 = tmp_path / "Note1.md"
    note2 = tmp_path / "Note2.md"

    note1.write_text("# ノート1の見出し\n詳細はこちら: [[Note2]]\n", encoding="utf-8")
    note2.write_text("# ノート2の秘密情報\nリンク先の内容です。\n", encoding="utf-8")

    # 1. file_depths=0 の場合: Note1のみ
    html_0, stats_0 = export_documents_to_html(
        file_paths=[str(note1)],
        file_depths={str(note1): 0},
        vault_path=tmp_path,
    )
    assert "ノート1の見出し" in html_0
    assert "ノート2の秘密情報" not in html_0
    assert stats_0["total_documents"] == 1

    # 2. file_depths=1 の場合: Note1 + Note2
    html_1, stats_1 = export_documents_to_html(
        file_paths=[str(note1)],
        file_depths={str(note1): 1},
        vault_path=tmp_path,
    )
    assert "ノート1の見出し" in html_1
    assert "ノート2の秘密情報" in html_1
    assert stats_1["total_documents"] == 2


def test_export_documents_to_markdown_and_image_with_file_depths(tmp_path: Path) -> None:
    """マークダウン＆画像エクスポート時に指定階層数に応じてリンク先ノートと画像が含まれること"""
    note1 = tmp_path / "MainNote.md"
    note2 = tmp_path / "LinkedNote.md"

    note1.write_text("# メインノート\n関連資料: [[LinkedNote]]\n", encoding="utf-8")
    note2.write_text("# リンク先ノート\n重要な追加データです。\n", encoding="utf-8")

    # file_depths=1 でリンク先ノートを展開
    md_content, img_bytes, stats = export_documents_to_markdown_and_image(
        file_paths=[str(note1)],
        file_depths={str(note1): 1},
        vault_path=tmp_path,
    )

    assert "メインノート" in md_content
    assert "リンク先ノート" in md_content
    assert "重要な追加データです" in md_content
    assert stats["total_documents"] == 2


def test_api_resolve_links_endpoint(tmp_path: Path) -> None:
    """リンク展開プレビューAPI (/api/export/resolve-links) が展開後リストを返却すること"""
    client = TestClient(app)

    note1 = tmp_path / "Alpha.md"
    note2 = tmp_path / "Beta.md"

    note1.write_text("# Alpha\n[[Beta]]\n", encoding="utf-8")
    note2.write_text("# Beta\nEnd\n", encoding="utf-8")

    res = client.post(
        "/api/export/resolve-links",
        json={
            "file_paths": [str(note1)],
            "file_depths": {str(note1): 1},
            "vault_path": str(tmp_path),
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["success"] is True
    assert len(data["expanded_file_paths"]) == 2
    assert Path(data["expanded_file_paths"][0]).name == "Alpha.md"
    assert Path(data["expanded_file_paths"][1]).name == "Beta.md"
    assert data["stats"]["total_linked_files"] == 1


def test_export_documents_to_html_shows_hierarchy_in_toc_and_sections(tmp_path: Path) -> None:
    """HTMLの目次およびドキュメントヘッダーに階層レベルとリンク元が表示されること"""
    note1 = tmp_path / "ParentDoc.md"
    note2 = tmp_path / "ChildDoc.md"

    note1.write_text("# 親ドキュメント\n[[ChildDoc]]\n", encoding="utf-8")
    note2.write_text("# 子ドキュメント\n内容\n", encoding="utf-8")

    html_content, stats = export_documents_to_html(
        file_paths=[str(note1)],
        file_depths={str(note1): 1},
        vault_path=tmp_path,
    )

    # 1. 目次（TOC）に階層インデント・階層バッジ・リンク元が含まれること
    assert "階層 1" in html_content
    assert "リンク元: ParentDoc.md" in html_content
    assert "↳" in html_content

    # 2. ドキュメントセクションヘッダーに階層情報が含まれること
    assert "リンク先 [階層 1]" in html_content or "階層 1" in html_content
    # 統計情報に expanded_nodes が含まれること
    assert "expanded_nodes" in stats
    assert len(stats["expanded_nodes"]) == 2


def test_export_documents_to_markdown_shows_hierarchy_in_sections(tmp_path: Path) -> None:
    """マークダウンのセクション境界見出しに階層レベルとリンク元が表示されること"""
    note1 = tmp_path / "RootDoc.md"
    note2 = tmp_path / "SubDoc.md"

    note1.write_text("# ルート\n[[SubDoc]]\n", encoding="utf-8")
    note2.write_text("# サブ\n内容\n", encoding="utf-8")

    md_content, _, _ = export_documents_to_markdown_and_image(
        file_paths=[str(note1)],
        file_depths={str(note1): 1},
        vault_path=tmp_path,
    )

    # マークダウンの区切り見出しに階層情報が明記されること
    assert "[階層 1]" in md_content or "階層 1" in md_content
    assert "RootDoc.md" in md_content


def test_api_ai_html_endpoint_returns_expanded_nodes(tmp_path: Path) -> None:
    """/api/export/ai-html が expanded_nodes を返却し、フロントエンドでツリー表示できること"""
    client = TestClient(app)

    note1 = tmp_path / "TreeParent.md"
    note2 = tmp_path / "TreeChild.md"

    note1.write_text("# TreeParent\n[[TreeChild]]\n", encoding="utf-8")
    note2.write_text("# TreeChild\nEnd\n", encoding="utf-8")

    res = client.post(
        "/api/export/ai-html",
        json={
            "file_paths": [str(note1)],
            "file_depths": {str(note1): 1},
            "vault_path": str(tmp_path),
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert "expanded_nodes" in data
    assert len(data["expanded_nodes"]) == 2
    assert data["expanded_nodes"][1]["depth_level"] == 1
    assert data["expanded_nodes"][1]["parent_name"] == "TreeParent.md"

