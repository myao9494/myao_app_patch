"""
除外キーワードの保存が、許可なくインデックスを消さないことのテスト。

検索ルール画面の除外キーワードは入力すると自動で保存される。保存のたびに既存インデックスを消すと、
入力の途中の語や誤入力で、再作成に何時間もかかるベクトルインデックスまで失う。

仕様:
- 除外キーワードの保存だけでは、全文インデックスもベクトルインデックスも削除しない。
- 除外したファイルは、検索のときの絞り込みで結果から外す（全文検索・フォルダ指定の検索・ベクトル検索）。
- キーワードを戻せば、再走査を待たずに検索へ戻る。
- 既存インデックスを消すのは clean_excluded_files=True のときだけ。
- 除外の判定は検索対象フォルダより下の階層だけで行う。対象フォルダの親の名前には一致させない
  （親が `old_work` のとき、除外語 `old` で全件が消えたり隠れたりしないようにする）。
"""

import sqlite3
from pathlib import Path

import pytest

from app.config import settings
from app.db.schema import initialize_schema
from app.models.search import IndexedSearchRequest, SearchQueryParams
from app.services.index_service import IndexService
from app.services.search_dispatcher import dispatch_search
from app.services.search_service import SearchService
from app.vector.db import get_all_documents_metadata, get_model_db_path
from app.vector.state import VectorState, vector_state


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """親に `old_work` を持つフォルダを全文インデックス済みにした環境を返す。"""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setattr(settings, "data_dir", data_dir)
    connection = sqlite3.connect(tmp_path / "search.db")
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    service = SearchService(connection=connection)
    target = (tmp_path / "old_work" / "notes").resolve()
    target.mkdir(parents=True)
    (target / "keep.md").write_text("zebra keep", encoding="utf-8")
    (target / "secret.md").write_text("zebra secret", encoding="utf-8")
    index_service = service.index_service
    index_service.add_search_target(folder_path=target.as_posix(), index_depth=5)
    index_service.update_app_settings(exclude_keywords="")
    index_service.ensure_fresh_target(full_path=target.as_posix(), refresh_window_minutes=0, index_depth=5, exclude_keywords="")
    try:
        yield {"service": service, "index": index_service, "connection": connection, "target": target, "data_dir": data_dir}
    finally:
        connection.close()


def _names(env: dict, **overrides: object) -> list[str]:
    values: dict[str, object] = {"q": "zebra", "search_all_enabled": True, "search_target": "all", "search_type": "keyword"}
    values.update(overrides)
    response = dispatch_search(SearchQueryParams(**values), env["service"])
    return sorted(item.file_name for item in response.items if item.result_kind == "file")


def _indexed_names(env: dict) -> list[str]:
    rows = env["connection"].execute("SELECT file_name FROM files ORDER BY file_name").fetchall()
    return [str(row["file_name"]) for row in rows]


def test_saving_a_keyword_hides_results_but_keeps_the_index(env: dict) -> None:
    env["index"].update_app_settings(exclude_keywords="secret")

    assert _indexed_names(env) == ["keep.md", "secret.md"]
    assert _names(env) == ["keep.md"]


def test_removing_the_keyword_brings_results_back_without_a_rescan(env: dict) -> None:
    env["index"].update_app_settings(exclude_keywords="secret")
    env["index"].update_app_settings(exclude_keywords="")

    assert _names(env) == ["keep.md", "secret.md"]


@pytest.mark.parametrize("search_target", ["all", "body", "filename"])
def test_folder_scoped_search_also_hides_excluded_files(env: dict, search_target: str) -> None:
    env["index"].update_app_settings(exclude_keywords="secret")

    names = _names(env, search_all_enabled=False, skip_refresh=True, full_path=env["target"].as_posix(), search_target=search_target)

    assert "secret.md" not in names


def test_ignored_full_path_is_hidden_in_folder_scoped_search(env: dict) -> None:
    """検索結果の「無視」はフルパスを除外キーワードへ追加する。"""
    env["index"].update_app_settings(exclude_keywords=(env["target"] / "secret.md").as_posix())

    names = _names(env, search_all_enabled=False, skip_refresh=True, full_path=env["target"].as_posix())

    assert names == ["keep.md"]


def test_launcher_search_hides_excluded_files(env: dict) -> None:
    env["index"].update_app_settings(exclude_keywords="secret")

    response = dispatch_search(IndexedSearchRequest(q="zebra", folder_path="", search_type="keyword"), env["service"])

    assert [item.file_name for item in response.items] == ["keep.md"]


def test_regex_search_hides_excluded_files(env: dict) -> None:
    env["index"].update_app_settings(exclude_keywords="secret")

    assert _names(env, q="zeb.a", regex_enabled=True) == ["keep.md"]


def test_explicit_cleanup_removes_only_matching_rows(env: dict) -> None:
    env["index"].update_app_settings(exclude_keywords="secret", clean_excluded_files=True)

    assert _indexed_names(env) == ["keep.md"]


def test_keyword_matching_a_parent_folder_does_not_hide_anything(env: dict) -> None:
    """検索対象の親の名前（old_work の old）は除外の判定に使わない。"""
    env["index"].update_app_settings(exclude_keywords="old")

    assert _names(env) == ["keep.md", "secret.md"]
    response = dispatch_search(IndexedSearchRequest(q="zebra", folder_path="", search_type="keyword"), env["service"])
    assert len(response.items) == 2


def test_cleanup_with_a_keyword_matching_a_parent_folder_deletes_nothing(env: dict) -> None:
    env["index"].update_app_settings(exclude_keywords="old", clean_excluded_files=True)

    assert _indexed_names(env) == ["keep.md", "secret.md"]


def test_vector_search_hides_excluded_files_and_keeps_vectors(env: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    state = VectorState(data_dir=env["data_dir"])
    state.load_model(use_mock=True, mock_dim=32)
    state.sync_index(target_folders=[env["target"].as_posix()], exclude_keywords="", force=True)
    db_path = get_model_db_path("mock_model", data_dir=env["data_dir"])
    assert len(get_all_documents_metadata(db_path)) == 2
    monkeypatch.setattr(vector_state, "get_searcher", state.get_searcher)

    env["index"].update_app_settings(exclude_keywords="secret")

    assert len(get_all_documents_metadata(db_path)) == 2
    response = dispatch_search(
        SearchQueryParams(q="zebra", search_all_enabled=True, search_type="vector", skip_refresh=True), env["service"]
    )
    assert [item.file_name for item in response.items] == ["keep.md"]

    env["index"].update_app_settings(exclude_keywords="old")
    response = dispatch_search(
        SearchQueryParams(q="zebra", search_all_enabled=True, search_type="vector", skip_refresh=True), env["service"]
    )
    assert sorted(item.file_name for item in response.items) == ["keep.md", "secret.md"]
