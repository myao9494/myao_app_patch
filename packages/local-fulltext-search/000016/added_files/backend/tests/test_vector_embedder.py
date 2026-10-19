"""
ベクトル埋め込みモジュール（Embedder）の単体テスト。
MockEmbedder および実モデル Embedder の動作、デバイス自動判定、L2正規化を検証する。
"""

from pathlib import Path

import numpy as np
import pytest
from app.vector.embedder import (
    BaseEmbedder,
    Embedder,
    MockEmbedder,
    auto_detect_device,
)


def test_auto_detect_device() -> None:
    """デバイス自動検出が有効な文字列（mps/cuda/cpu）を返すことを確認する"""
    dev = auto_detect_device()
    assert dev in {"mps", "cuda", "cpu"}


def test_mock_embedder_deterministic() -> None:
    """MockEmbedder が決定論的で L2 正規化されたベクトルを返すことを確認する"""
    embedder = MockEmbedder(dim=256)
    assert embedder.embedding_dim == 256

    vec1 = embedder.encode("テスト文書", is_query=False)
    vec2 = embedder.encode("テスト文書", is_query=False)
    assert np.allclose(vec1, vec2)
    assert np.isclose(np.linalg.norm(vec1), 1.0, atol=1e-5)

    batch_vecs = embedder.encode_batch(["テスト1", "テスト2"], is_query=False)
    assert batch_vecs.shape == (2, 256)
    assert np.isclose(np.linalg.norm(batch_vecs[0]), 1.0, atol=1e-5)
    assert np.isclose(np.linalg.norm(batch_vecs[1]), 1.0, atol=1e-5)


def test_mock_embedder_empty_batch() -> None:
    """空リストを渡した際に (0, dim) の配列を返すことを確認する"""
    embedder = MockEmbedder(dim=128)
    batch_vecs = embedder.encode_batch([])
    assert batch_vecs.shape == (0, 128)


def test_embedder_invalid_path() -> None:
    """存在しないモデルパスを指定したときに例外が発生することを確認する"""
    with pytest.raises(ValueError, match="ローカルモデルパスが存在しない"):
        Embedder("/non/existent/model/path")


_RURI_30M_PATH = Path(__file__).resolve().parents[2] / "models" / "ruri-v3-30m"


@pytest.mark.skipif(not (_RURI_30M_PATH / "config.json").exists(), reason="ruri-v3-30m モデルが配置されていない")
def test_embedder_batch_is_encoded_in_small_slices_with_same_vectors() -> None:
    """
    インデックス作成の一括推論は小分けに実行する（区切りごとに検索クエリへ順番を譲るため）。
    小分けにしても、1 件ずつ推論した結果と同じベクトルになる。
    """
    embedder = Embedder(str(_RURI_30M_PATH), device="cpu")
    texts = [f"設計資料 {index} の会議メモ。" * (1 + index % 3) for index in range(20)]
    expected = np.vstack([embedder.encode(text) for text in texts])

    real_model = embedder.model
    slice_sizes: list[int] = []

    class RecordingModel:
        def encode(self, sentences, **kwargs):
            slice_sizes.append(len(sentences))
            return real_model.encode(sentences, **kwargs)

    embedder.model = RecordingModel()
    vectors = embedder.encode_batch(texts)

    assert vectors.shape == (20, embedder.embedding_dim)
    assert np.allclose(vectors, expected, atol=1e-4)
    assert max(slice_sizes) <= Embedder.INFERENCE_SLICE_SIZE
    assert sum(slice_sizes) == 20
