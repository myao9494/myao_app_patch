"""
ベクトルグローバル状態（VectorState）の単体テスト。
モデルロード（Mock含む）、Searcher初期化、自動連動インデックスを検証する。
"""

from pathlib import Path
import pytest
from app.vector.state import VectorState


def test_vector_state_mock_load(tmp_path: Path) -> None:
    """MockEmbedder のロードと検索エンジン初期化が正しく行われること"""
    state = VectorState(data_dir=tmp_path)
    assert not state.is_loaded

    info = state.load_model(use_mock=True, mock_dim=128)
    assert state.is_loaded
    assert info["dim"] == 128
    assert info["is_mock"] is True
    assert state.get_searcher() is not None


def test_vector_state_sync_index(tmp_path: Path) -> None:
    """ターゲットフォルダに対するインデックス同期が正常に実行されること"""
    folder = tmp_path / "sync_folder"
    folder.mkdir()
    (folder / "file1.txt").write_text("テキスト1", encoding="utf-8")

    state = VectorState(data_dir=tmp_path)
    state.load_model(use_mock=True, mock_dim=64)

    res = state.sync_index(target_folders=[str(folder)], force=False)
    assert res is not None
    assert res.total_files == 1
    assert res.new_count == 1


def test_vector_state_sync_index_respects_app_settings_excluded_extensions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """
    VectorState.sync_index が app_settings の index_selected_extensions から除外された拡張子（.json）をスキップすること
    """
    from app.config import settings
    from app.services.index_service import IndexService
    from app.db.schema import initialize_schema
    import sqlite3

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setattr(settings, "data_dir", data_dir)

    conn = sqlite3.connect(data_dir / "index.db")
    conn.row_factory = sqlite3.Row
    initialize_schema(conn)

    svc = IndexService(connection=conn)
    # .json を除外
    svc.update_app_settings(index_selected_extensions=".md\n.txt")

    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "note.md").write_text("# ノート\n本文です", encoding="utf-8")
    (folder / "data.json").write_text('{"key": "value"}', encoding="utf-8")

    state = VectorState(data_dir=data_dir)
    state.load_model(use_mock=True, mock_dim=64)

    res = state.sync_index(target_folders=[str(folder)], force=True)
    assert res is not None
    # .json は除外されるため、note.md の1件のみが対象
    assert res.total_files == 1


def test_resolve_model_path(tmp_path: Path) -> None:
    """
    models/ または backend/models/ の配置、および異OS絶対パスからの自動解決を検証する
    """
    state = VectorState(data_dir=tmp_path)

    # 1. models/配下に擬似モデル作成
    root_models = tmp_path / "models" / "ruri-v3-30m"
    root_models.mkdir(parents=True)
    (root_models / "config.json").write_text("{}", encoding="utf-8")

    # 2. backend/models/配下に擬似モデル作成
    backend_models = tmp_path / "backend" / "models" / "ruri-v3-310m"
    backend_models.mkdir(parents=True)
    (backend_models / "config.json").write_text("{}", encoding="utf-8")

    # state の探索ルートを一時的に変更
    state.model_search_dirs = [tmp_path / "models", tmp_path / "backend" / "models"]

    # 名前指定で models/ 配下を解決
    resolved_30m = state.resolve_model_path("ruri-v3-30m")
    assert resolved_30m == root_models

    # 名前指定で backend/models/ 配下を解決
    resolved_310m = state.resolve_model_path("ruri-v3-310m")
    assert resolved_310m == backend_models

    # 他OS（Macや別マシン）の絶対パスが渡された場合でも名前から解決
    other_os_path = "/Users/otheruser/some/path/models/ruri-v3-30m"
    resolved_from_mac_path = state.resolve_model_path(other_os_path)
    assert resolved_from_mac_path == root_models

    # 未指定（None）の場合、存在するモデルが優先的に自動検出されること
    resolved_auto = state.resolve_model_path(None)
    assert resolved_auto in (root_models, backend_models)


def test_load_saved_model_safe_when_no_models_exist(tmp_path: Path) -> None:
    """
    モデルが存在しない場合でも、load_saved_model がクラッシュせず安全に未ロード状態で終了すること
    """
    empty_dir = tmp_path / "empty_models"
    empty_dir.mkdir()
    state = VectorState(data_dir=tmp_path)
    state.model_search_dirs = [empty_dir]

    # クラッシュせず安全に終了すること
    res = state.load_saved_model()
    assert res.get("loaded") is False
    assert not state.is_loaded


