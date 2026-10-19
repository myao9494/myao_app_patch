"""
検索ディスパッチャ（keyword / vector / hybrid の実行と結果整形）の単体テスト。

仕様:
- ベクトル検索由来の結果の file_id は、ベクトルDBの documents.id ではなく files テーブルの ID へ解決する。
- files テーブルに存在しないベクトル文書は、どの files.id とも衝突しない負の合成 ID を持つ。
- hybrid のページングは、先頭 1 ページ分の融合結果に残りのキーワード結果を続けた全体順位から切り出し、
  ページ間で結果が重複・欠落しない。
- hybrid の total は、キーワード検索とベクトル検索のどちらかに一致したファイルの数（重複なし）を返す。
  どのページを取得しても同じ値になる。
"""

from pathlib import Path
import sqlite3

from fastapi import HTTPException
import pytest

from app.api.files import delete_file
from app.db.schema import initialize_schema
from app.models.search import IndexedSearchRequest, SearchQueryParams
from app.services.search_dispatcher import (
    VECTOR_ONLY_FILE_ID_BASE,
    dispatch_search,
    resolve_vector_only_file_id,
)
from app.services.search_service import SearchService
from app.vector.searcher import SearchMode
from app.vector.searcher import SearchResponse as VectorSearchResponse
from app.vector.searcher import SearchResultItem as VectorItem
from app.vector.state import vector_state


class FakeVectorSearcher:
    """あらかじめ決めた結果を返すベクトル検索器。"""

    def __init__(self, items: list[VectorItem]) -> None:
        self.items = items
        self.queries: list[str] = []

    def search(self, query: str, top_k: int = 20) -> VectorSearchResponse:
        self.queries.append(query)
        return VectorSearchResponse(
            query=query,
            mode=SearchMode.CHUNK,
            results=list(self.items),
            total_candidates=len(self.items),
            query_embedding_time_ms=0.0,
            search_time_ms=0.0,
            total_time_ms=0.0,
        )


def _vector_item(path: Path, *, document_id: int, score: float = 0.9) -> VectorItem:
    return VectorItem(
        document_id=document_id,
        path=str(path),
        title=path.stem,
        score=score,
        full_path=str(path),
        hit_text=f"vector hit for {path.name}",
        salient_sentence=f"salient {path.name}",
    )


@pytest.fixture
def indexed_env(tmp_path: Path):
    """一時フォルダを全文インデックス済みにした SearchService を返す。"""
    connection = sqlite3.connect(tmp_path / "search.db")
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON;")
    initialize_schema(connection)
    service = SearchService(connection=connection)
    target = (tmp_path / "work").resolve()
    target.mkdir()

    def index() -> None:
        service.index_service.ensure_fresh_target(
            full_path=target.as_posix(), refresh_window_minutes=0, index_depth=5
        )

    def file_id_of(path: Path) -> int:
        row = connection.execute("SELECT id FROM files WHERE normalized_path = ?", (path.as_posix(),)).fetchone()
        assert row is not None, f"{path} is not indexed"
        return int(row["id"])

    try:
        yield {"service": service, "connection": connection, "target": target, "index": index, "file_id_of": file_id_of}
    finally:
        connection.close()


def _use_searcher(monkeypatch: pytest.MonkeyPatch, items: list[VectorItem]) -> FakeVectorSearcher:
    searcher = FakeVectorSearcher(items)
    monkeypatch.setattr(vector_state, "get_searcher", lambda: searcher)
    return searcher


def _params(target: Path, **overrides: object) -> SearchQueryParams:
    values: dict[str, object] = {"q": "apple", "full_path": target.as_posix(), "search_all_enabled": True}
    values.update(overrides)
    return SearchQueryParams(**values)


