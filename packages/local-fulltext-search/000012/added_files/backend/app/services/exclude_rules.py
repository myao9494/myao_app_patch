"""
除外キーワードの解析と、パス・名前に対する除外判定。

仕様:
- 除外キーワードは 1 行 1 件。`/` または `\\` を含むものは「パス形式」、それ以外は「名前形式」として扱う。
- 名前形式: フォルダ名・ファイル名・ステム・ASCII 記号区切りトークンとの完全一致で判定する
  （`old` が `older` に誤一致しない）。
  語の区切りを持たないキーワードは部分一致で判定する: 非 ASCII を含むもの、および記号だけで 2 文字以上のもの
  （`~$` は `~$draft.docx` に一致する。ドットだけのものは、ほぼすべての名前に一致するため対象外）。
- パス形式: 絶対パス（`/foo`, `c:/foo`）は先頭一致、相対パス（`foo/bar`）は祖先の途中一致を許可する。
  `foo/.` は foo 配下のドット始まり要素をまとめて除外する。
- 全文インデックス・ベクトルインデックス・検索結果の絞り込みで同じ判定を共有する。
"""

from __future__ import annotations

import os
from pathlib import Path


def parse_exclude_keywords(value: str | None) -> list[str]:
    seen: set[str] = set()
    keywords: list[str] = []
    for line in (value or "").splitlines():
        keyword = line.strip()
        normalized_keyword = normalize_keyword_identity(keyword)
        if not keyword or normalized_keyword in seen:
            continue
        seen.add(normalized_keyword)
        keywords.append(keyword)
    return keywords


def normalize_keyword_identity(keyword: str) -> str:
    """
    除外キーワードの重複判定・差分判定に使うキーを返す。
    パス形式は大文字小文字を維持し、名前キーワードは小文字で同一視する。
    """
    return keyword if normalize_excluded_path_prefix(keyword) is not None else keyword.lower()


def normalize_keyword_list(keywords: list[str]) -> str:
    return "\n".join(parse_exclude_keywords("\n".join(keywords)))


def merge_exclude_keyword_strings(*values: str) -> str:
    merged: list[str] = []
    for value in values:
        merged.extend(parse_exclude_keywords(value))
    return normalize_keyword_list(merged)


def normalize_excluded_path_prefix(value: str | os.PathLike[str] | Path) -> str | None:
    """
    除外キーワードがフルパス形式なら比較しやすい表記へ正規化する。
    """
    raw_value = os.fspath(value).strip()
    if "/" not in raw_value and "\\" not in raw_value:
        return None
    normalized = raw_value.replace("\\", "/")
    if len(normalized) > 1:
        normalized = normalized.rstrip("/")
    return normalized


def compile_exclude_keywords(keywords: list[str]) -> tuple[frozenset[str], list[str], tuple[str, ...]]:
    """
    名前一致用キーワードとフルパス除外用プレフィックスを分離して前処理する。
    戻り値は（完全一致させる名前キーワード, 部分一致させる名前キーワード, パス形式のキーワード）。
    """
    name_keywords: list[str] = []
    path_prefixes: list[str] = []
    for keyword in keywords:
        normalized_path = normalize_excluded_path_prefix(keyword)
        if normalized_path is not None:
            path_prefixes.append(normalized_path)
            continue
        name_keywords.append(keyword)
    normalized_name_keywords = [keyword.lower() for keyword in name_keywords]
    keyword_set = frozenset(normalized_name_keywords)
    substring_keywords = [kw for kw in normalized_name_keywords if _matches_as_substring(kw)]
    return keyword_set, substring_keywords, tuple(path_prefixes)


def _matches_as_substring(keyword: str) -> bool:
    """語の区切りで判定できないキーワード（非 ASCII を含む、または記号だけ）かを返す。"""
    if any(ord(char) > 127 for char in keyword):
        return True
    is_symbol_only = not any(char.isalnum() for char in keyword)
    return is_symbol_only and len(keyword) >= 2 and keyword.strip(".") != ""


