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
- 推論は 1 つずつ実行し、検索クエリをインデックス作成より優先する（app.vector.inference_gate）。
  インデックス作成は小分けに推論するので、バックグラウンドの更新中でも検索は大きなファイルの推論完了を待たない。
- テスト・オフライン動作用の MockEmbedder を提供する。
"""

import hashlib
import os

# OpenMP / Tokenizers のスレッド設定は app.runtime_env に集約している（app パッケージ import 時に環境変数を適用済み）
from app.runtime_env import apply_torch_thread_limit

apply_torch_thread_limit()

from pathlib import Path
from typing import List, Optional
import numpy as np

from app.vector.inference_gate import InferenceGate


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
    except Exception:
        # torch が無い・壊れている環境では CPU を使う
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
    except Exception:
        # torch が無い・壊れている環境では、利用可否を確認できないので下の既定値（CPU）を使う
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
    推論は InferenceGate で 1 つずつ実行し、検索クエリ（encode）をインデックス作成（encode_batch）より優先する。
    """

    # インデックス作成の推論で、1 度に順番を占有する件数。
    # 検索クエリの待ち時間はこの件数分の推論が上限になる（CPU では小さい区切りのほうが詰め物が減り、総時間も短い）
    INFERENCE_SLICE_SIZE = 8
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

        self._gate = InferenceGate()
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

    def _encode_with_cpu_fallback(self, inputs, **encode_kwargs) -> np.ndarray:
        """モデルで推論する。GPU での実行時エラーは CPU へ切り替えて 1 度だけやり直す。呼び出し側が順番を取ってから呼ぶ。"""
        options = {"normalize_embeddings": True, "show_progress_bar": False, "convert_to_numpy": True, **encode_kwargs}
        try:
            return self.model.encode(inputs, **options)
        except Exception as e:
            if self.device == "cpu":
                raise
            logger.warning(
                "Embedder: %s での推論中にエラーが発生したため、CPUに切り替えます (%s)",
                self.device,
                e
            )
            self._fallback_to_cpu()
            return self.model.encode(inputs, **options)

    def encode(self, text: str, is_query: bool = False) -> np.ndarray:
        """1 件を推論する（検索クエリ用）。インデックス作成の推論より先に順番を取る。"""
        formatted = self._format_text(text, is_query)
        with self._gate.query():
            vec = self._encode_with_cpu_fallback(formatted)
        return vec.astype(np.float32)

    def encode_batch(self, texts: List[str], is_query: bool = False, batch_size: int = 32) -> np.ndarray:
        """
        複数件を推論する（インデックス作成用）。
        INFERENCE_SLICE_SIZE 件ずつに分けて区切りごとに順番を取り直し、その間に来た検索クエリを先に通す。
        """
        if not texts:
            return np.empty((0, self._dim), dtype=np.float32)
        formatted_texts = [self._format_text(t, is_query) for t in texts]
        slice_size = max(1, min(batch_size, self.INFERENCE_SLICE_SIZE))
        slices: List[np.ndarray] = []
        for start in range(0, len(formatted_texts), slice_size):
            chunk = formatted_texts[start : start + slice_size]
            with self._gate.batch():
                slices.append(self._encode_with_cpu_fallback(chunk, batch_size=len(chunk)))
        return np.vstack(slices).astype(np.float32)

