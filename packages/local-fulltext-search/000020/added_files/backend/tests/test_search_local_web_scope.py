"""
source_type=local_web（WPF ランチャーの検索）の対象解決と、検索前のインデックス更新を検証する。

- フォルダ未指定の local_web は、登録済みのローカルフォルダと Web URL の両方を対象にする。
- Web 対象の更新は、検索リクエストの階層・除外語ではなく、登録時の階層と Web 用除外語で巡回する。
- 検索方式（hybrid / vector / keyword）によらず、更新 ON なら検索の前に更新する。
- skip_refresh / 全DB検索 / 既存DB専用検索では、どの対象も更新しない。
"""

import sqlite3
from pathlib import Path

import pytest

from app.db.schema import initialize_schema
from app.models.search import IndexedSearchRequest, SearchQueryParams
from app.services.index_service import IndexService
from app.services.search_dispatcher import dispatch_search
from app.services.search_service import SearchService
from app.services.web_browser_fetcher import BrowserWebFetcherError
from app.vector.state import vector_state

BASE_URL = "https://example.test/docs/"


def _create_connection(tmp_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(tmp_path / "search.db")
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON;")
    initialize_schema(connection)
    return connection


def _page(title: str, body: str, *links: str) -> str:
    anchors = "".join(f'<a href="{link}">{link}</a>' for link in links)
    return f"<html><head><title>{title}</title></head><body><main>{body} {anchors}</main></body></html>"


def _serve_web_pages(monkeypatch: pytest.MonkeyPatch, pages: dict[str, str]) -> list[str]:
    """Web ページの取得を差し替え、取得した URL の一覧を返す（実際の通信はしない）。"""
    fetched: list[str] = []

    def fetch(url: str) -> str:
        fetched.append(url)
        if url not in pages:
            raise OSError(f"not found: {url}")
        return pages[url]

    monkeypatch.setattr("app.services.web_pages.fetch_web_page", fetch)
    return fetched


def _register_target(
    connection: sqlite3.Connection,
    full_path: str,
    *,
    source_type: str,
    is_enabled: bool = True,
    index_depth: int = 3,
) -> None:
    """検索対象の行だけを登録する（巡回はしない）。"""
    connection.execute(
        """
        INSERT INTO targets(
            full_path, last_indexed_at, exclude_keywords, index_depth, selected_extensions,
            is_search_target_enabled, indexed_file_count, index_version, source_type, created_at, updated_at
        ) VALUES (?, NULL, '', ?, '', ?, 0, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """,
        (full_path, index_depth, 1 if is_enabled else 0, source_type),
    )
    connection.commit()


def _insert_web_page(connection: sqlite3.Connection, url: str, body: str) -> None:
    """検索対象の巡回を通さず、Web ページの行を直接投入する。"""
    cursor = connection.execute(
        """
        INSERT INTO files(
            full_path, normalized_path, file_name, file_ext, created_at, mtime, size, indexed_at, source_type
        ) VALUES (?, ?, 'Web Page', '', 0, 0, 1, '2026-01-01T00:00:00+00:00', 'web')
        """,
        (url, url),
    )
    connection.execute(
        "INSERT INTO file_segments(file_id, segment_type, segment_label, content) VALUES (?, 'body', 'body', ?)",
        (cursor.lastrowid, body),
    )
    connection.commit()


def _update_on_params(q: str) -> SearchQueryParams:
    """WPF ランチャーが「更新」チェック ON で送る検索条件。"""
    return SearchQueryParams(
        q=q,
        full_path="",
        search_all_enabled=False,
        skip_refresh=False,
        source_type="local_web",
        refresh_window_minutes=0,
    )


def test_local_web_scope_paths_include_local_and_web_targets(tmp_path: Path) -> None:
    connection = _create_connection(tmp_path)
    _register_target(connection, tmp_path.as_posix(), source_type="local")
    _register_target(connection, BASE_URL, source_type="web")

    service = IndexService(connection=connection)

    assert service.list_search_scope_paths(source_type="local_web") == [tmp_path.resolve().as_posix(), BASE_URL]
    assert service.list_search_scope_paths(source_type="local") == [tmp_path.resolve().as_posix()]
    assert service.list_search_scope_paths(source_type="web") == [BASE_URL]


def test_local_web_scope_falls_back_for_each_source_separately(tmp_path: Path) -> None:
    """有効な対象が 0 件のときの全登録へのフォールバックは、ローカルと Web で別々に判定する。"""
    connection = _create_connection(tmp_path)
    disabled_folder = (tmp_path / "disabled").as_posix()
    disabled_url = "https://example.test/disabled/"
    _register_target(connection, disabled_folder, source_type="local", is_enabled=False)
    _register_target(connection, BASE_URL, source_type="web")
    _register_target(connection, disabled_url, source_type="web", is_enabled=False)

    paths = IndexService(connection=connection).list_search_scope_paths(source_type="local_web")

    assert paths == [Path(disabled_folder).resolve().as_posix(), BASE_URL]


def test_update_on_search_refreshes_local_and_web_targets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    connection = _create_connection(tmp_path)
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "note.md").write_text("alpha local body", encoding="utf-8")
    _register_target(connection, folder.as_posix(), source_type="local")
    _register_target(connection, BASE_URL, source_type="web")
    _serve_web_pages(monkeypatch, {BASE_URL: _page("Docs Home", "alpha web body")})

    result = SearchService(connection=connection).search(_update_on_params("alpha"))

    assert result.total == 2
    assert {item.source_type for item in result.items} == {"local", "web"}
    assert {item.file_name for item in result.items} == {"note.md", "Docs Home"}
    rows = connection.execute("SELECT last_indexed_at FROM targets").fetchall()
    assert all(row["last_indexed_at"] is not None for row in rows)


