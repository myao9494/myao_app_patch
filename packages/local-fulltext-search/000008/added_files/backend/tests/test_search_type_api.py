"""
検索APIの search_type（hybrid, vector, keyword）の単体テスト。

仕様:
- search_type に応じた検索結果（ハイブリッド、ベクトル単体、キーワード単体）のレスポンス検証。
- client fixture では vector_state の data_dir を一時ディレクトリに隔離し、本番環境の config.json 汚染を防止。
"""

from pathlib import Path
import sqlite3
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.api.deps import get_db_connection
from app.db.schema import initialize_schema
from app.vector.state import vector_state


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    # テスト用にモックモデルをロードしておく（本番環境のconfig.jsonや状態を汚染しないよう隔離）
    orig_embedder = vector_state.embedder
    orig_searcher = vector_state.searcher
    orig_model_path = vector_state.model_path
    orig_data_dir = vector_state.data_dir
    orig_config_path = vector_state.config_path

    test_data_dir = tmp_path / "vector_data"
    test_data_dir.mkdir(parents=True, exist_ok=True)
    vector_state.data_dir = test_data_dir
    vector_state.config_path = test_data_dir / "config.json"
    vector_state.load_model(use_mock=True, mock_dim=64)

    # テスト用一時DBの作成とスキーマ初期化
    test_db_path = tmp_path / "test_type_search.db"
    test_conn = sqlite3.connect(test_db_path, check_same_thread=False)
    test_conn.row_factory = sqlite3.Row
    test_conn.execute("PRAGMA foreign_keys = ON;")
    initialize_schema(test_conn)

    work_dir = tmp_path / "work"
    work_dir.mkdir(parents=True, exist_ok=True)
    test_conn.execute(
        """
        INSERT INTO targets (
            full_path, is_search_target_enabled, source_type, indexed_file_count,
            created_at, updated_at
        ) VALUES (?, 1, 'local', 1, datetime('now'), datetime('now'))
        """,
        (work_dir.as_posix(),),
    )
    test_conn.commit()

    def _override_db():
        conn = sqlite3.connect(test_db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    app.dependency_overrides[get_db_connection] = _override_db

    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db_connection, None)
        test_conn.close()
        vector_state.embedder = orig_embedder
        vector_state.searcher = orig_searcher
        vector_state.model_path = orig_model_path
        vector_state.data_dir = orig_data_dir
        vector_state.config_path = orig_config_path


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


def test_hybrid_and_vector_search_respects_exclude_keywords(client: TestClient, monkeypatch, tmp_path: Path) -> None:
    """除外キーワードに一致するファイルは、ハイブリッド検索およびベクトル検索の結果から除外されること"""
    from unittest.mock import MagicMock
    from app.vector.searcher import SearchResultItem as VectorSearchResultItem, SearchResponse as VectorSearchResponse, SearchMode

    searcher = vector_state.get_searcher()
    assert searcher is not None

    p1 = tmp_path / "work" / "data" / "gantt_diff_summary.json"
    p2 = tmp_path / "work" / "data" / "2026_gantt_diff_summary_v1.md"
    p3 = tmp_path / "work" / "notes" / "normal_project.md"
    for p in (p1, p2, p3):
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("test", encoding="utf-8")

    mock_v_results = [
        VectorSearchResultItem(
            chunk_id=1,
            document_id=1,
            path=p1.as_posix(),
            full_path=p1.as_posix(),
            title="gantt_diff_summary.json",
            chunk_index=0,
            score=0.9,
            hit_text="差分サマリーデータ",
            salient_sentence="差分サマリーデータ",
        ),
        VectorSearchResultItem(
            chunk_id=2,
            document_id=2,
            path=p2.as_posix(),
            full_path=p2.as_posix(),
            title="2026_gantt_diff_summary_v1.md",
            chunk_index=0,
            score=0.88,
            hit_text="2026年差分サマリー",
            salient_sentence="2026年差分サマリー",
        ),
        VectorSearchResultItem(
            chunk_id=3,
            document_id=3,
            path=p3.as_posix(),
            full_path=p3.as_posix(),
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
    assert p3.as_posix() in paths
    assert p1.as_posix() not in paths
    assert p2.as_posix() not in paths

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
    assert p3.as_posix() in paths_hybrid
    assert p1.as_posix() not in paths_hybrid
    assert p2.as_posix() not in paths_hybrid


def test_hybrid_and_vector_search_respects_negative_query_and_extension(client: TestClient, monkeypatch, tmp_path: Path) -> None:
    """
    クエリ内の除外語（-.md 等）や拡張子フィルタの除外（types='-json'）が、
    ベクトル検索およびハイブリッド検索の結果から確実に除外されること。
    """
    from unittest.mock import MagicMock
    from app.vector.searcher import SearchResultItem as VectorSearchResultItem, SearchResponse as VectorSearchResponse, SearchMode

    searcher = vector_state.get_searcher()
    assert searcher is not None

    p1 = tmp_path / "work" / "data" / "report.json"
    p2 = tmp_path / "work" / "data" / "document.md"
    p3 = tmp_path / "work" / "data" / "image.png"
    for p in (p1, p2, p3):
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("test", encoding="utf-8")

    mock_v_results = [
        VectorSearchResultItem(
            chunk_id=1,
            document_id=1,
            path=p1.as_posix(),
            full_path=p1.as_posix(),
            title="report.json",
            chunk_index=0,
            score=0.9,
            hit_text="レポートデータ",
            salient_sentence="レポートデータ",
        ),
        VectorSearchResultItem(
            chunk_id=2,
            document_id=2,
            path=p2.as_posix(),
            full_path=p2.as_posix(),
            title="document.md",
            chunk_index=0,
            score=0.88,
            hit_text="ドキュメント",
            salient_sentence="ドキュメント",
        ),
        VectorSearchResultItem(
            chunk_id=3,
            document_id=3,
            path=p3.as_posix(),
            full_path=p3.as_posix(),
            title="image.png",
            chunk_index=0,
            score=0.85,
            hit_text="画像ファイル",
            salient_sentence="画像ファイル",
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
    search_mock = MagicMock(return_value=mock_res)
    monkeypatch.setattr(searcher, "search", search_mock)

    # 1. types="-json" で json が除外されること
    res_ext = client.get(
        "/api/search",
        params={
            "q": "テスト",
            "search_all_enabled": True,
            "search_type": "vector",
            "types": "-json",
        },
    )
    assert res_ext.status_code == 200
    ext_paths = [it["full_path"] for it in res_ext.json()["items"]]
    assert p2.as_posix() in ext_paths
    assert p1.as_posix() not in ext_paths

    # 2. q="テスト -.md" で .md がクエリ除外されること、かつベクトル検索には "テスト" だけが渡されること
    res_query = client.get(
        "/api/search",
        params={
            "q": "テスト -.md",
            "search_all_enabled": True,
            "search_type": "vector",
        },
    )
    assert res_query.status_code == 200
    query_paths = [it["full_path"] for it in res_query.json()["items"]]
    assert p1.as_posix() in query_paths
    assert p2.as_posix() not in query_paths
    # ベクトル検索にはポジティブ語 "テスト" のみが渡されたことを検証
    assert search_mock.call_args[1]["query"] == "テスト"
