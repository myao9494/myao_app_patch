"""
検索結果に表示する抜粋（スニペット）の生成。

一致した語を <mark> で囲んだ HTML を返す。本文やファイル名は必ず HTML エスケープしてから強調する。
"""

from __future__ import annotations

import re
from html import escape

from app.services import search_query

# 一致箇所の前後に表示する文字数
SNIPPET_CONTEXT_CHARS = 48


def resolve_snippet(
    *,
    snippet: object,
    file_name: str,
    segment_type: str = "filename",
    body_content: object = None,
    folder_path: str = "",
    query: str = "",
    highlight_terms: list[str] | None = None,
) -> str:
    """
    一致した種類（本文・フォルダ名・ファイル名）に応じたスニペットを返す。
    本文やフォルダ名に検索語がそのまま見つからないときは、ファイル名一致の説明文を返す。
    """
    terms = highlight_terms or search_query.flatten_highlight_terms(search_query.split_search_terms(query)[0])
    if segment_type in {"body", "cjk_bigram"}:
        literal_snippet = build_literal_snippet(content=str(body_content or ""), highlight_terms=terms)
        if literal_snippet is not None:
            return literal_snippet
    if segment_type == "folder":
        literal_snippet = build_literal_snippet(content=folder_path, highlight_terms=terms)
        if literal_snippet is not None:
            return f"フォルダー名一致: {literal_snippet}"
    if isinstance(snippet, str) and snippet.strip():
        return snippet
    escaped_name = escape(file_name)
    return (
        f"ファイル名一致: <mark>{escaped_name}</mark>。"
        " 本文中には検索語の直接一致が見つからなかったため、"
        "ファイル名ベースの候補として表示しています。"
    )


def build_literal_snippet(*, content: str, highlight_terms: list[str]) -> str | None:
    """
    本文ヒットでは、検索語をなるべく同じ抜粋に含めてハイライト表示する。
    """
    if not content or not highlight_terms:
        return None

    lowered_content = content.lower()
    term_ranges: list[tuple[int, int]] = []
    for term in highlight_terms:
        start = lowered_content.find(term.lower())
        if start < 0:
            continue
        term_ranges.append((start, start + len(term)))

    if not term_ranges:
        return None

    start = min(item[0] for item in term_ranges)
    end = max(item[1] for item in term_ranges)
    snippet_start = max(start - SNIPPET_CONTEXT_CHARS, 0)
    snippet_end = min(end + SNIPPET_CONTEXT_CHARS, len(content))
    prefix = "..." if snippet_start > 0 else ""
    suffix = "..." if snippet_end < len(content) else ""
    snippet_text = content[snippet_start:snippet_end]
    highlighted = escape(snippet_text)
    for term in sorted(set(highlight_terms), key=len, reverse=True):
        highlighted = re.sub(
            re.escape(escape(term)),
            lambda match: f"<mark>{match.group(0)}</mark>",
            highlighted,
            flags=re.IGNORECASE,
        )
    return f"{prefix}{highlighted}{suffix}"


def build_regex_snippet(
    *,
    content: str,
    file_name: str,
    folder_path: str,
    content_match: re.Match[str] | None,
    file_name_match: re.Match[str] | None,
    folder_path_match: re.Match[str] | None,
) -> str:
    """
    正規表現検索の結果用に、最初の一致箇所を短い抜粋として整形する。
    """
    if content_match is not None:
        snippet_start = max(content_match.start() - SNIPPET_CONTEXT_CHARS, 0)
        snippet_end = min(content_match.end() + SNIPPET_CONTEXT_CHARS, len(content))
        prefix = "..." if snippet_start > 0 else ""
        suffix = "..." if snippet_end < len(content) else ""
        before = escape(content[snippet_start:content_match.start()])
        matched = escape(content[content_match.start() : content_match.end()])
        after = escape(content[content_match.end() : snippet_end])
        return f"{prefix}{before}<mark>{matched}</mark>{after}{suffix}"

    if file_name_match is not None:
        start = file_name_match.start()
        end = file_name_match.end()
        return (
            "ファイル名一致: "
            f"{escape(file_name[:start])}<mark>{escape(file_name[start:end])}</mark>{escape(file_name[end:])}"
        )

    if folder_path_match is not None:
        start = folder_path_match.start()
        end = folder_path_match.end()
        return (
            "フォルダー名一致: "
            f"{escape(folder_path[:start])}<mark>{escape(folder_path[start:end])}</mark>{escape(folder_path[end:])}"
        )

    return resolve_snippet(snippet=None, file_name=file_name, folder_path=folder_path)
