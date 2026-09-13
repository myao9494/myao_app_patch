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