def test_hybrid_vector_only_result_uses_files_table_id(indexed_env, monkeypatch: pytest.MonkeyPatch) -> None:
    """ベクトルDBの documents.id が別ファイルの files.id と同じ値でも、結果の file_id は自分自身の files.id になる。"""
    target: Path = indexed_env["target"]
    alpha = target / "alpha.md"
    beta = target / "beta.md"
    alpha.write_text("apple pie", encoding="utf-8")
    beta.write_text("banana bread", encoding="utf-8")
    indexed_env["index"]()
    alpha_id = indexed_env["file_id_of"](alpha)
    beta_id = indexed_env["file_id_of"](beta)
    indexed_env["connection"].execute("UPDATE files SET click_count = 4 WHERE id = ?", (beta_id,))
    indexed_env["connection"].commit()
    # ベクトルDB側の ID を、あえて alpha の files.id と衝突させる
    _use_searcher(monkeypatch, [_vector_item(beta, document_id=alpha_id)])

    response = dispatch_search(_params(target), indexed_env["service"])

    items_by_name = {item.file_name: item for item in response.items}
    assert items_by_name["alpha.md"].file_id == alpha_id
    assert items_by_name["alpha.md"].match_type == "keyword_only"
    assert items_by_name["beta.md"].file_id == beta_id
    assert items_by_name["beta.md"].match_type == "vector_only"
    assert items_by_name["beta.md"].click_count == 4
    assert len({item.file_id for item in response.items}) == len(response.items)

    # クリック記録は表示したファイル自身に加算される
    assert indexed_env["service"].record_click(items_by_name["beta.md"].file_id, "apple") == 5
    alpha_clicks = indexed_env["connection"].execute("SELECT click_count FROM files WHERE id = ?", (alpha_id,)).fetchone()
    assert int(alpha_clicks["click_count"]) == 0


def test_vector_search_result_uses_files_table_id(indexed_env, monkeypatch: pytest.MonkeyPatch) -> None:
    """ベクトル検索単体でも file_id は files テーブルの ID へ解決される。"""
    target: Path = indexed_env["target"]
    alpha = target / "alpha.md"
    beta = target / "beta.md"
    alpha.write_text("apple pie", encoding="utf-8")
    beta.write_text("banana bread", encoding="utf-8")
    indexed_env["index"]()
    _use_searcher(monkeypatch, [_vector_item(beta, document_id=indexed_env["file_id_of"](alpha))])

    response = dispatch_search(_params(target, search_type="vector"), indexed_env["service"])

    assert [item.file_name for item in response.items] == ["beta.md"]
    assert response.items[0].file_id == indexed_env["file_id_of"](beta)
    assert response.search_type == "vector"