def test_update_on_search_finds_keyword_results_in_existing_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Web の取得に失敗しても、既存インデックスのキーワード結果は返す。"""
    connection = _create_connection(tmp_path)
    _register_target(connection, BASE_URL, source_type="web")
    _insert_web_page(connection, f"{BASE_URL}page", "alpha existing body")
    _serve_web_pages(monkeypatch, {})

    result = SearchService(connection=connection).search(_update_on_params("alpha"))

    assert result.total == 1
    assert result.items[0].source_type == "web"


def test_update_on_search_crawls_web_target_with_its_own_depth_and_keywords(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """階層未指定の検索でも、Web 対象は登録時の階層で巡回し、ローカル用の除外語を当てない。"""
    connection = _create_connection(tmp_path)
    _register_target(connection, BASE_URL, source_type="web", index_depth=1)
    service = SearchService(connection=connection)
    service.index_service.update_app_settings(exclude_keywords="guide", web_exclude_keywords="private")
    fetched = _serve_web_pages(
        monkeypatch,
        {
            BASE_URL: _page("Home", "alpha", f"{BASE_URL}guide.html", f"{BASE_URL}private.html"),
            f"{BASE_URL}guide.html": _page("Guide", "alpha", f"{BASE_URL}deep.html"),
            f"{BASE_URL}private.html": _page("Private", "alpha"),
            f"{BASE_URL}deep.html": _page("Deep", "alpha"),
        },
    )

    service.search(_update_on_params("alpha"))

    assert f"{BASE_URL}guide.html" in fetched
    assert f"{BASE_URL}private.html" not in fetched
    assert f"{BASE_URL}deep.html" not in fetched
    target = connection.execute("SELECT index_depth, exclude_keywords FROM targets").fetchone()
    assert target["index_depth"] == 1
    assert "guide" not in target["exclude_keywords"]


def test_web_source_search_keeps_requested_depth(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Web UI のように階層を明示した検索は、指定された階層で巡回する。"""
    connection = _create_connection(tmp_path)
    _register_target(connection, BASE_URL, source_type="web", index_depth=1)
    fetched = _serve_web_pages(
        monkeypatch,
        {
            BASE_URL: _page("Home", "alpha", f"{BASE_URL}guide.html"),
            f"{BASE_URL}guide.html": _page("Guide", "alpha", f"{BASE_URL}deep.html"),
            f"{BASE_URL}deep.html": _page("Deep", "alpha"),
        },
    )

    SearchService(connection=connection).search(SearchQueryParams(q="alpha", source_type="web", index_depth=2))

    assert f"{BASE_URL}deep.html" in fetched


