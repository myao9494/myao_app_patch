"""
Dataview / DataviewJS 内のリンク抽出、Excalidraw図面ノート解決、および個別子ノード除外のテスト。
仕様:
- DataviewJS の noteListRows (JSON配列) や dv.page("...")、Dataview クエリからリンク先ノートを抽出する。
- [図面](http://localhost:3001/?filepath=...excalidraw.md) や ![[図面.excalidraw]] などの図面ノートを抽出・解決する。
- expand_linked_files に excluded_paths を指定した場合、該当パスが展開結果から除外される。
- 実ファイル システム_top.md から30件以上のリンクが漏れなく抽出・解決される。
"""

import os
from pathlib import Path
import pytest
from app.vector.link_expander import (
    extract_markdown_links,
    resolve_linked_note_file,
    expand_linked_files,
)
from app.vector.html_exporter import export_documents_to_html
from app.vector.markdown_image_exporter import export_documents_to_markdown_and_image


def test_extract_markdown_links_from_dataviewjs_json() -> None:
    """DataviewJS ブロック内の noteListRows (JSON配列) からパスが抽出されること"""
    content = """# note一覧
```dataviewjs
const noteListRows = [
    {"path":"01_data/2026/01/17/github.md","name":"github"},
    {"path":"01_data/2025/12/27/file_manager 個人開発.md","name":"file_manager 個人開発"}
];
```
"""
    links = extract_markdown_links(content)
    assert "01_data/2026/01/17/github.md" in links
    assert "01_data/2025/12/27/file_manager 個人開発.md" in links


def test_extract_markdown_links_from_dv_page_and_query() -> None:
    """dv.page('...') や dv.pages('...')、Dataview クエリからリンク先が抽出されること"""
    content = """
```dataviewjs
const p = dv.page("projects/Alpha.md");
const p2 = dv.page('Beta');
```
```dataview
TABLE file.ctime
FROM "01_data/tasks"
```
"""
    links = extract_markdown_links(content)
    assert "projects/Alpha.md" in links
    assert "Beta" in links
    assert "01_data/tasks" in links


def test_extract_markdown_links_from_filepath_url_and_excalidraw_embed() -> None:
    """filepath クエリを持つURLや ![[図面.excalidraw]] から図面ノートが抽出されること"""
    content = """
[図_システム_top](http://localhost:3001/?filepath=/Users/mine/000_work/obsidian-dagnetz/01_data/2026/03/06/%E5%9B%B3_%E3%82%B7%E3%82%B9%E3%83%86%E3%83%A0_top.excalidraw.md)
![[図_システム_top.excalidraw|1475]]
"""
    links = extract_markdown_links(content)
    # URLデコードされた filepath パスまたはファイル名が抽出されること
    assert any("図_システム_top.excalidraw" in l for l in links)


def test_expand_linked_files_supports_excluded_paths(tmp_path: Path) -> None:
    """expand_linked_files で excluded_paths が指定された場合、そのファイルが展開から除外されること"""
    note1 = tmp_path / "Root.md"
    note2 = tmp_path / "Child1.md"
    note3 = tmp_path / "Child2.md"

    note1.write_text("# Root\n- [[Child1]]\n- [[Child2]]\n", encoding="utf-8")
    note2.write_text("# Child1\n内容\n", encoding="utf-8")
    note3.write_text("# Child2\n内容\n", encoding="utf-8")

    # Child2 を除外指定
    expanded, meta = expand_linked_files(
        file_paths=[str(note1)],
        file_depths={str(note1): 1},
        vault_path=tmp_path,
        excluded_paths=[str(note3)],
    )

    assert str(note1.resolve()) in expanded
    assert str(note2.resolve()) in expanded
    assert str(note3.resolve()) not in expanded
    # meta["nodes"] にも Child2 が含まれないこと
    node_paths = [n["full_path"] for n in meta["nodes"]]
    assert str(note3.resolve()) not in node_paths


def test_system_top_real_file_extracts_all_dataview_and_wikilinks() -> None:
    """実際の システム_top.md から Dataview 内のノートを含めて30件以上のリンクが抽出・解決されること"""
    system_top = Path("/Users/mine/000_work/obsidian-dagnetz/01_data/2026/03/06/システム_top.md")
    if not system_top.exists():
        pytest.skip("実ファイル システム_top.md が存在しない環境のためスキップ")

    vault_path = Path("/Users/mine/000_work/obsidian-dagnetz")
    content = system_top.read_text(encoding="utf-8")
    links = extract_markdown_links(content)

    # 1. 抽出リンク数が30件以上であること（dataviewjs 32件 + 通常リンク16件）
    assert len(links) >= 30

    # 2. github.md や file_manager 個人開発.md が含まれていること
    assert any("github" in l for l in links)
    assert any("file_manager 個人開発" in l for l in links)

    # 3. 図面ノート（図_システム_top.excalidraw.md）が含まれていること
    assert any("図_システム_top.excalidraw" in l for l in links)

    # 4. expand_linked_files で展開できること (vault_path未指定でも自動検知されること)
    expanded, meta = expand_linked_files(
        file_paths=[str(system_top)],
        file_depths={str(system_top): 1},
        vault_path="",  # 未指定時
    )
    assert len(expanded) >= 30
