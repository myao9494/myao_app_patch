"""
テキストおよびMarkdownチャンキング最適化モジュール。
仕様:
- Markdownテキストから見出し階層（Header Breadcrumbs: # タイトル > ## セクション）を解析・保持。
- YAML Frontmatter メタデータ（tags, aliases, 検索用, category）を包括抽出・統合。
- YAML Frontmatter ヘッダー行自体の完全除去（本文プレーン化）。
- Obsidian wikilink ([[ノート名]] や [[ノート名|表示名]]) を自然言語プレーンテキストに展開。
- 画像・描画埋め込み (![[...]] や ![...](...)) の除去。
- Excalidraw描画データ (# Excalidraw Data 以降、%%...%%、compressed-jsonブロック) の完全除去。
- 短文ノートの欠落を防止し、見出し・段落境界を尊重して適応的に分割。
- 非Markdown文書（PDF, Word, TXT, Excel等）向けの汎用スライディングウィンドウ分割（chunk_text）を提供。
"""

import re
from dataclasses import dataclass, field
from typing import Any, List, Optional, Set, Tuple


@dataclass
class ChunkData:
    """チャンク情報を保持するデータクラス"""
    chunk_index: int
    text: str


@dataclass
class ExtractedMetadata:
    """Markdownから抽出されたメタデータ構造体"""
    tags: List[str] = field(default_factory=list)
    aliases: List[str] = field(default_factory=list)
    keywords: List[str] = field(default_factory=list)
    context_notes: List[str] = field(default_factory=list)


def extract_metadata_and_clean(
    text: str,
    glossary: Optional[Any] = None
) -> Tuple[str, ExtractedMetadata]:
    """
    MarkdownテキストからFrontmatterの各種メタデータ（tags, aliases, 検索用, category）や
    本文ハッシュタグを抽出し、ヘッダーやExcalidraw描画データを除去したクリーン本文とメタデータを返す。
    辞書（glossary）が渡された場合、本文中の専門用語から同義語・解説メタデータを自動補完する。
    """
    cleaned = text.strip()
    tags_set: Set[str] = set()
    aliases_set: Set[str] = set()
    keywords_set: Set[str] = set()
    context_notes_set: Set[str] = set()

    # 1. YAML Frontmatter の抽出と完全除去
    if cleaned.startswith("---"):
        parts = re.split(r"^---\s*$", cleaned, flags=re.MULTILINE)
        if len(parts) >= 3:
            frontmatter_content = parts[1]
            cleaned = "---".join(parts[2:]).strip()

            # ① tags の抽出
            m_tags_inline = re.search(r"^tags:\s*\[(.*?)\]", frontmatter_content, re.MULTILINE)
            if m_tags_inline:
                for t in m_tags_inline.group(1).split(","):
                    val = t.strip().strip("'\"")
                    if val:
                        tags_set.add(val)
            else:
                m_tags_block = re.search(r"^tags:\s*\n((?:\s*-\s*.+\n?)+)", frontmatter_content, re.MULTILINE)
                if m_tags_block:
                    for line in m_tags_block.group(1).splitlines():
                        val = re.sub(r"^\s*-\s*", "", line).strip().strip("'\"")
                        if val:
                            tags_set.add(val)

            # ② aliases の抽出
            m_aliases_inline = re.search(r"^aliases:\s*\[(.*?)\]", frontmatter_content, re.MULTILINE)
            if m_aliases_inline:
                for a in m_aliases_inline.group(1).split(","):
                    val = a.strip().strip("'\"")
                    if val:
                        aliases_set.add(val)
            else:
                m_aliases_block = re.search(r"^aliases:\s*\n((?:\s*-\s*.+\n?)+)", frontmatter_content, re.MULTILINE)
                if m_aliases_block:
                    for line in m_aliases_block.group(1).splitlines():
                        val = re.sub(r"^\s*-\s*", "", line).strip().strip("'\"")
                        if val:
                            aliases_set.add(val)

            # ③ 検索用 / category / keywords の抽出
            m_kw = re.search(r"^(?:検索用|keywords|category):\s*(.+)$", frontmatter_content, re.MULTILINE)
            if m_kw:
                for w in re.split(r"[\s,]+", m_kw.group(1)):
                    val = w.strip().strip("'\"")
                    if val:
                        keywords_set.add(val)

    # 2. # Excalidraw Data 以降のバイナリ・描画データを完全に切り捨て
    excal_split = re.split(r"(?i)^#+\s*Excalidraw\s+Data\b", cleaned, flags=re.MULTILINE)
    if len(excal_split) > 1:
        cleaned = excal_split[0].strip()

    # 3. Excalidraw 内部コメントブロック %% ... %% の除去
    cleaned = re.sub(r"%%.*?%%", "", cleaned, flags=re.DOTALL)

    # 4. 画像埋め込み・ファイル埋め込み ![[...]] および ![...](...) の除去
    cleaned = re.sub(r"!\[\[.*?\]\]", "", cleaned)
    cleaned = re.sub(r"!\[.*?\]\(.*?\)", "", cleaned)

    # 5. Obsidian wikilink の展開
    cleaned = re.sub(r"\[\[(?:[^\]\|]+\|)?([^\]]+)\]\]", r"\1", cleaned)

    # 6. 通常のMarkdownリンク [表示名](URL) -> 表示名 に変換
    cleaned = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", cleaned)

    # 7. 独立したURLの除去
    cleaned = re.sub(r"https?://\S+", "", cleaned)

    # 8. 本文中のハッシュタグ (#tag) の抽出
    for tag_match in re.findall(r"(?:^|\s)#([^\s#\.,;!?:/\\\[\]\(\)]+)", cleaned):
        if tag_match and not tag_match.startswith("#"):
            tags_set.add(tag_match)

    # 9. 専門用語辞書による自動補完（存在する場合）
    if glossary is not None:
        try:
            detected_items = glossary.detect_terms(cleaned)
            for item in detected_items:
                for s in item.get("synonyms", []):
                    if s:
                        aliases_set.add(s)
                desc = item.get("description", "")
                if desc:
                    context_notes_set.add(f"{item.get('term')}: {desc}")
        except Exception:
            pass

    return cleaned, ExtractedMetadata(
        tags=sorted(list(tags_set)),
        aliases=sorted(list(aliases_set)),
        keywords=sorted(list(keywords_set)),
        context_notes=sorted(list(context_notes_set))
    )


