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


def test_same_keywords_are_compiled_only_once_across_many_paths(monkeypatch) -> None:
    """検索結果1件ごとに除外キーワードを再コンパイルしない（件数に比例して検索が遅くなるため）。"""
    calls = {"count": 0}
    original = exclude_rules.compile_exclude_keywords

    def counting_compile(keywords):
        calls["count"] += 1
        return original(keywords)

    monkeypatch.setattr(exclude_rules, "compile_exclude_keywords", counting_compile)
    keywords = ["unique-cache-probe-old", "アーカイブ"]
    results = [_is_excluded(f"/docs/dir{index}/a.md", keywords) for index in range(50)]

    assert results == [False] * 50
    assert calls["count"] == 1
    assert _is_excluded("/docs/unique-cache-probe-old/a.md", keywords)


def test_changed_keywords_are_recompiled() -> None:
    """キーワード列が変わったら、以前の列の結果を使い回さない。"""
    assert _is_excluded("/docs/draft/a.md", ["draft"])
    assert not _is_excluded("/docs/draft/a.md", ["other-keyword"])
