"""
ノート間リンク（WikiLink・Markdownリンク）の再帰的展開（LinkExpander）のテスト。
仕様:
- 各Markdownファイル内の [[リンク先]] や [表示名](リンク先) を抽出する。
- 指定された階層数 (depth) に応じて、リンク先のノートを再帰的にコンテキストへ取り込む。
- 循環リンク (A -> B -> A) や多重リンクを重複なく安全に処理する。
- ファイルごとに個別の階層数を指定可能（未指定時は topタグあり: 5, なし: 1）。
"""

import pytest
from pathlib import Path
from app.vector.link_expander import (
    extract_markdown_links,
    expand_linked_files,
    resolve_linked_note_file,
    get_default_link_depth,
)


def test_extract_markdown_links() -> None:
    """Markdown本文から内部リンク（WikiLinkおよびMarkdownリンク）を正確に抽出すること"""
    content = """# テストノート
これは [[ノートB]] へのリンクです。
エイリアス付き: [[ノートC|表示名C]]
見出し付き: [[ノートD#セクション1]]
見出し＋別名: [[ノートE#概要|概要へ]]
通常マークダウンリンク: [ノートF](./sub/NoteF.md)
別フォルダのリンク: [ノートG](../other/NoteG)
画像埋め込み（除外対象）: ![[my_diagram.png]]
画像マークダウン（除外対象）: ![画像](./images/photo.jpg)
外部リンク（除外対象）: [Google](https://www.google.com)
メールリンク（除外対象）: [[discussion.eml]]
アンカーリンク（除外対象）: [内部リンク](#section-one)
"""
    links = extract_markdown_links(content)
    assert "ノートB" in links
    assert "ノートC" in links
    assert "ノートD" in links
    assert "ノートE" in links
    assert "./sub/NoteF.md" in links
    assert "../other/NoteG" in links
    # 除外されるべきもの
    assert "my_diagram.png" not in links
    assert "./images/photo.jpg" not in links
    assert "https://www.google.com" not in links
    assert "discussion.eml" not in links
    assert "#section-one" not in links


def test_get_default_link_depth(tmp_path: Path) -> None:
    """topタグがあるノートは階層5、ないノートは階層1がデフォルトであること"""
    top_note = tmp_path / "top_note.md"
    top_note.write_text(
        """---
tags:
  - top
  - project
---
# Top Note
""",
        encoding="utf-8",
    )

    normal_note = tmp_path / "normal_note.md"
    normal_note.write_text(
        """---
tags:
  - memo
---
# Normal Note
""",
        encoding="utf-8",
    )

    assert get_default_link_depth(str(top_note)) == 5
    assert get_default_link_depth(str(normal_note)) == 1


def test_expand_linked_files_depth_and_circular(tmp_path: Path) -> None:
    """指定された階層数に応じてリンク先が展開され、循環参照が安全に停止すること"""
    # A -> B -> C -> A (循環)
    note_a = tmp_path / "NoteA.md"
    note_b = tmp_path / "NoteB.md"
    note_c = tmp_path / "NoteC.md"
    note_d = tmp_path / "NoteD.md"

    note_a.write_text("# Note A\n[[NoteB]]\n", encoding="utf-8")
    note_b.write_text("# Note B\n[[NoteC]]\n", encoding="utf-8")
    note_c.write_text("# Note C\n[[NoteA]]\n[[NoteD]]\n", encoding="utf-8")
    note_d.write_text("# Note D\n終端\n", encoding="utf-8")

    # 1. depth = 0: ルート自身のみ
    res_0, _ = expand_linked_files([str(note_a)], file_depths={str(note_a): 0}, vault_path=tmp_path)
    assert [Path(p).name for p in res_0] == ["NoteA.md"]

    # 2. depth = 1: NoteA -> NoteB
    res_1, _ = expand_linked_files([str(note_a)], file_depths={str(note_a): 1}, vault_path=tmp_path)
    assert [Path(p).name for p in res_1] == ["NoteA.md", "NoteB.md"]

    # 3. depth = 2: NoteA -> NoteB -> NoteC
    res_2, _ = expand_linked_files([str(note_a)], file_depths={str(note_a): 2}, vault_path=tmp_path)
    assert [Path(p).name for p in res_2] == ["NoteA.md", "NoteB.md", "NoteC.md"]

    # 4. depth = 3: NoteA -> NoteB -> NoteC -> NoteD (NoteAは既出なので循環停止)
    res_3, _ = expand_linked_files([str(note_a)], file_depths={str(note_a): 3}, vault_path=tmp_path)
    assert [Path(p).name for p in res_3] == ["NoteA.md", "NoteB.md", "NoteC.md", "NoteD.md"]


