"""
ベクトルDBおよびFAISSインデックスの単体テスト。
SQLite永続化、チャンク文脈取得、FAISS内積類似度検索を検証する。
"""

import numpy as np
import pytest
from pathlib import Path
from app.vector.db import (
    clear_all_data,
    delete_document,
    get_all_chunk_embeddings,
    get_all_documents_metadata,
    get_chunk_with_context,
    get_db_stats,
    init_db,
    insert_chunks,
    upsert_document,
)
from app.vector.faiss_index import FaissVectorIndex


@pytest.fixture
def temp_db_path(tmp_path: Path) -> str:
    db_file = tmp_path / "test_vector.db"
    init_db(str(db_file))
    return str(db_file)


def test_db_document_and_chunks(temp_db_path: str) -> None:
    """ドキュメントとチャンクの作成、取得、削除を検証する"""
    dim = 4
    vec = np.array([0.5, 0.5, 0.5, 0.5], dtype=np.float32)
    vec_blob = vec.tobytes()

    doc_id = upsert_document(
        temp_db_path,
        path="/test/file1.md",
        title="File 1",
        mtime=1000.0,
        size=100,
        sha256="hash1",
        text="本文全体",
        embedding=vec_blob,
    )
    assert doc_id > 0

    chunks_data = [
        {"chunk_index": 0, "text": "チャンク0", "embedding": vec_blob, "embedding_dim": dim},
        {"chunk_index": 1, "text": "チャンク1", "embedding": vec_blob, "embedding_dim": dim},
        {"chunk_index": 2, "text": "チャンク2", "embedding": vec_blob, "embedding_dim": dim},
    ]
    insert_chunks(temp_db_path, doc_id, chunks_data)

    stats = get_db_stats(temp_db_path)
    assert stats["document_count"] == 1
    assert stats["chunk_count"] == 3

    meta = get_all_documents_metadata(temp_db_path)
    assert "/test/file1.md" in meta
    assert meta["/test/file1.md"]["sha256"] == "hash1"

    chunk_ids, embs = get_all_chunk_embeddings(temp_db_path)
    assert len(chunk_ids) == 3
    assert embs.shape == (3, dim)

    # チャンク文脈テスト
    mid_chunk_id = chunk_ids[1]
    ctx = get_chunk_with_context(temp_db_path, mid_chunk_id)
    assert ctx is not None
    assert ctx["hit_text"] == "チャンク1"
    assert ctx["prev_text"] == "チャンク0"
    assert ctx["next_text"] == "チャンク2"

    # ドキュメント削除
    delete_document(temp_db_path, "/test/file1.md")
    stats2 = get_db_stats(temp_db_path)
    assert stats2["document_count"] == 0
    assert stats2["chunk_count"] == 0


def test_faiss_vector_index() -> None:
    """FAISSインデックスの内積（コサイン類似度）検索を検証する"""
    index = FaissVectorIndex(dim=4)
    assert index.total_vectors == 0

    # 3つの正規化ベクトルを用意
    v1 = np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32)
    v2 = np.array([0.0, 1.0, 0.0, 0.0], dtype=np.float32)
    v3 = np.array([0.7071, 0.7071, 0.0, 0.0], dtype=np.float32)

    index.add_vectors([101, 102, 103], np.vstack([v1, v2, v3]))
    assert index.total_vectors == 3

    # v1 と類似検索
    q = np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32)
    results = index.search(q, top_k=3)
    assert len(results) == 3
    assert results[0][0] == 101
    assert np.isclose(results[0][1], 1.0, atol=1e-4)
    assert results[1][0] == 103  # 次に近い
