"""
Embedding 生成モジュール。
仕様:
- ローカルパスに配置された Sentence Transformers モデル（ruri-v3-310m, ruri-v3-30m, E5等）からEmbeddingを生成する。
- 実行時のモデル自動ダウンロードは禁止し、指定パスが存在しない場合は即座に例外を発生させる。
- デバイス自動選択: Mac（Apple Silicon）環境では MPS (Metal GPU)、Windows/CPU環境では CPU（CUDA検知時はCUDA）を自動設定。
- プロンプト/プレフィックス制御:
  - ruri系モデル (ruri-v3): クエリには「検索クエリ: 」、文書には「検索文書: 」を付与。
  - e5系モデル: クエリには「query: 」、文書には「passage: 」を付与。
- 全てのEmbeddingベクトルはL2正規化（float32）されたNumPy配列として返却され、FAISS / 内積計算のみでコサイン類似度が得られる。
- テスト・オフライン動作用の MockEmbedder を提供する。
"""

import hashlib
import os
import sys
import threading

# Mac / Apple Silicon 上での OpenMP (libomp) および HuggingFace Tokenizers の並列スレッド競合クラッシュを防止
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

try:
    import torch
    torch.set_num_threads(1)
except ImportError:
    pass

from pathlib import Path
from typing import List, Optional, Union
import numpy as np


import logging

logger = logging.getLogger(__name__)


def auto_detect_device() -> str:
    """
    実行環境の最適なPyTorchデバイスを自動検出する。
    - 環境変数 VECTOR_DEVICE があればそれを最優先 (例: "cpu", "cuda", "mps")。
    - CUDA が利用可能なら "cuda" (Windows RTX A500等のNVIDIA GPU環境)。
    - Mac (Apple Silicon) で MPS が利用可能なら "mps" (Metal GPU環境)。
    - いずれも利用不可なら "cpu"。
    """
    env_device = os.getenv("VECTOR_DEVICE")
    if env_device:
        return env_device.strip().lower()
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available() and torch.backends.mps.is_built():
            return "mps"
    except (ImportError, Exception):
        pass
    return "cpu"


def get_device_info() -> dict:
    """
    現在の実行環境におけるデバイス情報（種別、表示名、利用可否フラグ）を取得する。
    """
    device = auto_detect_device()
    cuda_avail = False
    mps_avail = False
    device_name = "CPU"

    try:
        import torch
        cuda_avail = bool(torch.cuda.is_available())
        if hasattr(torch.backends, "mps"):
            mps_avail = bool(torch.backends.mps.is_available() and torch.backends.mps.is_built())

        if device.startswith("cuda"):
            if cuda_avail:
                gpu_name = torch.cuda.get_device_name(0) if torch.cuda.device_count() > 0 else "CUDA GPU"
                device_name = f"{gpu_name} (CUDA)"
            else:
                device_name = f"{device.upper()} (CUDA)"
        elif device == "mps":
            device_name = "Apple Silicon GPU (Metal / MPS)"
        else:
            device_name = "CPU"
    except (ImportError, Exception):
        pass

    return {
        "device": device,
        "device_name": device_name,
        "cuda_available": cuda_avail,
        "mps_available": mps_avail,
    }


class BaseEmbedder:
    """Embedderの基底インターフェース"""
    model_path: Optional[str] = None

    @property
    def embedding_dim(self) -> int:
        raise NotImplementedError

    def encode(self, text: str, is_query: bool = False) -> np.ndarray:
        raise NotImplementedError

    def encode_batch(self, texts: List[str], is_query: bool = False, batch_size: int = 32) -> np.ndarray:
        raise NotImplementedError


class MockEmbedder(BaseEmbedder):
    """
    テスト・PoC初期検証用の決定論的モックEmbedder。
    文字列のハッシュ値から一定次元の正規化乱数ベクトルを生成する。
    """
    def __init__(self, dim: int = 768, model_path: Optional[str] = None):
        self._dim = dim
        self.model_path = model_path

    @property
    def embedding_dim(self) -> int:
        return self._dim

    def _generate_vector(self, text: str) -> np.ndarray:
        seed = int(hashlib.md5(text.encode("utf-8")).hexdigest()[:8], 16)
        rng = np.random.RandomState(seed)
        vec = rng.randn(self._dim).astype(np.float32)
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec /= norm
        return vec

    def encode(self, text: str, is_query: bool = False) -> np.ndarray:
        return self._generate_vector(text)

    def encode_batch(self, texts: List[str], is_query: bool = False, batch_size: int = 32) -> np.ndarray:
        if not texts:
            return np.empty((0, self._dim), dtype=np.float32)
        return np.vstack([self._generate_vector(t) for t in texts])