def should_exclude_path(path: Path, keywords: list[str]) -> bool:
    """
    パスの各パートが除外キーワードに一致するか判定する。検索サービスからも利用される。
    """
    if not keywords:
        return False
    keyword_set, substring_keywords, excluded_path_prefixes = compile_exclude_keywords(keywords)
    return should_exclude_path_with_keywords(path, keyword_set, substring_keywords, excluded_path_prefixes)


def should_exclude_path_with_keywords(path: Path,
    keyword_set: frozenset[str],
    substring_keywords: list[str],
    excluded_path_prefixes: tuple[str, ...],
) -> bool:
    """
    事前計算済みキーワード集合を用いてパス全体の除外判定を行う。
    """
    normalized_path = normalize_excluded_path_prefix(path)
    if normalized_path is not None and is_excluded_path_prefix(normalized_path, excluded_path_prefixes):
        return True
    return any(is_excluded_name(part, keyword_set, substring_keywords) for part in path.parts)


def is_excluded_path_prefix(normalized_path: str, excluded_path_prefixes: tuple[str, ...]) -> bool:
    """
    パス全体またはその祖先が除外パスキーワードに一致するか判定する。
    絶対パス指定は先頭一致、相対パス指定は祖先の途中一致を許可する。
    """
    for prefix in excluded_path_prefixes:
        if is_hidden_child_path_prefix(prefix):
            if matches_hidden_child_path_prefix(normalized_path, prefix):
                return True
            continue

        if is_absolute_excluded_path_prefix(prefix):
            if normalized_path == prefix or normalized_path.startswith(f"{prefix}/"):
                return True
            continue

        if normalized_path == prefix or normalized_path.startswith(f"{prefix}/"):
            return True

        bounded_prefix = f"/{prefix}"
        if normalized_path.endswith(bounded_prefix) or f"{bounded_prefix}/" in normalized_path:
            return True
    return False


def is_hidden_child_path_prefix(prefix: str) -> bool:
    """
    `foo/.` 形式は、foo 配下のドット始まり要素をまとめて除外するショートハンドとして扱う。
    """
    return prefix.endswith("/.")


def matches_hidden_child_path_prefix(normalized_path: str, prefix: str) -> bool:
    """
    `foo/.` 形式の除外キーワードが、foo 配下の `.bar` や `.baz/...` に一致するか判定する。
    """
    if normalized_path.startswith(prefix):
        return True

    if is_absolute_excluded_path_prefix(prefix):
        return False

    bounded_prefix = f"/{prefix}"
    return normalized_path.endswith(bounded_prefix) or bounded_prefix in normalized_path


def is_absolute_excluded_path_prefix(prefix: str) -> bool:
    """
    除外パスキーワードが絶対パスかどうかを判定する。
    `/foo/bar` と `c:/foo/bar` の両方を受け付ける。
    """
    if prefix.startswith("/"):
        return True
    return len(prefix) >= 3 and prefix[1] == ":" and prefix[2] == "/"


def is_excluded_name(name: str, keyword_set: frozenset[str], substring_keywords: list[str]) -> bool:
    """
    ディレクトリ名/ファイル名が除外キーワードに一致するか判定する。
    keyword_set による O(1) ルックアップで高速化。
    """
    lower_name = name.lower()
    stripped_name = lower_name.lstrip(".")
    if lower_name in keyword_set or stripped_name in keyword_set:
        return True
    stem = Path(lower_name).stem
    if stem in keyword_set or stem.lstrip(".") in keyword_set:
        return True
    for kw in substring_keywords:
        if kw in lower_name:
            return True
    tokens = set(split_ascii_tokens(lower_name))
    return bool(tokens & keyword_set)


def split_ascii_tokens(value: str) -> list[str]:
    """
    ASCII 記号で区切られたトークン列を返す。
    """
    token = []
    tokens: list[str] = []
    for char in value:
        if char.isascii() and char.isalnum():
            token.append(char)
            continue
        if token:
            tokens.append("".join(token))
            token.clear()
    if token:
        tokens.append("".join(token))
    return tokens
