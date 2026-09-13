"""
ベクトルモデル選択の永続化 (config.json) および起動時自動ロードの単体テスト。
仕様:
- モデルの選択状態を config.json に保存し、次回起動時に復元する。
- config.json が未作成の場合はデフォルトモデルへフォールバックする。
- API経由でのモデルロード時に config.json が自動保存される。
"""

import json
from pathlib import Path
import pytest

from app.vector.state import VectorState


def test_vector_state_save_and_load_config(tmp_path: Path) -> None:
    """config.json に保存されたモデル選択を復元できること"""
    vs = VectorState(data_dir=tmp_path)
    config_file = tmp_path / "config.json"

    # 初期状態では未設定
    assert vs.get_saved_model_path() == vs.default_light_path

    # モデルを保存
    test_model_path = str(tmp_path / "test_model_310m")
    vs.save_model_selection(test_model_path)

    # config.json が作成され正しい値が入っていること
    assert config_file.exists()
    saved_data = json.loads(config_file.read_text(encoding="utf-8"))
    assert saved_data["selected_model"] == test_model_path

    # 次回の復元で保存値が取得できること
    vs_restored = VectorState(data_dir=tmp_path)
    assert vs_restored.get_saved_model_path() == test_model_path


def test_vector_model_load_persists_to_config(tmp_path: Path) -> None:
    """Mockモデルのロード時にも設定が永続化されること"""
    vs = VectorState(data_dir=tmp_path)
    res = vs.load_model(use_mock=True, mock_dim=64)
    assert res["loaded"] is True

    config_file = tmp_path / "config.json"
    assert config_file.exists()
    saved_data = json.loads(config_file.read_text(encoding="utf-8"))
    assert saved_data["selected_model"] == "mock_model"