def test_vector_result_missing_from_files_table_never_collides_with_file_ids(
    indexed_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """全文インデックスに無いベクトル文書は負の合成 ID を持ち、クリック記録や削除が別ファイルへ作用しない。"""
    target: Path = indexed_env["target"]
    alpha = target / "alpha.md"
    alpha.write_text("apple pie", encoding="utf-8")
    indexed_env["index"]()
    alpha_id = indexed_env["file_id_of"](alpha)
    unindexed = target / "unindexed.md"
    unindexed.write_text("only in the vector index", encoding="utf-8")
    _use_searcher(monkeypatch, [_vector_item(unindexed, document_id=alpha_id)])

    response = dispatch_search(_params(target), indexed_env["service"])

    unindexed_item = next(item for item in response.items if item.file_name == "unindexed.md")
    assert unindexed_item.file_id == resolve_vector_only_file_id(alpha_id) == -(VECTOR_ONLY_FILE_ID_BASE + alpha_id)
    assert unindexed_item.file_id < 0

    with pytest.raises(HTTPException) as click_error:
        indexed_env["service"].record_click(unindexed_item.file_id, "apple")
    assert click_error.value.status_code == 404

    with pytest.raises(HTTPException) as delete_error:
        delete_file(
            file_id=unindexed_item.file_id,
            expected_path=unindexed_item.full_path,
            connection=indexed_env["connection"],
        )
    assert delete_error.value.status_code == 404
    assert alpha.exists()
    assert unindexed.exists()


def test_delete_file_refuses_when_expected_path_points_to_another_file(indexed_env) -> None:
    """file_id と表示中のパスが食い違う削除要求は、何も削除せず 409 を返す。"""
    target: Path = indexed_env["target"]
    alpha = target / "alpha.md"
    beta = target / "beta.md"
    alpha.write_text("apple pie", encoding="utf-8")
    beta.write_text("banana bread", encoding="utf-8")
    indexed_env["index"]()
    alpha_id = indexed_env["file_id_of"](alpha)

    with pytest.raises(HTTPException) as error:
        delete_file(file_id=alpha_id, expected_path=beta.as_posix(), connection=indexed_env["connection"])

    assert error.value.status_code == 409
    assert alpha.exists()
    assert beta.exists()
    assert indexed_env["file_id_of"](alpha) == alpha_id


def test_delete_file_deletes_when_expected_path_matches(indexed_env) -> None:
    """file_id と表示中のパスが一致すれば、物理ファイルとインデックスを削除する。"""
    target: Path = indexed_env["target"]
    alpha = target / "alpha.md"
    alpha.write_text("apple pie", encoding="utf-8")
    indexed_env["index"]()
    alpha_id = indexed_env["file_id_of"](alpha)

    result = delete_file(file_id=alpha_id, expected_path=str(alpha), connection=indexed_env["connection"])

    assert result == {"status": "success", "file_id": alpha_id}
    assert not alpha.exists()
    remaining = indexed_env["connection"].execute("SELECT COUNT(*) AS count FROM files").fetchone()
    assert int(remaining["count"]) == 0


def test_hybrid_pagination_returns_each_result_exactly_once(indexed_env, monkeypatch: pytest.MonkeyPatch) -> None:
    """追加読み込みを繰り返しても、ベクトル結果が重複せず、全結果を 1 回ずつ取得できる。"""
    target: Path = indexed_env["target"]
    keyword_files = [target / f"keyword_{index}.md" for index in range(7)]
    for path in keyword_files:
        path.write_text(f"apple note {path.stem}", encoding="utf-8")
    vector_only_files = [target / "semantic_a.md", target / "semantic_b.md"]
    for path in vector_only_files:
        path.write_text("fruit related text", encoding="utf-8")
    indexed_env["index"]()
    _use_searcher(
        monkeypatch,
        [
            _vector_item(vector_only_files[0], document_id=1, score=0.9),
            _vector_item(keyword_files[3], document_id=2, score=0.8),
            _vector_item(vector_only_files[1], document_id=3, score=0.7),
        ],
    )
    service = indexed_env["service"]

    everything = dispatch_search(_params(target, limit=100), service)
    paged_paths: list[str] = []
    offset: int | None = 0
    page_count = 0
    while offset is not None:
        page = dispatch_search(_params(target, limit=3, offset=offset), service)
        paged_paths.extend(item.full_path for item in page.items)
        offset = page.next_offset if page.has_more else None
        page_count += 1
        assert page_count < 10, "ページングが終了しません"

    expected_paths = {path.as_posix() for path in [*keyword_files, *vector_only_files]}
    assert len(paged_paths) == len(set(paged_paths))
    assert set(paged_paths) == expected_paths
    assert everything.has_more is False
    assert everything.total == len(expected_paths)
    both_item = next(item for item in everything.items if item.file_name == "keyword_3.md")
    assert both_item.match_type == "both"
    assert both_item.file_id == indexed_env["file_id_of"](keyword_files[3])


def test_hybrid_total_counts_each_file_once_on_every_page(indexed_env, monkeypatch: pytest.MonkeyPatch) -> None:
    """
    先頭ページの外にあるキーワード結果がベクトル検索にも一致していても、件数を二重に数えない。
    既存DBだけを使う検索（ランチャー）でも同じ。
    """
    target: Path = indexed_env["target"]
    keyword_files = [target / f"keyword_{index}.md" for index in range(7)]
    for path in keyword_files:
        path.write_text(f"apple note {path.stem}", encoding="utf-8")
    vector_only_file = target / "semantic.md"
    vector_only_file.write_text("fruit related text", encoding="utf-8")
    indexed_env["index"]()
    # キーワードにも一致する 7 件すべてをベクトル結果にも含める（先頭ページに入らないものが必ず出る）
    _use_searcher(
        monkeypatch,
        [
            _vector_item(vector_only_file, document_id=1, score=0.95),
            *[_vector_item(path, document_id=index + 2, score=0.9 - index * 0.01) for index, path in enumerate(keyword_files)],
        ],
    )
    service = indexed_env["service"]

    totals = [dispatch_search(_params(target, limit=2, offset=offset), service).total for offset in (0, 2, 4, 6)]
    indexed_total = dispatch_search(
        IndexedSearchRequest(q="apple", folder_path=target.as_posix(), limit=2, search_type="hybrid"), service
    ).total

    assert totals == [8, 8, 8, 8]
    assert indexed_total == 8


def test_hybrid_without_vector_results_keeps_keyword_paging(indexed_env, monkeypatch: pytest.MonkeyPatch) -> None:
    """ベクトル結果が無いときは、キーワード検索のページングと件数をそのまま返す。"""
    target: Path = indexed_env["target"]
    for index in range(5):
        (target / f"keyword_{index}.md").write_text("apple", encoding="utf-8")
    indexed_env["index"]()
    _use_searcher(monkeypatch, [])
    service = indexed_env["service"]

    first = dispatch_search(_params(target, limit=2), service)
    second = dispatch_search(_params(target, limit=2, offset=first.next_offset), service)
    keyword_second = dispatch_search(_params(target, limit=2, offset=2, search_type="keyword"), service)

    assert first.search_type == "hybrid"
    assert first.total == 5
    assert first.has_more is True
    assert first.next_offset == 2
    assert {item.match_type for item in first.items} == {"keyword_only"}
    assert [item.full_path for item in second.items] == [item.full_path for item in keyword_second.items]
    assert second.next_offset == 4


def test_hybrid_search_on_existing_index_uses_folder_path_scope(indexed_env, monkeypatch: pytest.MonkeyPatch) -> None:
    """既存インデックス専用検索でも、対象フォルダ外のベクトル結果は除外し、対象内は files の ID で返す。"""
    target: Path = indexed_env["target"]
    inside = target / "inside.md"
    inside.write_text("banana bread", encoding="utf-8")
    (target / "alpha.md").write_text("apple pie", encoding="utf-8")
    indexed_env["index"]()
    outside = target.parent / "outside.md"
    outside.write_text("apple outside the target", encoding="utf-8")
    searcher = _use_searcher(
        monkeypatch,
        [_vector_item(outside, document_id=50), _vector_item(inside, document_id=51)],
    )

    response = dispatch_search(
        IndexedSearchRequest(q="apple -cherry", folder_path=target.as_posix()),
        indexed_env["service"],
    )

    assert {item.file_name for item in response.items} == {"alpha.md", "inside.md"}
    inside_item = next(item for item in response.items if item.file_name == "inside.md")
    assert inside_item.file_id == indexed_env["file_id_of"](inside)
    # ベクトル検索へは除外語を除いたポジティブ語だけを渡す
    assert searcher.queries == ["apple"]


def test_results_expose_match_source_for_client_badges(indexed_env, monkeypatch: pytest.MonkeyPatch) -> None:
    """
    一致理由バッジ用の match_source（both / vector / keyword）を、検索方式ごとに API の JSON へ含める。
    Web UI と全ランチャーはこの値を読んでバッジを表示する。
    """
    target: Path = indexed_env["target"]
    alpha = target / "alpha.md"
    beta = target / "beta.md"
    gamma = target / "gamma.md"
    alpha.write_text("apple pie", encoding="utf-8")
    beta.write_text("banana bread", encoding="utf-8")
    gamma.write_text("apple tart", encoding="utf-8")
    indexed_env["index"]()
    _use_searcher(monkeypatch, [_vector_item(alpha, document_id=1), _vector_item(beta, document_id=2)])
    service = indexed_env["service"]

    hybrid = dispatch_search(_params(target), service).model_dump(mode="json")
    keyword = dispatch_search(_params(target, search_type="keyword"), service).model_dump(mode="json")
    vector = dispatch_search(_params(target, search_type="vector"), service).model_dump(mode="json")

    hybrid_sources = {item["file_name"]: (item["match_type"], item["match_source"]) for item in hybrid["items"]}
    assert hybrid_sources == {
        "alpha.md": ("both", "both"),
        "beta.md": ("vector_only", "vector"),
        "gamma.md": ("keyword_only", "keyword"),
    }
    assert {item["match_source"] for item in keyword["items"]} == {"keyword"}
    assert {item["match_source"] for item in vector["items"]} == {"vector"}


def test_match_source_is_absent_when_match_type_is_not_set() -> None:
    """一致理由を持たない結果（フォルダ結果など）は match_source も null のままにする。"""
    from datetime import UTC, datetime

    from app.models.search import SearchResultItem

    item = SearchResultItem(
        file_id=1, target_path="/docs", file_name="a.md", full_path="/docs/a.md", file_ext=".md",
        created_at=datetime(2026, 1, 1, tzinfo=UTC), mtime=datetime(2026, 1, 1, tzinfo=UTC), click_count=0, snippet="",
    )

    assert item.match_source is None
    assert item.model_dump()["match_source"] is None


def test_hybrid_search_logs_time_spent_in_each_stage(
    indexed_env, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """遅い検索の原因を現地で切り分けられるよう、キーワード・ベクトル・全体の所要時間をログへ出す。"""
    target: Path = indexed_env["target"]
    alpha = target / "alpha.md"
    alpha.write_text("apple pie", encoding="utf-8")
    indexed_env["index"]()
    _use_searcher(monkeypatch, [_vector_item(alpha, document_id=1)])

    with caplog.at_level("INFO", logger="app.services.search_dispatcher"):
        dispatch_search(
            IndexedSearchRequest(q="apple", folder_path=target.as_posix(), search_type="hybrid"),
            indexed_env["service"],
        )

    timing_logs = [record.getMessage() for record in caplog.records if "Search timing" in record.getMessage()]
    assert len(timing_logs) == 1
    assert "type=hybrid" in timing_logs[0]
    for stage in ("keyword=", "vector=", "total="):
        assert stage in timing_logs[0]
