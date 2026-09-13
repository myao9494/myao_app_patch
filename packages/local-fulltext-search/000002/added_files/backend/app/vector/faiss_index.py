"""
FAISS ベクトルインデックス管理モジュール。
仕様:
- faiss.IndexFlatIP（内積検索）を用いて、L2正規化ベクトル間のコサイン類似度を高速検索する。
- FAISSがインストールされていない環境では、NumPyの内積計算を用いた等価な高速フォールバックインデックスを提供する。
- 内部ID（SQLiteのチャンクIDまたはドキュメントID）とインデックス行位置の双方向マッピングを管理する。
- スレッドセーフな検索とインデックス再構築を提供する。
"""

import logging
import threading
from typing import List, Optional, Tuple
import numpy as np

logger = logging.getLogger(__name__)

try:
    import faiss
    HAS_FAISS = True
except ImportError:
    faiss = None
    HAS_FAISS = False
    logger.info("faiss が未検出のため、NumPy による内積ベクトル検索フォールバックを使用します。")


class FaissVectorIndex:
    """FAISS 内積インデックス管理クラス（FAISS未導入時はNumPyでフォールバック）"""

    def __init__(self, dim: int):
        self.dim = dim
        self._lock = threading.Lock()
        self.id_map: List[int] = []  # row index -> SQLite ID
        if HAS_FAISS and faiss is not None:
            self.index = faiss.IndexFlatIP(dim)
            self._numpy_vectors: Optional[np.ndarray] = None
        else:
            self.index = None
            self._numpy_vectors = np.empty((0, dim), dtype=np.float32)

    @property
    def total_vectors(self) -> int:
        with self._lock:
            if HAS_FAISS and self.index is not None:
                return self.index.ntotal
            return len(self.id_map)

    def clear(self) -> None:
        """インデックスとマッピングをクリアする"""
        with self._lock:
            self.id_map.clear()
            if HAS_FAISS and self.index is not None:
                self.index = faiss.IndexFlatIP(self.dim)
            else:
                self._numpy_vectors = np.empty((0, self.dim), dtype=np.float32)

    def add_vectors(self, ids: List[int], vectors: np.ndarray) -> None:
        """ベクトル群とそのIDを追加する"""
        if len(ids) == 0 or vectors.size == 0:
            return

        vectors = np.ascontiguousarray(vectors, dtype=np.float32)
        with self._lock:
            if HAS_FAISS and self.index is not None:
                self.index.add(vectors)
            else:
                if self._numpy_vectors is None or self._numpy_vectors.size == 0:
                    self._numpy_vectors = vectors
                else:
                    self._numpy_vectors = np.vstack([self._numpy_vectors, vectors])
            self.id_map.extend(ids)

    def search(self, query_vector: np.ndarray, top_k: int = 20) -> List[Tuple[int, float]]:
        """
        クエリベクトルと類似する上位K件の (SQLite_ID, コサイン類似度スコア) を返す。
        """
        with self._lock:
            total = self.index.ntotal if (HAS_FAISS and self.index is not None) else len(self.id_map)
            if total == 0:
                return []

            k = min(top_k, total)
            if HAS_FAISS and self.index is not None:
                q = np.ascontiguousarray(query_vector.reshape(1, -1), dtype=np.float32)
                scores, indices = self.index.search(q, k)

                results: List[Tuple[int, float]] = []
                for row_idx, score in zip(indices[0], scores[0]):
                    if row_idx < 0 or row_idx >= len(self.id_map):
                        continue
                    results.append((self.id_map[row_idx], float(score)))
                return results
            else:
                # NumPy による内積検索（L2正規化済みベクトルの内積＝コサイン類似度）
                q = np.ascontiguousarray(query_vector.reshape(-1), dtype=np.float32)
                scores = np.dot(self._numpy_vectors, q)

                if k >= len(scores):
                    top_indices = np.argsort(-scores)
                else:
                    partitioned = np.argpartition(-scores, k)[:k]
                    top_indices = partitioned[np.argsort(-scores[partitioned])]

                results = []
                for row_idx in top_indices:
                    results.append((self.id_map[row_idx], float(scores[row_idx])))
                return results
