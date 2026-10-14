"""
除外キーワードの判定（exclude_rules）のテスト。
名前形式のキーワードは語の区切りで一致させ、記号だけ・非 ASCII のキーワードは部分一致させる。
"""

from __future__ import annotations

from pathlib import Path

from app.services import exclude_rules


def _is_excluded(path: str, keywords: list[str]) -> bool:
    return exclude_rules.should_exclude_path(Path(path), keywords)


def test_ascii_word_keyword_matches_whole_names_and_tokens_only() -> None:
    assert _is_excluded("/docs/old/a.md", ["old"])
    assert _is_excluded("/docs/report_old.md", ["old"])
    assert not _is_excluded("/docs/older/a.md", ["old"])


def test_non_ascii_keyword_matches_as_substring() -> None:
    assert _is_excluded("/docs/2024年度アーカイブ資料/a.md", ["アーカイブ"])


def test_symbol_only_keyword_matches_as_substring() -> None:
    """`~$`（Office の一時ファイルの接頭辞）のような記号だけのキーワードは、名前の一部に含まれれば除外する。"""
    assert _is_excluded("/docs/~$draft.docx", ["~$"])
    assert _is_excluded("/docs/~$", ["~$"])
    assert not _is_excluded("/docs/draft.docx", ["~$"])


def test_single_symbol_and_dot_only_keywords_do_not_match_as_substring() -> None:
    """1 文字の記号やドットだけのキーワードを部分一致にすると、ほぼすべての名前に一致してしまう。"""
    assert not _is_excluded("/docs/report-final.md", ["-"])
    assert not _is_excluded("/docs/a.b..md", [".."])
    assert _is_excluded("/docs/-/a.md", ["-"])