def _format_metadata_prefix(meta: ExtractedMetadata) -> str:
    """メタデータをチャンク先頭に埋め込むプレフィックス文字列を生成する"""
    parts = []
    if meta.tags:
        parts.append(f"[Tags: {' '.join('#' + t for t in meta.tags)}]")
    if meta.aliases:
        parts.append(f"[Aliases: {', '.join(meta.aliases)}]")
    if meta.keywords:
        parts.append(f"[Keywords: {', '.join(meta.keywords)}]")
    if meta.context_notes:
        parts.append(f"[Context: {'; '.join(meta.context_notes[:3])}]")
    return " ".join(parts)


def chunk_markdown(
    text: str,
    chunk_size: int = 500,
    chunk_overlap: int = 80,
    glossary: Optional[Any] = None
) -> List[ChunkData]:
    """
    Markdownテキストを構造・階層見出し（Breadcrumbs）を維持しながらチャンク分割する。
    """
    cleaned_body, meta = extract_metadata_and_clean(text, glossary=glossary)
    if not cleaned_body:
        meta_prefix = _format_metadata_prefix(meta)
        return [ChunkData(chunk_index=0, text=meta_prefix)] if meta_prefix else []

    meta_prefix = _format_metadata_prefix(meta)

    # 見出し階層管理用スタック: [(level, heading_text), ...]
    heading_stack: List[Tuple[int, str]] = []
    current_breadcrumbs = ""

    lines = cleaned_body.splitlines()
    sections: List[Tuple[str, str]] = []  # [(breadcrumbs, section_text), ...]
    current_section_lines: List[str] = []

    heading_pattern = re.compile(r"^(#{1,6})\s+(.+)$")

    for line in lines:
        m = heading_pattern.match(line)
        if m:
            if current_section_lines:
                sec_text = "\n".join(current_section_lines).strip()
                if sec_text:
                    sections.append((current_breadcrumbs, sec_text))
                current_section_lines = []

            level = len(m.group(1))
            heading_text = m.group(2).strip()

            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            heading_stack.append((level, heading_text))

            current_breadcrumbs = " > ".join(h[1] for h in heading_stack)
            current_section_lines.append(line)
        else:
            current_section_lines.append(line)

    if current_section_lines:
        sec_text = "\n".join(current_section_lines).strip()
        if sec_text:
            sections.append((current_breadcrumbs, sec_text))

    if not sections:
        full_text = f"{meta_prefix}\n{cleaned_body}".strip() if meta_prefix else cleaned_body
        return [ChunkData(chunk_index=0, text=full_text)]

    chunks: List[ChunkData] = []
    chunk_idx = 0

    for breadcrumb, sec_text in sections:
        header_prefix = ""
        if breadcrumb:
            header_prefix = f"[{breadcrumb}]"
        if meta_prefix:
            header_prefix = f"{meta_prefix} {header_prefix}".strip()

        prefix_len = len(header_prefix) + 1 if header_prefix else 0
        effective_chunk_size = max(150, chunk_size - prefix_len)

        paragraphs = re.split(r"\n\s*\n", sec_text)
        curr_buf = ""

        for p in paragraphs:
            p = p.strip()
            if not p:
                continue

            if not curr_buf:
                curr_buf = p
            elif len(curr_buf) + len(p) + 2 <= effective_chunk_size:
                curr_buf += "\n\n" + p
            else:
                chunk_str = f"{header_prefix}\n{curr_buf}".strip() if header_prefix else curr_buf
                chunks.append(ChunkData(chunk_index=chunk_idx, text=chunk_str))
                chunk_idx += 1

                if chunk_overlap > 0 and len(curr_buf) > chunk_overlap:
                    curr_buf = curr_buf[-chunk_overlap:] + "\n\n" + p
                else:
                    curr_buf = p

        if curr_buf:
            chunk_str = f"{header_prefix}\n{curr_buf}".strip() if header_prefix else curr_buf
            chunks.append(ChunkData(chunk_index=chunk_idx, text=chunk_str))
            chunk_idx += 1

    if not chunks:
        full_text = f"{meta_prefix}\n{cleaned_body}".strip() if meta_prefix else cleaned_body
        return [ChunkData(chunk_index=0, text=full_text)]

    return chunks


