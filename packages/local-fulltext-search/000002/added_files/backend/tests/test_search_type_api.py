"""
検索APIの search_type（hybrid, vector, keyword）の単体テスト。
"""

from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.vector.state import vector_state


@pytest.fixture
def client() -> TestClient:
    # テスト用にモックモデルをロードしておく
    vector_state.load_model(use_mock=True, mock_dim=64)
    return TestClient(app)


def test_search_type_default_is_hybrid(client: TestClient) -> None:
    """search_type未指定時はデフォルトでhybridとして処理されること"""
    res = client.get("/api/search", params={"q": "テスト", "search_all_enabled": True})
    assert res.status_code == 200
    data = res.json()
    assert "items" in data
    assert data.get("search_type") == "hybrid"


def test_search_type_keyword(client: TestClient) -> None:
    """search_type=keyword でキーワード検索のみが実行されること"""
    res = client.get("/api/search", params={"q": "テスト", "search_all_enabled": True, "search_type": "keyword"})
    assert res.status_code == 200
    data = res.json()
    assert data.get("search_type") == "keyword"


def test_search_type_vector(client: TestClient) -> None:
    """search_type=vector でベクトル検索が実行されること"""
    res = client.get("/api/search", params={"q": "テスト", "search_all_enabled": True, "search_type": "vector"})
    assert res.status_code == 200
    data = res.json()
    assert data.get("search_type") == "vector"


def test_hybrid_and_vector_search_respects_exclude_keywords(client: TestClient, monkeypatch) -> None:
    """除外キーワードに一致するファイルは、ハイブリッド検索およびベクトル検索の結果から除外されること"""
    from unittest.mock import MagicMock
    from app.vector.searcher import SearchResultItem as VectorSearchResultItem, SearchResponse as VectorSearchResponse, SearchMode

    searcher = vector_state.get_searcher()
    assert searcher is not None

    mock_v_results = [
        VectorSearchResultItem(
            chunk_id=1,
            document_id=1,
            path="/work/data/gantt_diff_summary.json",
            full_path="/work/data/gantt_diff_summary.json",
            title="gantt_diff_summary.json",
            chunk_index=0,
            score=0.9,
            hit_text="差分サマリーデータ",
            salient_sentence="差分サマリーデータ",
        ),
        VectorSearchResultItem(
            chunk_id=2,
            document_id=2,
            path="/work/data/2026_gantt_diff_summary_v1.md",
            full_path="/work/data/2026_gantt_diff_summary_v1.md",
            title="2026_gantt_diff_summary_v1.md",
            chunk_index=0,
            score=0.88,
            hit_text="2026年差分サマリー",
            salient_sentence="2026年差分サマリー",
        ),
        VectorSearchResultItem(
            chunk_id=3,
            document_id=3,
            path="/work/notes/normal_project.md",
            full_path="/work/notes/normal_project.md",
            title="normal_project.md",
            chunk_index=0,
            score=0.85,
            hit_text="通常プロジェクトメモ",
            salient_sentence="通常プロジェクトメモ",
        ),
    ]
    mock_res = VectorSearchResponse(
        query="テスト",
        mode=SearchMode.CHUNK,
        results=mock_v_results,
        total_candidates=3,
        query_embedding_time_ms=1.0,
        search_time_ms=1.0,
        total_time_ms=2.0,
    )
    monkeypatch.setattr(searcher, "search", MagicMock(return_value=mock_res))

    # 1. vector 検索で exclude_keywords="gantt_diff_summary" を渡したとき
    res = client.get(
        "/api/search",
        params={
            "q": "テスト",
            "search_all_enabled": True,
            "search_type": "vector",
            "exclude_keywords": "gantt_diff_summary",
        },
    )
    assert res.status_code == 200
    items = res.json()["items"]
    paths = [it["full_path"] for it in items]
    assert "/work/notes/normal_project.md" in paths
    assert "/work/data/gantt_diff_summary.json" not in paths
    assert "/work/data/2026_gantt_diff_summary_v1.md" not in paths

    # 2. hybrid 検索で exclude_keywords="gantt_diff_summary" を渡したとき
    res_hybrid = client.get(
        "/api/search",
        params={
            "q": "テスト",
            "search_all_enabled": True,
            "search_type": "hybrid",
            "exclude_keywords": "gantt_diff_summary",
        },
    )
    assert res_hybrid.status_code == 200
    items_hybrid = res_hybrid.json()["items"]
    paths_hybrid = [it["full_path"] for it in items_hybrid]
    assert "/work/notes/normal_project.md" in paths_hybrid
    assert "/work/data/gantt_diff_summary.json" not in paths_hybrid
    assert "/work/data/2026_gantt_diff_summary_v1.md" not in paths