class Embedder(BaseEmbedder):
    """
    Sentence Transformers をローカルディレクトリからロードするEmbedder。
    ruri-v3 / E5 などのプレフィックス仕様に自動対応し、MPS/CPUでの高速推論を実行する。
    """
    def __init__(self, model_path: str, device: Optional[str] = None):
        resolved_path = Path(model_path).resolve()
        if not resolved_path.exists() or not resolved_path.is_dir():
            raise ValueError(f"指定されたローカルモデルパスが存在しないかディレクトリではありません: {model_path}")

        # 分割モデルパーツがある場合は自動結合して復元 (GitHub 100MB 制限対応)
        from app.vector.model_bundler import ensure_model_files
        ensure_model_files(resolved_path)

        self.model_path = str(resolved_path)
        self.model_path_str = str(resolved_path)
        path_lower = self.model_path_str.lower()
        self.is_ruri = "ruri" in path_lower
        self.is_e5 = "e5" in path_lower

        self.device = device or auto_detect_device()

        # SentenceTransformer のインポートとモデルロード（ローカルパスのみ）
        from sentence_transformers import SentenceTransformer
        try:
            self.model = SentenceTransformer(
                self.model_path,
                device=self.device,
                local_files_only=True
            )
        except Exception as e:
            if self.device != "cpu":
                logger.warning(
                    "Embedder: %s でのモデルロードに失敗したため、CPUにフォールバックします (%s)",
                    self.device,
                    e
                )
                self.device = "cpu"
                self.model = SentenceTransformer(
                    self.model_path,
                    device="cpu",
                    local_files_only=True
                )
            else:
                raise

        self._lock = threading.Lock()
        if hasattr(self.model, "get_embedding_dimension"):
            self._dim = self.model.get_embedding_dimension()
        else:
            self._dim = self.model.get_sentence_embedding_dimension()

    @property
    def embedding_dim(self) -> int:
        return self._dim

    def _format_text(self, text: str, is_query: bool) -> str:
        """モデル仕様に応じたプロンプトプレフィックスを付与する"""
        if self.is_ruri:
            prefix = "検索クエリ: " if is_query else "検索文書: "
            return f"{prefix}{text}"
        elif self.is_e5:
            prefix = "query: " if is_query else "passage: "
            return f"{prefix}{text}"
        return text

    def _fallback_to_cpu(self) -> None:
        """GPUでの実行時エラー発生時に安全にCPUへ切り替える"""
        from sentence_transformers import SentenceTransformer
        self.device = "cpu"
        self.model = SentenceTransformer(
            self.model_path,
            device="cpu",
            local_files_only=True
        )

    def encode(self, text: str, is_query: bool = False) -> np.ndarray:
        formatted = self._format_text(text, is_query)
        with self._lock:
            try:
                vec = self.model.encode(
                    formatted,
                    normalize_embeddings=True,
                    show_progress_bar=False,
                    convert_to_numpy=True
                )
            except Exception as e:
                if self.device != "cpu":
                    logger.warning(
                        "Embedder: %s での推論中にエラーが発生したため、CPUに切り替えます (%s)",
                        self.device,
                        e
                    )
                    self._fallback_to_cpu()
                    vec = self.model.encode(
                        formatted,
                        normalize_embeddings=True,
                        show_progress_bar=False,
                        convert_to_numpy=True
                    )
                else:
                    raise
        return vec.astype(np.float32)

    def encode_batch(self, texts: List[str], is_query: bool = False, batch_size: int = 32) -> np.ndarray:
        if not texts:
            return np.empty((0, self._dim), dtype=np.float32)
        formatted_texts = [self._format_text(t, is_query) for t in texts]
        with self._lock:
            try:
                vecs = self.model.encode(
                    formatted_texts,
                    batch_size=batch_size,
                    normalize_embeddings=True,
                    show_progress_bar=False,
                    convert_to_numpy=True
                )
            except Exception as e:
                if self.device != "cpu":
                    logger.warning(
                        "Embedder: %s でのバッチ推論中にエラーが発生したため、CPUに切り替えます (%s)",
                        self.device,
                        e
                    )
                    self._fallback_to_cpu()
                    vecs = self.model.encode(
                        formatted_texts,
                        batch_size=batch_size,
                        normalize_embeddings=True,
                        show_progress_bar=False,
                        convert_to_numpy=True
                    )
                else:
                    raise
        return vecs.astype(np.float32)

