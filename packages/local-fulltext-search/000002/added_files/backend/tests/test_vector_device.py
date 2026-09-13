"""
GPU (Mac MPS / Windows CUDA) 自動検出・CPUフォールバック仕様テスト
仕様:
1. auto_detect_device:
   - 環境変数 VECTOR_DEVICE があれば最優先 (例: "cpu", "cuda", "mps")。
   - CUDA が利用可能であれば "cuda" (Windows RTX A500等)。
   - Mac で Apple Silicon (MPS) が利用可能であれば "mps"。
   - いずれも非対応なら "cpu"。
2. get_device_info:
   - device, device_name, cuda_available, mps_available を辞書で返却。
3. Embedder のフォールバック:
   - GPU 初期化に失敗した場合に自動的に "cpu" へ切り替えて初期化を完遂する。
4. API連携:
   - /api/vector/model/status が device, device_name, cuda_available, mps_available を含む。
"""

import os
import unittest
from unittest.mock import MagicMock, patch
import pytest


def test_auto_detect_device_env_override(monkeypatch):
    """環境変数 VECTOR_DEVICE が最優先されることのテスト"""
    from app.vector.embedder import auto_detect_device

    monkeypatch.setenv("VECTOR_DEVICE", "mps")
    assert auto_detect_device() == "mps"

    monkeypatch.setenv("VECTOR_DEVICE", "cpu")
    assert auto_detect_device() == "cpu"

    monkeypatch.setenv("VECTOR_DEVICE", "cuda:0")
    assert auto_detect_device() == "cuda:0"


def test_auto_detect_device_cuda_priority(monkeypatch):
    """CUDA が利用可能な環境では 'cuda' が選択されることのテスト (RTX A500等のWindows環境)"""
    monkeypatch.delenv("VECTOR_DEVICE", raising=False)
    from app.vector.embedder import auto_detect_device

    with patch("torch.cuda.is_available", return_value=True):
        assert auto_detect_device() == "cuda"


def test_auto_detect_device_mps_priority(monkeypatch):
    """CUDA が不可で MPS が利用可能な環境では 'mps' が選択されることのテスト (Mac環境)"""
    monkeypatch.delenv("VECTOR_DEVICE", raising=False)
    from app.vector.embedder import auto_detect_device

    with patch("torch.cuda.is_available", return_value=False):
        with patch("torch.backends.mps.is_available", return_value=True):
            with patch("torch.backends.mps.is_built", return_value=True):
                assert auto_detect_device() == "mps"


def test_auto_detect_device_cpu_fallback(monkeypatch):
    """CUDA も MPS も利用できない環境では 'cpu' にフォールバックすることのテスト"""
    monkeypatch.delenv("VECTOR_DEVICE", raising=False)
    from app.vector.embedder import auto_detect_device

    with patch("torch.cuda.is_available", return_value=False):
        with patch("torch.backends.mps.is_available", return_value=False):
            assert auto_detect_device() == "cpu"


def test_get_device_info(monkeypatch):
    """get_device_info がデバイス種別・表示名・利用可否フラグを正しく返却することのテスト"""
    from app.vector.embedder import get_device_info

    info = get_device_info()
    assert "device" in info
    assert "device_name" in info
    assert "cuda_available" in info
    assert "mps_available" in info
    assert isinstance(info["cuda_available"], bool)
    assert isinstance(info["mps_available"], bool)


def test_embedder_gpu_initialization_failure_falls_back_to_cpu(monkeypatch, tmp_path):
    """GPUロード時に例外が発生した場合に自動で CPU にフォールバックすることのテスト"""
    from app.vector.embedder import Embedder

    # ダミーのローカルモデルディレクトリ
    dummy_model_dir = tmp_path / "dummy_model"
    dummy_model_dir.mkdir()

    calls = []

    def mock_sentence_transformer(path, device, **kwargs):
        calls.append(device)
        if device == "mps":
            raise RuntimeError("MPS out of memory or driver failure")
        mock_model = MagicMock()
        mock_model.get_sentence_embedding_dimension.return_value = 256
        return mock_model

    with patch("sentence_transformers.SentenceTransformer", side_effect=mock_sentence_transformer):
        embedder = Embedder(str(dummy_model_dir), device="mps")
        # 1回目は mps で失敗し、2回目で cpu にフォールバックしていること
        assert calls == ["mps", "cpu"]
        assert embedder.device == "cpu"


def test_api_status_includes_device_info():
    """/api/vector/model/status がデバイス情報を含んでいることのテスト"""
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    res = client.get("/api/vector/model/status")
    assert res.status_code == 200
    data = res.json()
    assert "device" in data
    assert "device_name" in data
    assert "cuda_available" in data
    assert "mps_available" in data


def test_embedder_inference_gpu_failure_falls_back_to_cpu(tmp_path):
    """推論実行時にGPUエラーが発生した場合に自動でCPUへ切り替えて結果を返すテスト"""
    import numpy as np
    from app.vector.embedder import Embedder

    dummy_model_dir = tmp_path / "dummy_model"
    dummy_model_dir.mkdir()

    gpu_model = MagicMock()
    gpu_model.get_sentence_embedding_dimension.return_value = 256
    gpu_model.encode.side_effect = RuntimeError("GPU out of memory during encode")

    cpu_model = MagicMock()
    cpu_model.get_sentence_embedding_dimension.return_value = 256
    cpu_model.encode.return_value = np.zeros(256, dtype=np.float32)

    def mock_init(path, device, **kwargs):
        if device == "mps":
            return gpu_model
        return cpu_model

    with patch("sentence_transformers.SentenceTransformer", side_effect=mock_init):
        embedder = Embedder(str(dummy_model_dir), device="mps")
        assert embedder.device == "mps"

        # encode 実行時に GPU エラーが発生し、CPU にフォールバックして結果が得られること
        vec = embedder.encode("テスト文章")
        assert embedder.device == "cpu"
        assert vec.shape == (256,)