def test_expand_linked_files_individual_depths(tmp_path: Path) -> None:
    """各ルートファイルごとに異なる階層数が正確に適用されること"""
    note_root1 = tmp_path / "Root1.md"
    note_sub1 = tmp_path / "Sub1.md"
    note_sub2 = tmp_path / "Sub2.md"

    note_root2 = tmp_path / "Root2.md"
    note_sub3 = tmp_path / "Sub3.md"

    note_root1.write_text("# Root1\n[[Sub1]]\n", encoding="utf-8")
    note_sub1.write_text("# Sub1\n[[Sub2]]\n", encoding="utf-8")
    note_sub2.write_text("# Sub2\nEnd\n", encoding="utf-8")

    note_root2.write_text("# Root2\n[[Sub3]]\n", encoding="utf-8")
    note_sub3.write_text("# Sub3\nEnd\n", encoding="utf-8")

    # Root1 は depth=2 (Sub1, Sub2まで展開)、Root2 は depth=0 (展開なし)
    file_depths = {
        str(note_root1): 2,
        str(note_root2): 0,
    }
    result_paths, meta = expand_linked_files(
        [str(note_root1), str(note_root2)],
        file_depths=file_depths,
        vault_path=tmp_path,
    )

    names = [Path(p).name for p in result_paths]
    assert names == ["Root1.md", "Sub1.md", "Sub2.md", "Root2.md"]
    assert meta["total_root_files"] == 2
    assert meta["total_linked_files"] == 2
    assert meta["total_expanded_files"] == 4


def test_expand_linked_files_node_metadata(tmp_path: Path) -> None:
    """展開されたノードごとの階層レベル（depth_level）や親ノート情報が返却されること"""
    note_a = tmp_path / "NoteA.md"
    note_b = tmp_path / "NoteB.md"
    note_c = tmp_path / "NoteC.md"

    note_a.write_text("---\ntags:\n  - top\n---\n# Note A\n[[NoteB]]\n", encoding="utf-8")
    note_b.write_text("# Note B\n[[NoteC]]\n", encoding="utf-8")
    note_c.write_text("# Note C\nEnd\n", encoding="utf-8")

    _, meta = expand_linked_files([str(note_a)], file_depths={str(note_a): 2}, vault_path=tmp_path)

    nodes = meta.get("nodes", [])
    assert len(nodes) == 3

    # NoteA (ルート: depth 0)
    node_a = nodes[0]
    assert node_a["file_name"] == "NoteA.md"
    assert node_a["depth_level"] == 0
    assert node_a["root_path"] == str(note_a.resolve())
    assert node_a["parent_path"] is None
    assert node_a["has_top_tag"] is True

    # NoteB (リンク先: depth 1)
    node_b = nodes[1]
    assert node_b["file_name"] == "NoteB.md"
    assert node_b["depth_level"] == 1
    assert node_b["root_path"] == str(note_a.resolve())
    assert node_b["parent_name"] == "NoteA.md"
    assert node_b["has_top_tag"] is False

    # NoteC (リンク先: depth 2)
    node_c = nodes[2]
    assert node_c["file_name"] == "NoteC.md"
    assert node_c["depth_level"] == 2
    assert node_c["root_path"] == str(note_a.resolve())
    assert node_c["parent_name"] == "NoteB.md"

