"""
ベクトル検索およびハイブリッド検索における拡張子フィルタの単体テスト。
指定された拡張子（extensions）に合致しないドキュメントが除外されることを検証する。
"""

from pathlib import Path
import pytest
from app.api.search import _dispatch_search
from app.models.search import SearchQueryParams
from app.vector.searcher import SearchMode, SearchResponse as VectorSearchResponse, SearchResultItem


class DummySearcher:
    def __init__(self, items: list[SearchResultItem]):
        self.items = items

    def search(self, query: str, top_k: int = 20) -> VectorSearchResponse:
        return VectorSearchResponse(
            query=query,
            mode=SearchMode.CHUNK,
            results=self.items,
            total_candidates=len(self.items),
            query_embedding_time_ms=1.0,
            search_time_ms=1.0,
            total_time_ms=2.0,
            rag_context_xml="",
            rag_context_markdown="",
        )


class DummySearchService:
    def __init__(self):
        self.index_service = None

    def search(self, params):
        class DummyResp:
            total = 0
            items = []
            has_more = False
            search_type = "keyword"
        return DummyResp()


def test_vector_search_applies_extension_filter(monkeypatch) -> None:
    """ベクトル検索時に extensions フィルタが指定された場合、対象外拡張子が除外されることを検証する"""
    from app.vector.state import vector_state

    dummy_items = [
        SearchResultItem(
            document_id=1,
            path="/vault/doc.md",
            title="Markdown文書",
            score=0.9,
            full_path="/vault/doc.md",
            hit_text="本文",
        ),
        SearchResultItem(
            document_id=2,
            path="/vault/script.py",
            title="Pythonスクリプト",
            score=0.85,
            full_path="/vault/script.py",
            hit_text="コード",
        ),
        SearchResultItem(
            document_id=3,
            path="/vault/data.json",
            title="JSONデータ",
            score=0.8,
            full_path="/vault/data.json",
            hit_text="データ",
        ),
    ]
    dummy_searcher = DummySearcher(dummy_items)
    monkeypatch.setattr(vector_state, "get_searcher", lambda: dummy_searcher)

    # 1. 拡張子フィルタなし
    params_all = SearchQueryParams(
        q="テスト",
        search_type="vector",
        full_path="/vault",
    )
    res_all = _dispatch_search(params_all, DummySearchService())
    assert len(res_all.items) == 3

    # 2. extensions=".md .py" を指定
    params_filtered = SearchQueryParams(
        q="テスト",
        search_type="vector",
        full_path="/vault",
        extensions=".md .py",
    )
    res_filtered = _dispatch_search(params_filtered, DummySearchService())
    assert len(res_filtered.items) == 2
    paths = {it.full_path for it in res_filtered.items}
    assert paths == {"/vault/doc.md", "/vault/script.py"}
