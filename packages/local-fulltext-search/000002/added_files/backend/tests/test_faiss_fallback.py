"""
FAISS未インストール時のNumPyフォールバック動作検証テスト
仕様:
- FAISSが存在しない環境でも、NumPyによる内積計算で等価なコサイン類似度検索が動作する。
- アプリケーションの起動（app.main）がModuleNotFoundErrorで阻害されない。
"""

import os
from pathlib import Path
import sys

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pytest

from app.vector.faiss_index import FaissVectorIndex


def test_faiss_vector_index_fallback_behavior():
    """FAISSの有無に関わらずベクトルの追加と内積検索が正常に動作することを検証する"""
    dim = 4
    index = FaissVectorIndex(dim=dim)

    assert index.total_vectors == 0

    # 3つの正規化ベクトルを作成
    # v1: [1, 0, 0, 0]
    # v2: [0, 1, 0, 0]
    # v3: [0.7071, 0.7071, 0, 0]
    ids = [101, 102, 103]
    v1 = np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32)
    v2 = np.array([0.0, 1.0, 0.0, 0.0], dtype=np.float32)
    v3 = np.array([0.70710678, 0.70710678, 0.0, 0.0], dtype=np.float32)
    vectors = np.vstack([v1, v2, v3])

    index.add_vectors(ids, vectors)
    assert index.total_vectors == 3

    # クエリ [1, 0, 0, 0] に対して検索
    # 内積スコア: v1=1.0, v3=~0.7071, v2=0.0
    query = np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32)
    results = index.search(query, top_k=2)

    assert len(results) == 2
    assert results[0][0] == 101
    assert pytest.approx(results[0][1], abs=1e-4) == 1.0
    assert results[1][0] == 103
    assert pytest.approx(results[1][1], abs=1e-4) == 0.70710678

    # clear のテスト
    index.clear()
    assert index.total_vectors == 0
    assert index.search(query, top_k=2) == []


def test_faiss_vector_index_forced_numpy_fallback(monkeypatch):
    """HAS_FAISS=False の状況を強制し、NumPy内積検索が正常に動作することを検証する"""
    import app.vector.faiss_index as fi
    monkeypatch.setattr(fi, "HAS_FAISS", False)

    dim = 3
    index = fi.FaissVectorIndex(dim=dim)
    assert index.index is None
    assert index.total_vectors == 0

    ids = [1, 2]
    vectors = np.array([
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
    ], dtype=np.float32)
    index.add_vectors(ids, vectors)
    assert index.total_vectors == 2

    query = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    res = index.search(query, top_k=1)
    assert len(res) == 1
    assert res[0][0] == 1
    assert pytest.approx(res[0][1], abs=1e-4) == 1.0

    index.clear()
    assert index.total_vectors == 0


def test_import_main_without_faiss():
    """FAISS未インストール環境でも app.main が正常にインポート可能であることを検証する"""
    import importlib
    main_mod = importlib.import_module("app.main")
    assert hasattr(main_mod, "create_app")

