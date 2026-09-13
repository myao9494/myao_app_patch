"""
ベクトル検索エンジン（VectorSearcher）の単体テスト。
FAISS検索、チャンク文脈、反応文抽出、RAGコンテキスト生成を検証する。
"""

from typing import Tuple
import numpy as np
import pytest
from pathlib import Path
from app.vector.db import init_db, insert_chunks, upsert_document
from app.vector.embedder import MockEmbedder
from app.vector.searcher import SearchMode, VectorSearcher, generate_rag_contexts


@pytest.fixture
def populated_db(tmp_path: Path) -> Tuple[str, MockEmbedder]:
    db_file = str(tmp_path / "searcher_test.db")
    init_db(db_file)
    embedder = MockEmbedder(dim=128)

    # 2つの文書を挿入
    text1 = "機械学習とベクトル検索の基礎について解説します。\nFAISSは高速な類似度検索ライブラリです。"
    v1 = embedder.encode(text1)
    doc_id1 = upsert_document(
        db_file,
        path="/docs/ml.md",
        title="機械学習入門",
        mtime=1000.0,
        size=len(text1),
        sha256="h1",
        text=text1,
        embedding=v1.tobytes(),
    )
    insert_chunks(db_file, doc_id1, [
        {"chunk_index": 0, "text": "機械学習とベクトル検索の基礎について解説します。", "embedding": embedder.encode("機械学習とベクトル検索の基礎について解説します。").tobytes(), "embedding_dim": 128},
        {"chunk_index": 1, "text": "FAISSは高速な類似度検索ライブラリです。", "embedding": embedder.encode("FAISSは高速な類似度検索ライブラリです。").tobytes(), "embedding_dim": 128},
    ])

    text2 = "料理のレシピ集。おいしいカレーの作り方。"
    v2 = embedder.encode(text2)
    doc_id2 = upsert_document(
        db_file,
        path="/docs/curry.md",
        title="カレーレシピ",
        mtime=1000.0,
        size=len(text2),
        sha256="h2",
        text=text2,
        embedding=v2.tobytes(),
    )
    insert_chunks(db_file, doc_id2, [
        {"chunk_index": 0, "text": text2, "embedding": v2.tobytes(), "embedding_dim": 128},
    ])

    return db_file, embedder


def test_vector_searcher_chunk_mode(populated_db) -> None:
    """チャンク検索モードで検索結果が得られ、反応文や文脈が取得できること"""
    db_file, embedder = populated_db
    searcher = VectorSearcher(db_path=db_file, embedder=embedder)

    res = searcher.search(query="ベクトル検索 FAISS", mode=SearchMode.CHUNK, top_k=5)
    assert res.query == "ベクトル検索 FAISS"
    assert len(res.results) > 0
    top = res.results[0]
    assert top.document_id > 0
    assert top.path == "/docs/ml.md"
    assert top.score > 0.0
    assert top.hit_text is not None
    assert top.salient_sentence is not None
    assert res.rag_context_xml.startswith("<context")
    assert "参考コンテキスト" in res.rag_context_markdown


def test_generate_rag_contexts_empty() -> None:
    """結果が空の場合に適切なプレースホルダーRAGコンテキストが返ること"""
    xml, md = generate_rag_contexts([], "テストクエリ")
    assert "関連コンテキストは見つかりませんでした" in xml
    assert "関連するコンテキストは見つかりませんでした" in md
