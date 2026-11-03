"""
検索結果の本文を、表示するページの分だけ読む仕様のテスト。

仕様:
- 一致件数が多くても、スニペットを作るのは表示するページの結果だけ。
- どの検索経路（高速ページング、全件取得、除外語つき、日本語 bi-gram、フォルダ統合）でも、
  スニペットの内容は本文を読む位置が変わっても同じになる。
- 除外語（`-語`）は、ファイル名・フォルダ名に加えて本文も判定する。
- 英数字混在語の本文検索は、大文字小文字を区別しない。
"""

import sqlite3
from pathlib import Path

import pytest

from app.db.schema import initialize_schema
from app.models.search import IndexedSearchRequest, SearchQueryParams
from app.services import search_snippets
from app.services.search_service import SearchService


@pytest.fixture
def service(tmp_path: Path):
    connection = sqlite3.connect(tmp_path / "search.db")
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    try:
        yield SearchService(connection=connection)
    finally:
        connection.close()


def _index(service: SearchService, target: Path) -> None:
    service.index_service.ensure_fresh_target(full_path=target.as_posix(), refresh_window_minutes=0, index_depth=5)


def _target_with_notes(tmp_path: Path, count: int) -> Path:
    target = (tmp_path / "work").resolve()
    target.mkdir()
    for index in range(count):
        (target / f"note{index}.md").write_text(f"前置き。apple 本文{index}。後書き。", encoding="utf-8")
    return target


def _count_snippets(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """本文からスニペットを作った回数を記録する。"""
    built: list[str] = []
    original = search_snippets.resolve_snippet

    def counting(**kwargs: object) -> str:
        built.append(str(kwargs.get("file_name")))
        return original(**kwargs)

    monkeypatch.setattr(search_snippets, "resolve_snippet", counting)
    return built


@pytest.mark.parametrize("search_target", ["body", "all"], ids=["高速ページング", "全件取得"])
def test_snippets_are_built_only_for_the_visible_page(
    service: SearchService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, search_target: str
) -> None:
    target = _target_with_notes(tmp_path, 12)
    _index(service, target)
    built = _count_snippets(monkeypatch)

    response = service.search(
        SearchQueryParams(q="apple", full_path=target.as_posix(), search_all_enabled=True, search_target=search_target, limit=3)
    )

    assert response.total == 12
    assert len(response.items) == 3
    assert sorted(built) == sorted(item.file_name for item in response.items)


@pytest.mark.parametrize("search_target", ["body", "all"], ids=["高速ページング", "全件取得"])
def test_every_page_has_a_snippet_from_its_own_body(service: SearchService, tmp_path: Path, search_target: str) -> None:
    target = _target_with_notes(tmp_path, 7)
    _index(service, target)

    seen: dict[str, str] = {}
    for offset in (0, 3, 6):
        response = service.search(
            SearchQueryParams(
                q="apple", full_path=target.as_posix(), search_all_enabled=True, search_target=search_target,
                limit=3, offset=offset,
            )
        )
        seen.update({item.file_name: item.snippet for item in response.items})

    assert len(seen) == 7
    for file_name, snippet in seen.items():
        number = file_name.removeprefix("note").removesuffix(".md")
        assert snippet == f"前置き。<mark>apple</mark> 本文{number}。後書き。"


def test_include_snippets_false_returns_empty_snippets(service: SearchService, tmp_path: Path, monkeypatch) -> None:
    target = _target_with_notes(tmp_path, 3)
    _index(service, target)
    built = _count_snippets(monkeypatch)

    response = service.search(
        SearchQueryParams(q="apple", full_path=target.as_posix(), search_all_enabled=True, include_snippets=False)
    )

    assert [item.snippet for item in response.items if item.result_kind == "file"] == ["", "", ""]
    assert built == []


def test_filename_match_without_body_hit_keeps_the_filename_message(service: SearchService, tmp_path: Path) -> None:
    target = (tmp_path / "work").resolve()
    target.mkdir()
    (target / "apple.md").write_text("果物の話", encoding="utf-8")
    _index(service, target)

    response = service.search(SearchQueryParams(q="apple", full_path=target.as_posix(), search_all_enabled=True))

    assert response.items[0].snippet.startswith("ファイル名一致: <mark>apple.md</mark>")


def test_body_only_search_uses_the_body_even_if_the_name_also_matches(service: SearchService, tmp_path: Path) -> None:
    target = (tmp_path / "work").resolve()
    target.mkdir()
    (target / "apple.md").write_text("apple の本文", encoding="utf-8")
    _index(service, target)

    response = service.search(
        SearchQueryParams(q="apple", full_path=target.as_posix(), search_all_enabled=True, search_target="body")
    )

    assert response.items[0].snippet == "<mark>apple</mark> の本文"


def test_japanese_partial_match_snippet_comes_from_the_body(service: SearchService, tmp_path: Path) -> None:
    target = (tmp_path / "work").resolve()
    target.mkdir()
    (target / "food.md").write_text("今日はお寿司を食べた", encoding="utf-8")
    _index(service, target)

    response = service.search(SearchQueryParams(q="寿司", full_path=target.as_posix(), search_all_enabled=True))

    assert [item.snippet for item in response.items] == ["今日はお<mark>寿司</mark>を食べた"]


def test_negative_term_in_body_excludes_the_file(service: SearchService, tmp_path: Path) -> None:
    target = (tmp_path / "work").resolve()
    target.mkdir()
    (target / "keep.md").write_text("apple only", encoding="utf-8")
    (target / "drop.md").write_text("apple and banana", encoding="utf-8")
    _index(service, target)

    response = service.search(SearchQueryParams(q="apple -banana", full_path=target.as_posix(), search_all_enabled=True))

    assert [item.file_name for item in response.items] == ["keep.md"]
    assert response.items[0].snippet == "<mark>apple</mark> only"


def test_negative_only_query_checks_the_body(service: SearchService, tmp_path: Path) -> None:
    target = (tmp_path / "work").resolve()
    target.mkdir()
    (target / "keep.md").write_text("apple only", encoding="utf-8")
    (target / "drop.md").write_text("banana here", encoding="utf-8")
    _index(service, target)

    response = service.search(SearchQueryParams(q="-banana", full_path=target.as_posix(), search_all_enabled=True))

    assert [item.file_name for item in response.items] == ["keep.md"]


def test_literal_body_search_ignores_ascii_case(service: SearchService, tmp_path: Path) -> None:
    """`mp3` のような英数字混在語は LIKE で探す。本文の大文字とも一致する。"""
    target = (tmp_path / "work").resolve()
    target.mkdir()
    (target / "song.md").write_text("形式は MP3 です", encoding="utf-8")
    _index(service, target)

    response = service.search(SearchQueryParams(q="mp3", full_path=target.as_posix(), search_all_enabled=True))

    assert [item.snippet for item in response.items] == ["形式は <mark>MP3</mark> です"]


def test_existing_index_search_returns_snippets(service: SearchService, tmp_path: Path) -> None:
    """ランチャーの既存DB検索も同じ結果を返す。"""
    target = _target_with_notes(tmp_path, 2)
    _index(service, target)

    response = service.search_existing_index(IndexedSearchRequest(q="apple", folder_path=target.as_posix(), limit=8))

    assert sorted(item.snippet for item in response.items) == [
        "前置き。<mark>apple</mark> 本文0。後書き。",
        "前置き。<mark>apple</mark> 本文1。後書き。",
    ]
