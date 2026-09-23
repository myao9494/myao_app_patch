"""
pytest 実行時のグローバル設定およびテスト環境隔離 fixture。

仕様:
- 全テストにおいて、実環境の `backend/data` を汚染しないよう `vector_state.data_dir` を一時ディレクトリに隔離する。
- テスト終了後に元の状態へ復元する。
"""

import os
from pathlib import Path
import pytest

from app.config import settings
from app.vector.state import vector_state


@pytest.fixture(autouse=True)
def isolate_vector_state_for_tests(tmp_path: Path):
    """
    テスト実行時に実環境のベクトルDBおよび設定ファイルが汚染されるのを防止する。
    """
    orig_data_dir = vector_state.data_dir
    orig_config_path = vector_state.config_path
    orig_model_path = vector_state.model_path
    orig_embedder = vector_state.embedder
    orig_searcher = vector_state.searcher

    # 一時ディレクトリに隔離
    test_vector_dir = tmp_path / "test_vector_data"
    test_vector_dir.mkdir(parents=True, exist_ok=True)
    vector_state.data_dir = test_vector_dir
    vector_state.config_path = test_vector_dir / "config.json"

    try:
        yield
    finally:
        vector_state.data_dir = orig_data_dir
        vector_state.config_path = orig_config_path
        vector_state.model_path = orig_model_path
        vector_state.embedder = orig_embedder
        vector_state.searcher = orig_searcher