def chunk_text(
    text: str,
    chunk_size: int = 500,
    chunk_overlap: int = 80,
    header_prefix: Optional[str] = None
) -> List[ChunkData]:
    """
    非Markdown文書（PDF, Word, TXT, Excel等）や一般テキストをスライディングウィンドウで分割する。
    """
    stripped = text.strip()
    if not stripped:
        return []

    if len(stripped) <= chunk_size:
        full = f"{header_prefix}\n{stripped}".strip() if header_prefix else stripped
        return [ChunkData(chunk_index=0, text=full)]

    paragraphs = re.split(r"\n\s*\n", stripped)
    chunks: List[ChunkData] = []
    chunk_idx = 0
    curr_buf = ""

    prefix_len = len(header_prefix) + 1 if header_prefix else 0
    effective_size = max(150, chunk_size - prefix_len)

    for p in paragraphs:
        p = p.strip()
        if not p:
            continue

        # 段落自体が巨大な場合は文字単位スライス
        if len(p) > effective_size:
            start = 0
            while start < len(p):
                end = min(len(p), start + effective_size)
                segment = p[start:end].strip()
                if segment:
                    c_str = f"{header_prefix}\n{segment}".strip() if header_prefix else segment
                    chunks.append(ChunkData(chunk_index=chunk_idx, text=c_str))
                    chunk_idx += 1
                start += effective_size - chunk_overlap
            continue

        if not curr_buf:
            curr_buf = p
        elif len(curr_buf) + len(p) + 2 <= effective_size:
            curr_buf += "\n\n" + p
        else:
            c_str = f"{header_prefix}\n{curr_buf}".strip() if header_prefix else curr_buf
            chunks.append(ChunkData(chunk_index=chunk_idx, text=c_str))
            chunk_idx += 1
            if chunk_overlap > 0 and len(curr_buf) > chunk_overlap:
                curr_buf = curr_buf[-chunk_overlap:] + "\n\n" + p
            else:
                curr_buf = p

    if curr_buf:
        c_str = f"{header_prefix}\n{curr_buf}".strip() if header_prefix else curr_buf
        chunks.append(ChunkData(chunk_index=chunk_idx, text=c_str))

    return chunks
