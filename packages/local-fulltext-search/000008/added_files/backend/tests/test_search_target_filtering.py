"""
検索APIにおける登録検索対象フォルダ制限および実ファイル実在性検証のテスト。

仕様:
- search_type="vector" および "hybrid" の検索時、現在有効な登録フォルダ（targets）外のファイルは検索結果から除外される。
- search_type="vector" および "hybrid" の検索時、ディスク上に実体が存在しない（削除済み）ファイルは除外される。
- 有効な登録フォルダ配下に実在するファイルのみが検索結果として返される。
"""

import sqlite3
from pathlib import Path
from unittest.mock import MagicMock
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.api.deps import get_db_connection
from app.db.schema import initialize_schema
from app.vector.searcher import (
    SearchResultItem as VectorSearchResultItem,
    SearchResponse as VectorSearchResponse,
)
from app.vector.state import vector_state


@pytest.fixture
def search_test_env(tmp_path: Path):
    """
    テスト用の一時ディレクトリ、DB、およびベクトルモックを構築する fixture。
    """
    # フォルダ準備
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    allowed_dir = tmp_path / "allowed_workspace"
    allowed_dir.mkdir(parents=True, exist_ok=True)
    outside_dir = tmp_path / "outside_workspace"
    outside_dir.mkdir(parents=True, exist_ok=True)

    # 実在するファイルを作成
    valid_file = allowed_dir / "valid_doc.md"
    valid_file.write_text("これは許可されたフォルダ内の実在する文書です。", encoding="utf-8")

    outside_file = outside_dir / "outside_doc.md"
    outside_file.write_text("これは登録外のフォルダの文書です。", encoding="utf-8")

    # 存在しない（削除された）ファイルパス
    ghost_file = allowed_dir / "deleted_ghost_doc.md"

    # テスト用一時DBの作成とスキーマ初期化
    test_db_path = tmp_path / "test_search.db"
    test_conn = sqlite3.connect(test_db_path, check_same_thread=False)
    test_conn.row_factory = sqlite3.Row
    test_conn.execute("PRAGMA foreign_keys = ON;")
    initialize_schema(test_conn)

    # targets テーブルに allowed_dir を登録
    test_conn.execute(
        """
        INSERT INTO targets (
            full_path, is_search_target_enabled, source_type, indexed_file_count,
            created_at, updated_at
        ) VALUES (?, 1, 'local', 1, datetime('now'), datetime('now'))
        """,
        (allowed_dir.as_posix(),),
    )
    test_conn.commit()

    # FastAPI 依存性注入の差し替え
    def _override_db():
        conn = sqlite3.connect(test_db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    app.dependency_overrides[get_db_connection] = _override_db

    # vector_state の退避と設定
    orig_embedder = vector_state.embedder
    orig_searcher = vector_state.searcher
    orig_model_path = vector_state.model_path
    orig_data_dir = vector_state.data_dir
    orig_config_path = vector_state.config_path

    vector_state.data_dir = data_dir
    vector_state.config_path = data_dir / "config.json"
    vector_state.load_model(use_mock=True, mock_dim=64)

    # モックの検索結果（3件: 許可内実在, 登録外実在, 許可内実在せずゴースト）
    mock_results = [
        VectorSearchResultItem(
            chunk_id=1,
            document_id=1,
            path=valid_file.as_posix(),
            full_path=valid_file.as_posix(),
            title=valid_file.name,
            chunk_index=0,
            score=0.95,
            hit_text="実在する文書",
            salient_sentence="実在する文書",
        ),
        VectorSearchResultItem(
            chunk_id=2,
            document_id=2,
            path=outside_file.as_posix(),
            full_path=outside_file.as_posix(),
            title=outside_file.name,
            chunk_index=0,
            score=0.90,
            hit_text="登録外の文書",
            salient_sentence="登録外の文書",
        ),
        VectorSearchResultItem(
            chunk_id=3,
            document_id=3,
            path=ghost_file.as_posix(),
            full_path=ghost_file.as_posix(),
            title=ghost_file.name,
            chunk_index=0,
            score=0.85,
            hit_text="削除済みゴースト文書",
            salient_sentence="削除済みゴースト文書",
        ),
    ]

    mock_searcher = MagicMock()
    mock_searcher.search.return_value = VectorSearchResponse(
        query="文書",
        results=mock_results,
        mode="dense",
        total_candidates=len(mock_results),
        query_embedding_time_ms=1.0,
        search_time_ms=1.0,
        total_time_ms=2.0,
        detected_terms=[],
        rag_context_xml="",
        rag_context_markdown="",
    )
    vector_state.searcher = mock_searcher

    client = TestClient(app)

    try:
        yield {
            "client": client,
            "allowed_dir": allowed_dir,
            "outside_dir": outside_dir,
            "valid_file": valid_file,
            "outside_file": outside_file,
            "ghost_file": ghost_file,
        }
    finally:
        app.dependency_overrides.pop(get_db_connection, None)
        test_conn.close()

        vector_state.embedder = orig_embedder
        vector_state.searcher = orig_searcher
        vector_state.model_path = orig_model_path
        vector_state.data_dir = orig_data_dir
        vector_state.config_path = orig_config_path


def test_vector_search_filters_outside_targets_and_ghost_files(search_test_env):
    """
    vector 検索時、有効な登録フォルダ外のファイルや実在しないファイルは除外され、
    有効フォルダ内に実在するファイルのみが返ること。
    """
    client = search_test_env["client"]
    valid_file = search_test_env["valid_file"]
    outside_file = search_test_env["outside_file"]
    ghost_file = search_test_env["ghost_file"]

    res = client.get(
        "/api/search",
        params={"q": "文書", "search_type": "vector", "search_all_enabled": True},
    )
    assert res.status_code == 200
    items = res.json()["items"]
    paths = [it["full_path"] for it in items]

    assert valid_file.as_posix() in paths
    assert outside_file.as_posix() not in paths
    assert ghost_file.as_posix() not in paths


def test_hybrid_search_filters_outside_targets_and_ghost_files(search_test_env):
    """
    hybrid 検索時、有効な登録フォルダ外のファイルや実在しないファイルは除外され、
    有効フォルダ内に実在するファイルのみが返ること。
    """
    client = search_test_env["client"]
    valid_file = search_test_env["valid_file"]
    outside_file = search_test_env["outside_file"]
    ghost_file = search_test_env["ghost_file"]

    res = client.get(
        "/api/search",
        params={"q": "文書", "search_type": "hybrid", "search_all_enabled": True},
    )
    assert res.status_code == 200
    items = res.json()["items"]
    paths = [it["full_path"] for it in items]

    assert valid_file.as_posix() in paths
    assert outside_file.as_posix() not in paths
    assert ghost_file.as_posix() not in paths
