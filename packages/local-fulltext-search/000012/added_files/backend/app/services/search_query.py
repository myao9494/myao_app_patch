"""
検索語の解析（DB に依存しない純粋関数）。

- 入力は空白区切りの AND。`OR` / `or` でつないだ語は同じグループ（どれかに一致すればよい）になる。
- `-語` は除外語。`\\-語` や `\\OR` のように `\\` を付けると通常の語として扱う。
- 類似語リストに含まれる語は、同じグループの候補へ展開する。
- 利用者の入力は FTS5 の構文としては解釈しない。必ず引用符で囲んだ語として渡す。
"""

from __future__ import annotations

import re
import unicodedata

from fastapi import HTTPException, status

from app.services import app_settings_store


def split_search_terms(value: str) -> tuple[list[list[str]], list[str]]:
    """
    利用者入力を空白および OR / or 演算子で区切り、ORグループのリスト (AND結合) と `-keyword` の除外語へ分離する。
    `\\-keyword` や `\\OR`, `\\or` はエスケープされた通常語として扱う。
    ただし全語が `-` 始まりのときなどは従来互換のため通常語として扱う。
    """
    raw_tokens = [item for item in value.split() if item]
    if not raw_tokens:
        return [], []

    processed_tokens: list[tuple[str, str]] = []
    for token in raw_tokens:
        if token.startswith("\\-") or (token.startswith(("\\or", "\\OR", "\\Or", "\\oR")) and len(token) == 3):
            processed_tokens.append(("TERM", token[1:]))
        elif token.startswith("-") and len(token) > 1:
            processed_tokens.append(("EXCLUDE", token[1:]))
        elif token.lower() == "or":
            processed_tokens.append(("OR", token))
        else:
            processed_tokens.append(("TERM", token))

    term_count = sum(1 for tag, _ in processed_tokens if tag == "TERM")
    exclude_terms: list[str] = [val for tag, val in processed_tokens if tag == "EXCLUDE"]
    if term_count == 0:
        if exclude_terms:
            return [], exclude_terms
        fallback_terms = [[term] for term in raw_tokens if term]
        return fallback_terms, []

    groups: list[list[str]] = []
    current_group: list[str] = []
    in_or = False

    for tag, val in processed_tokens:
        if tag == "EXCLUDE":
            continue
        if tag == "OR":
            if current_group:
                in_or = True
        elif tag == "TERM":
            if in_or and current_group:
                current_group.append(val)
                in_or = False
            else:
                if current_group:
                    groups.append(current_group)
                current_group = [val]
                in_or = False

    if current_group:
        groups.append(current_group)

    if not groups:
        fallback_terms = [[term] for term in raw_tokens if term]
        return fallback_terms, []

    return groups, exclude_terms


def expand_include_terms_with_synonyms(include_terms: list[list[str]], synonym_groups_text: str) -> list[list[str]]:
    """
    同義語リストに含まれる語は OR 条件の候補へ展開し、各入力語は「同じキーワード」として扱う。
    """
    synonym_groups = app_settings_store.parse_synonym_groups(synonym_groups_text)
    expanded_terms: list[list[str]] = []
    for group in include_terms:
        seen: set[str] = set()
        expanded_group: list[str] = []
        for term in group:
            normalized_term = term.casefold()
            matched_group = next(
                (candidate_group for candidate_group in synonym_groups if any(candidate.casefold() == normalized_term for candidate in candidate_group)),
                None,
            )
            candidates = [term, *matched_group] if matched_group else [term]
            for candidate in candidates:
                normalized_candidate = candidate.casefold()
                if normalized_candidate in seen:
                    continue
                seen.add(normalized_candidate)
                expanded_group.append(candidate)
        if expanded_group:
            expanded_terms.append(expanded_group)
    return expanded_terms


def flatten_highlight_terms(expanded_include_terms: list[list[str]]) -> list[str]:
    """
    スニペット生成では、入力語だけでなく同義語展開後の候補もまとめてハイライト対象にする。
    """
    seen: set[str] = set()
    highlight_terms: list[str] = []
    for group in expanded_include_terms:
        for term in group:
            normalized_term = term.casefold()
            if normalized_term in seen:
                continue
            seen.add(normalized_term)
            highlight_terms.append(term)
    return highlight_terms


def matches_excluded_search_terms(
    *,
    file_name: str,
    body_content: str,
    folder_path: str,
    exclude_terms: list[str],
) -> bool:
    """
    `-keyword` 指定の語がファイル名・フォルダーパス・本文に含まれる候補は除外する。
    """
    if not exclude_terms:
        return False

    lowered_file_name = file_name.lower()
    lowered_body_content = body_content.lower()
    lowered_folder_path = folder_path.lower()
    for term in exclude_terms:
        lowered_term = term.lower()
        if (
            lowered_term in lowered_file_name
            or lowered_term in lowered_body_content
            or lowered_term in lowered_folder_path
        ):
            return True
    return False


def normalize_query_for_history(query: str) -> str:
    """
    検索履歴のキーをUnicode正規化し、空白と大文字小文字の差を吸収する。
    """
    return " ".join(unicodedata.normalize("NFKC", query).casefold().split())


def search_target_includes_body(search_target: str) -> bool:
    """
    検索種別が本文検索を含むかを返す。
    """
    return search_target in {"all", "body"}


def search_target_includes_filename(search_target: str) -> bool:
    """
    検索種別がファイル名検索を含むかを返す。
    """
    return search_target in {"all", "filename", "filename_and_folder"}


def search_target_includes_folder(search_target: str) -> bool:
    """
    検索種別がフォルダー名検索を含むかを返す。
    """
    return search_target in {"all", "folder", "filename_and_folder"}


def should_use_literal_term_search(term: str) -> bool:
    """
    先頭が `-` の語や `mp3` のような英数字混在語は FTS5 MATCH で取りこぼすことがあるため、
    LIKE ベースの文字列検索へ切り替える。
    """
    return term.startswith("-") or contains_ascii_letters_and_digits(term)


def contains_ascii_letters_and_digits(term: str) -> bool:
    """
    ASCII 英字と数字を両方含む検索語かどうかを返す。
    `mp3`, `h264`, `mp4a` などの語は SQLite の標準 tokenizer で安定しないため特別扱いする。
    """
    has_ascii_letter = any(("a" <= char.lower() <= "z") for char in term)
    has_digit = any(char.isdigit() for char in term)
    return has_ascii_letter and has_digit


def should_use_filename_fts(term: str) -> bool:
    """
    trigram FTS は 3 文字以上の部分一致で有効に使い、短すぎる語だけ LIKE へフォールバックする。
    """
    return len(term) >= 3


def quote_fts_term(term: str) -> str:
    escaped_term = term.replace('"', '""')
    return f'"{escaped_term}"'


def build_fts_content_query(query: str) -> str:
    """
    FTS5 の本文検索は content カラムだけへ限定し、segment_label 側の誤一致を避ける。
    """
    return f"content:({query})"


def escape_like_pattern(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def compile_regex(pattern: str) -> re.Pattern[str]:
    """
    不正な正規表現は 400 系エラーとして利用者に返す。
    """
    try:
        return re.compile(pattern, re.IGNORECASE)
    except re.error as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"正規表現が不正です: {error}",
        ) from error
