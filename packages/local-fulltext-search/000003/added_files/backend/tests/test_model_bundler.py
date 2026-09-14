"""
モデルファイル分割・自動結合モジュール (model_bundler) の単体テスト

仕様:
1. split_file_into_chunks: 100MB以下のパーツ (既定45MB) にファイルを安全に分割する。
2. reassemble_chunks_into_file: 分割パーツから元のファイルを結合復元し、SHA256ハッシュが完全一致する。
3. ensure_model_files:
   - model.safetensors が未存在で model.safetensors.part* が存在する場合、自動結合して復元する。
   - 既に model.safetensors が存在する場合は結合処理をスキップする。
4. VectorState / Embedder 連携:
   - 分割パーツのみ配置されたモデルディレクトリからでも、自動結合を経て正常にロードされる。
"""

import hashlib
import os
from pathlib import Path
import pytest

from app.vector.model_bundler import (
    ensure_model_files,
    reassemble_chunks_into_file,
    split_file_into_chunks,
)


def compute_sha256(file_path: Path) -> str:
    """ファイルのSHA256ハッシュを計算する"""
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return h.hexdigest()


def test_split_and_reassemble_roundtrip(tmp_path: Path):
    """
    バイナリファイルの分割と結合が完全に一致（SHA256一致）することを検証する。
    """
    source_file = tmp_path / "test_model.safetensors"
    # 1MBの疑似バイナリデータを作成
    dummy_data = os.urandom(1024 * 1024)
    source_file.write_bytes(dummy_data)
    original_hash = compute_sha256(source_file)

    # 300KBごとに分割（計4パーツ）
    chunk_size = 300 * 1024
    part_files = split_file_into_chunks(source_file, chunk_size_bytes=chunk_size)

    assert len(part_files) == 4
    for p in part_files:
        assert p.exists()
        assert p.stat().st_size <= chunk_size

    # 元ファイルを削除して再結合
    source_file.unlink()
    reassembled_file = reassemble_chunks_into_file(source_file, part_files)

    assert reassembled_file.exists()
    assert compute_sha256(reassembled_file) == original_hash


def test_ensure_model_files_auto_reassembles_when_missing(tmp_path: Path):
    """
    model.safetensors が存在せず、model.safetensors.part* がある場合、
    ensure_model_files が自動的に結合して model.safetensors を復元することを検証する。
    """
    model_dir = tmp_path / "mock_model_dir"
    model_dir.mkdir()

    # ダミーデータを生成して分割パーツのみ配置
    target_safetensors = model_dir / "model.safetensors"
    dummy_data = b"MOCK_SAFETENSORS_DATA_12345" * 1000
    target_safetensors.write_bytes(dummy_data)
    original_hash = compute_sha256(target_safetensors)

    # 分割して元の safetensors を削除
    split_file_into_chunks(target_safetensors, chunk_size_bytes=5000)
    target_safetensors.unlink()

    assert not target_safetensors.exists()
    parts = sorted(model_dir.glob("model.safetensors.part*"))
    assert len(parts) > 1

    # ensure_model_files を実行
    restored = ensure_model_files(model_dir)

    assert restored == target_safetensors
    assert target_safetensors.exists()
    assert compute_sha256(target_safetensors) == original_hash


def test_ensure_model_files_skips_when_already_exists(tmp_path: Path):
    """
    model.safetensors が既に存在する場合、再結合を行わずにスキップすることを検証する。
    """
    model_dir = tmp_path / "mock_model_dir_exist"
    model_dir.mkdir()

    target_safetensors = model_dir / "model.safetensors"
    target_safetensors.write_bytes(b"EXISTING_DATA")
    mtime_before = target_safetensors.stat().st_mtime

    restored = ensure_model_files(model_dir)

    assert restored == target_safetensors
    assert target_safetensors.stat().st_mtime == mtime_before
