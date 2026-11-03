"""
検索結果の除外判定（search_result_items.should_exclude_search_result）のテスト。
結果1件ごとに呼ばれるため、実ファイルシステムへ触れず（Path.resolve を呼ばず）、結果が変わらないことを確かめる。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services import search_result_items


def _exclude(candidate: str, keywords: list[str], target: str = "") -> bool:
    return search_result_items.should_exclude_search_result(
        target_path=target,
        candidate_path=candidate,
        excluded_keywords=keywords,
    )


@pytest.fixture
def forbid_resolve(monkeypatch):
    """DB 保存済みの正規化済みパスを再度 resolve（実ファイルへのアクセス）しないことを保証する。"""

    def fail(self, *args, **kwargs):
        raise AssertionError(f"Path.resolve が呼ばれた: {self}")

    monkeypatch.setattr(Path, "resolve", fail)


def test_exclusion_does_not_touch_the_filesystem(forbid_resolve) -> None:
    keywords = ["draft", "node_modules"]
    assert _exclude("/no/such/dir/draft/a.md", keywords)
    assert _exclude("/no/such/dir/node_modules/pkg/a.md", keywords, target="/no/such/dir")
    assert not _exclude("/no/such/dir/notes/a.md", keywords)
    assert not _exclude("/no/such/dir/notes/a.md", keywords, target="/no/such/dir")


def test_exclusion_results_are_unchanged() -> None:
    keywords = ["draft", "~$", "アーカイブ", "/no/such/dir/private"]
    assert _exclude("/no/such/dir/draft_v2/a.md", keywords)  # `_` は語の区切り
    assert not _exclude("/no/such/dir/drafty/a.md", keywords)  # 語の一部だけの一致は除外しない
    assert _exclude("/no/such/dir/draft/a.md", keywords)
    assert _exclude("/no/such/dir/~$tmp.docx", keywords)
    assert _exclude("/no/such/dir/2024アーカイブ/a.md", keywords)
    assert _exclude("/no/such/dir/private/a.md", keywords)
    assert not _exclude("/no/such/dir/privately/a.md", keywords)
    assert _exclude("https://example.com/draft/page", ["draft"])
    assert not _exclude("https://example.com/page", ["draft"])


def test_target_folder_name_itself_is_not_matched_as_excluded() -> None:
    """検索対象フォルダ自身の名前に除外語があっても、その配下の相対パスだけで判定する。"""
    assert not _exclude("/no/such/draft/notes/a.md", ["draft"], target="/no/such/draft")
    assert _exclude("/no/such/draft/draft/a.md", ["draft"], target="/no/such/draft")
