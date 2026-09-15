"""
ベクトルモデル選択の永続化 (config.json) および起動時自動ロード仕様の単体テスト。

仕様:
- 初回起動時や未選択時はモデルを自動ロードせず待機状態とする（get_saved_model_path() は None を返す）。
- load_saved_model() は記録がある場合のみモデルを自動ロードし、記録がない場合は何もしない。
- 有効なモデルが選択・ロードされた場合、config.json に永続化され、次回起動時に復元される。
- mock_model などのテスト用ダミーモデルは config.json に保存されない（汚染防止）。
"""

import json
from pathlib import Path
import pytest

from app.vector.state import VectorState


def test_vector_state_initial_state_has_no_saved_model(tmp_path: Path) -> None:
    """初回起動時（未保存時）は保存モデルがなく、load_saved_model() でも自動ロードされないこと"""
    vs = VectorState(data_dir=tmp_path)
    config_file = tmp_path / "config.json"

    # 初期状態では未設定（None を返し、勝手にデフォルトモデルへフォールバックしない）
    assert vs.get_saved_model_path() is None

    # load_saved_model を呼んでもモデルはロードされず、未ロード状態で待機すること
    res = vs.load_saved_model()
    assert res.get("loaded") is False
    assert vs.is_loaded is False
    assert not config_file.exists()


def test_vector_state_save_and_load_config(tmp_path: Path) -> None:
    """有効なモデルの選択状態が config.json に保存され、次回起動時に正しく復元・自動ロードされること"""
    vs = VectorState(data_dir=tmp_path)
    config_file = tmp_path / "config.json"

    # 疑似モデルディレクトリを作成
    test_model_dir = tmp_path / "models" / "ruri-v3-30m"
    test_model_dir.mkdir(parents=True)
    (test_model_dir / "config.json").write_text("{}", encoding="utf-8")
    vs.model_search_dirs = [tmp_path / "models"]

    # モデルを保存
    test_model_path = str(test_model_dir)
    vs.save_model_selection(test_model_path)

    # config.json が作成され正しい値が入っていること
    assert config_file.exists()
    saved_data = json.loads(config_file.read_text(encoding="utf-8"))
    assert saved_data["selected_model"] == test_model_path

    # 次回の復元で保存値が取得できること
    vs_restored = VectorState(data_dir=tmp_path)
    vs_restored.model_search_dirs = [tmp_path / "models"]
    assert vs_restored.get_saved_model_path() == test_model_path

    # load_saved_model() のモデルパス解決を検証
    resolved = vs_restored.resolve_model_path(vs_restored.get_saved_model_path())
    assert resolved == test_model_dir.resolve()


def test_vector_mock_model_never_persisted(tmp_path: Path) -> None:
    """mock_model などのテスト用ダミーモデルは config.json に保存されないこと"""
    vs = VectorState(data_dir=tmp_path)
    config_file = tmp_path / "config.json"

    # use_mock=True でロードしても config.json に mock_model は保存されない
    res = vs.load_model(use_mock=True, mock_dim=64)
    assert res["loaded"] is True
    assert vs.is_loaded is True

    # config.json は作成されないか、あるいは selected_model に mock_model が入っていないこと
    assert vs.get_saved_model_path() is None
    if config_file.exists():
        saved_data = json.loads(config_file.read_text(encoding="utf-8"))
        assert saved_data.get("selected_model") != "mock_model"


@pytest.mark.anyio
async def test_lifespan_skips_vector_model_load_when_no_saved_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """初回起動時（設定未保存時）は起動時にモデルが自動ロードされず未ロード状態で待機すること"""
    from unittest.mock import patch
    from app.main import lifespan, create_app
    from app.vector.state import vector_state
    from app.config import settings

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setattr(settings, "data_dir", data_dir)
    monkeypatch.setattr(vector_state, "data_dir", data_dir)
    monkeypatch.setattr(vector_state, "config_path", data_dir / "config.json")
    orig_embedder = vector_state.embedder
    orig_model = vector_state.model_path
    orig_searcher = vector_state.searcher

    vector_state.embedder = None
    vector_state.model_path = None
    vector_state.searcher = None

    test_app = create_app()
    try:
        with patch("app.main.initialize_schema"), \
             patch("app.main.IndexService"), \
             patch("app.main.SchedulerMonitor"), \
             patch("app.main.ChangeTrackingService"), \
             patch("app.main.LauncherManager"), \
             patch.object(vector_state, "load_saved_model") as mock_load:
            async with lifespan(test_app):
                # 設定が記録されていないため、自動ロードはスキップされる
                mock_load.assert_not_called()
                assert vector_state.is_loaded is False
    finally:
        vector_state.embedder = orig_embedder
        vector_state.model_path = orig_model
        vector_state.searcher = orig_searcher


@pytest.mark.anyio
async def test_lifespan_auto_loads_vector_model_when_saved_config_exists(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """過去に使っていたモデルが記録されている場合は起動時に自動ロードされること"""
    from unittest.mock import patch
    from app.main import lifespan, create_app
    from app.vector.state import vector_state
    from app.config import settings

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    config_file = data_dir / "config.json"
    config_file.write_text(json.dumps({"selected_model": "saved_model_v1"}), encoding="utf-8")

    monkeypatch.setattr(settings, "data_dir", data_dir)
    monkeypatch.setattr(vector_state, "data_dir", data_dir)
    monkeypatch.setattr(vector_state, "config_path", config_file)
    orig_embedder = vector_state.embedder
    orig_model = vector_state.model_path
    orig_searcher = vector_state.searcher

    vector_state.embedder = None
    vector_state.model_path = None
    vector_state.searcher = None

    test_app = create_app()
    try:
        with patch("app.main.initialize_schema"), \
             patch("app.main.IndexService"), \
             patch("app.main.SchedulerMonitor"), \
             patch("app.main.ChangeTrackingService"), \
             patch("app.main.LauncherManager"), \
             patch.object(vector_state, "load_saved_model", return_value={"loaded": True}) as mock_load:
            async with lifespan(test_app):
                # 記録があるため load_saved_model が自動的に呼び出されること
                mock_load.assert_called_once()
    finally:
        vector_state.embedder = orig_embedder
        vector_state.model_path = orig_model
        vector_state.searcher = orig_searcher