def test_update_on_search_survives_browser_start_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Edge / Chrome を起動できなくても、検索は止めずに既存インデックスの結果を返す。"""
    connection = _create_connection(tmp_path)
    _register_target(connection, BASE_URL, source_type="web")
    _insert_web_page(connection, f"{BASE_URL}page", "alpha existing body")
    service = SearchService(connection=connection)
    service.index_service.update_app_settings(web_fetch_mode="edge")

    class BrokenBrowserFetcher:
        def __init__(self, **_kwargs) -> None:
            pass

        def __enter__(self):
            raise BrowserWebFetcherError("ブラウザを起動できません。")

        def __exit__(self, *_args) -> None:
            return None

    monkeypatch.setattr("app.services.web_target_indexer.BrowserWebFetcher", BrokenBrowserFetcher)

    result = service.search(_update_on_params("alpha"))

    assert result.total == 1


def test_update_off_search_never_refreshes_local_web_targets(tmp_path: Path) -> None:
    """既定の検索（更新チェック OFF）は、ローカルも Web も走査しない。"""
    connection = _create_connection(tmp_path)
    _register_target(connection, BASE_URL, source_type="web")
    _insert_web_page(connection, f"{BASE_URL}page", "alpha existing body")
    service = SearchService(connection=connection)
    ensure_calls: list[dict[str, object]] = []
    service.index_service.ensure_fresh_target = lambda **kwargs: ensure_calls.append(kwargs)

    skip_refresh_result = service.search(
        SearchQueryParams(q="alpha", search_all_enabled=True, skip_refresh=True, source_type="local_web")
    )
    scoped_skip_refresh_result = service.search(
        SearchQueryParams(q="alpha", search_all_enabled=False, skip_refresh=True, source_type="local_web")
    )
    indexed_result = service.search_existing_index(
        IndexedSearchRequest(q="alpha", folder_path="", source_type="local_web")
    )

    assert ensure_calls == []
    assert skip_refresh_result.total == 1
    assert scoped_skip_refresh_result.total == 1
    assert indexed_result.total == 1


def test_default_web_scope_covers_crawled_siblings_but_not_disabled_targets(tmp_path: Path) -> None:
    """
    ページ URL を登録した Web 対象は親階層まで巡回するので、フォルダ未指定の検索範囲も親階層までにする。
    無効な Web 対象の配下は範囲に入れない。
    """
    connection = _create_connection(tmp_path)
    _register_target(connection, f"{BASE_URL}page", source_type="web")
    _register_target(connection, "https://example.test/disabled/", source_type="web", is_enabled=False)
    _insert_web_page(connection, f"{BASE_URL}page", "alpha target page")
    _insert_web_page(connection, f"{BASE_URL}sibling", "alpha sibling page")
    _insert_web_page(connection, "https://example.test/disabled/page", "alpha disabled page")

    result = SearchService(connection=connection).search(
        SearchQueryParams(q="alpha", search_all_enabled=False, skip_refresh=True, source_type="local_web")
    )

    assert {item.full_path for item in result.items} == {f"{BASE_URL}page", f"{BASE_URL}sibling"}


def test_default_web_scope_includes_target_url_with_query(tmp_path: Path) -> None:
    """クエリ付き URL で登録した Web 対象のページ自身も、フォルダ未指定の検索範囲に入る。"""
    connection = _create_connection(tmp_path)
    target_url = f"{BASE_URL}?page=1"
    _register_target(connection, target_url, source_type="web")
    _insert_web_page(connection, target_url, "alpha query page")

    result = SearchService(connection=connection).search(
        SearchQueryParams(q="alpha", search_all_enabled=False, skip_refresh=True, source_type="local_web")
    )

    assert [item.full_path for item in result.items] == [target_url]


@pytest.mark.parametrize("search_type", ["hybrid", "vector", "keyword"])
def test_update_on_search_refreshes_targets_for_every_search_type(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, search_type: str
) -> None:
    connection = _create_connection(tmp_path)
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "note.md").write_text("alpha local body", encoding="utf-8")
    _register_target(connection, folder.as_posix(), source_type="local")
    _register_target(connection, BASE_URL, source_type="web")
    fetched = _serve_web_pages(monkeypatch, {BASE_URL: _page("Docs Home", "alpha web body")})
    monkeypatch.setattr(vector_state, "get_searcher", lambda: None)

    dispatch_search(
        _update_on_params("alpha").model_copy(update={"search_type": search_type}),
        SearchService(connection=connection),
    )

    assert fetched == [BASE_URL]
    rows = connection.execute("SELECT last_indexed_at FROM targets").fetchall()
    assert all(row["last_indexed_at"] is not None for row in rows)


@pytest.mark.parametrize("search_type", ["hybrid", "vector", "keyword"])
def test_update_off_search_never_refreshes_for_every_search_type(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, search_type: str
) -> None:
    connection = _create_connection(tmp_path)
    _register_target(connection, BASE_URL, source_type="web")
    fetched = _serve_web_pages(monkeypatch, {BASE_URL: _page("Docs Home", "alpha web body")})
    monkeypatch.setattr(vector_state, "get_searcher", lambda: None)
    service = SearchService(connection=connection)

    dispatch_search(
        IndexedSearchRequest(q="alpha", folder_path="", source_type="local_web", search_type=search_type), service
    )
    dispatch_search(
        SearchQueryParams(
            q="alpha", search_all_enabled=True, skip_refresh=True, source_type="local_web", search_type=search_type
        ),
        service,
    )

    assert fetched == []


def test_vector_search_reports_refresh_flags(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """ベクトル検索でも、裏で更新を始めたことを応答で返す。"""
    connection = _create_connection(tmp_path)
    service = SearchService(connection=connection)
    monkeypatch.setattr(vector_state, "get_searcher", lambda: None)
    monkeypatch.setattr(
        service.refresher,
        "refresh_target",
        lambda **_: {"used_existing_index": True, "background_refresh_scheduled": True},
    )

    response = dispatch_search(
        SearchQueryParams(q="alpha", full_path=tmp_path.as_posix(), search_type="vector"), service
    )

    assert response.used_existing_index is True
    assert response.background_refresh_scheduled is True


def test_local_web_path_match_uses_path_below_registered_folder(tmp_path: Path) -> None:
    """ファイル名検索のパス一致は、local と同じく登録フォルダより下の相対パスだけを見る。"""
    connection = _create_connection(tmp_path)
    folder = tmp_path / "outerword" / "vault"
    subfolder = folder / "innerword"
    subfolder.mkdir(parents=True)
    (subfolder / "note.md").write_text("alpha body", encoding="utf-8")
    _register_target(connection, folder.as_posix(), source_type="local")
    _register_target(connection, BASE_URL, source_type="web")
    service = SearchService(connection=connection)
    service.index_service.ensure_fresh_target(full_path=folder.as_posix(), refresh_window_minutes=0)

    def search_total(query: str) -> int:
        return service.search(
            SearchQueryParams(q=query, search_all_enabled=False, skip_refresh=True, source_type="local_web")
        ).total

    assert search_total("innerword alpha") == 1
    assert search_total("outerword alpha") == 0
