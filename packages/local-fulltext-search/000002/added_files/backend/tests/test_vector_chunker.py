"""
チャンキングモジュール（chunker）の単体テスト。
MarkdownのFrontmatter/Excalidrawクレンジング、見出しパンくず、および非Markdown汎用テキスト分割を検証する。
"""

import pytest
from app.vector.chunker import (
    ChunkData,
    ExtractedMetadata,
    chunk_markdown,
    chunk_text,
    extract_metadata_and_clean,
)


def test_extract_metadata_and_clean_markdown() -> None:
    """YAML Frontmatter と Excalidraw 描画データが除去され、メタデータが正しく抽出されること"""
    md = """---
tags: [test, python]
aliases: [別名ノート]
検索用: 設計 仕様
---
# メインタイトル

これは [[ノートリンク|表示名]] のテストです。
#タグ1 も本文に含まれます。
![[画像.png]]

# Excalidraw Data
バイナリデータ等
"""
    cleaned, meta = extract_metadata_and_clean(md)
    assert "メインタイトル" in cleaned
    assert "表示名" in cleaned
    assert "ノートリンク" not in cleaned
    assert "画像.png" not in cleaned
    assert "Excalidraw Data" not in cleaned
    assert "バイナリデータ等" not in cleaned
    assert "tags:" not in cleaned

    assert "test" in meta.tags
    assert "python" in meta.tags
    assert "タグ1" in meta.tags
    assert "別名ノート" in meta.aliases
    assert "設計" in meta.keywords
    assert "仕様" in meta.keywords


def test_chunk_markdown_short_note() -> None:
    """短いMarkdownノートでも欠落せず1チャンク生成されること"""
    md = "# タイトル\n短いメモ内容です。"
    chunks = chunk_markdown(md, chunk_size=500)
    assert len(chunks) == 1
    assert "タイトル" in chunks[0].text
    assert "短いメモ内容" in chunks[0].text


def test_chunk_markdown_breadcrumbs() -> None:
    """見出し階層がパンくずとして各チャンクに含まれること"""
    md = """# 大見出し

段落1。

## 中見出し

中見出しの本文内容。

### 小見出し

小見出しの本文内容。
"""
    chunks = chunk_markdown(md, chunk_size=100)
    assert len(chunks) >= 2
    # 中見出しや小見出しのチャンクに親見出しが含まれること
    has_breadcrumb = any("大見出し" in c.text and "中見出し" in c.text for c in chunks)
    assert has_breadcrumb


def test_chunk_text_generic() -> None:
    """非Markdown（PDFやWord、TXT等のテキスト）が適切なサイズで分割されること"""
    text = "これはテスト文章です。\n" * 50  # 約600文字
    chunks = chunk_text(text, chunk_size=200, chunk_overlap=40)
    assert len(chunks) > 1
    assert all(isinstance(c, ChunkData) for c in chunks)
    assert chunks[0].chunk_index == 0
    assert chunks[1].chunk_index == 1


def test_chunk_text_empty_and_short() -> None:
    """空文字または短いテキストでも安全に動作すること"""
    assert chunk_text("") == []
    short_chunks = chunk_text("一行だけの文章です。")
    assert len(short_chunks) == 1
    assert short_chunks[0].text == "一行だけの文章です。"
