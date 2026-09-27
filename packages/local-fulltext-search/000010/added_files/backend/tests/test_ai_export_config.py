"""
AIインプット保存先フォルダ設定のサーバー永続化およびAPI仕様の単体テスト。

仕様:
- GET /api/export/config: 保存されているフォルダパスを取得（未設定時はデフォルト ~/Desktop/AI_Inputs）。
- POST /api/export/config: フォルダパスを backend/data/ai_export_folder.txt に永続保存。
- target_dir が空の POST /api/export/ai-bundle/save は、保存された設定フォルダを使用する。
- folder_path が空の POST /api/export/open-folder は、保存された設定フォルダを使用する。
"""

import os
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.config import settings


@pytest.fixture
def isolated_ai_export_config(tmp_path, monkeypatch):
    """テスト用に設定ファイルパスを一時ディレクトリに隔離するフィクスチャ"""
    temp_folder_file = tmp_path / "ai_export_folder.txt"
    temp_count_file = tmp_path / "ai_default_select_count.txt"
    monkeypatch.setattr(settings, "ai_export_folder_name", "ai_export_folder.txt")
    monkeypatch.setattr(settings, "ai_default_select_count_name", "ai_default_select_count.txt")
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    return {
        "folder_file": temp_folder_file,
        "count_file": temp_count_file,
        "data_dir": tmp_path,
    }


def test_get_export_config_default(isolated_ai_export_config):
    """設定ファイルが存在しない初期状態では既定値（フォルダ: ~/Desktop/AI_Inputs, 選択数: 10）が返ること"""
    client = TestClient(app)
    resp = client.get("/api/export/config")
    assert resp.status_code == 200
    data = resp.json()
    assert data["export_folder"] == "~/Desktop/AI_Inputs"
    assert data["default_select_count"] == 10


def test_save_export_config_and_get(isolated_ai_export_config):
    """フォルダパスを保存でき、次回取得時に正しく復元されること"""
    client = TestClient(app)
    custom_dir = str(isolated_ai_export_config["data_dir"] / "Custom_AI_Dir")

    # 1. 保存
    post_resp = client.post("/api/export/config", json={"export_folder": custom_dir})
    assert post_resp.status_code == 200
    post_data = post_resp.json()
    assert post_data["success"] is True
    assert post_data["export_folder"] == custom_dir

    # 2. ファイルに永続化されていること
    folder_file = isolated_ai_export_config["folder_file"]
    assert folder_file.exists()
    assert folder_file.read_text(encoding="utf-8").strip() == custom_dir

    # 3. GETで取得できること
    get_resp = client.get("/api/export/config")
    assert get_resp.status_code == 200
    assert get_resp.json()["export_folder"] == custom_dir


def test_save_and_get_default_select_count(isolated_ai_export_config):
    """デフォルト選択数を保存でき、ファイル永続化および次回GETで復元されること"""
    client = TestClient(app)

    # 1. デフォルト選択数を 15 に更新
    post_resp = client.post("/api/export/config", json={"default_select_count": 15})
    assert post_resp.status_code == 200
    post_data = post_resp.json()
    assert post_data["success"] is True
    assert post_data["default_select_count"] == 15

    # 2. ファイルに永続化されていること
    count_file = isolated_ai_export_config["count_file"]
    assert count_file.exists()
    assert count_file.read_text(encoding="utf-8").strip() == "15"

    # 3. GETで取得できること
    get_resp = client.get("/api/export/config")
    assert get_resp.status_code == 200
    assert get_resp.json()["default_select_count"] == 15


def test_save_both_export_folder_and_select_count(isolated_ai_export_config):
    """フォルダと選択数を同時に保存できること"""
    client = TestClient(app)
    custom_dir = str(isolated_ai_export_config["data_dir"] / "MyAI")

    post_resp = client.post("/api/export/config", json={
        "export_folder": custom_dir,
        "default_select_count": 25,
    })
    assert post_resp.status_code == 200
    data = post_resp.json()
    assert data["success"] is True
    assert data["export_folder"] == custom_dir
    assert data["default_select_count"] == 25

    get_resp = client.get("/api/export/config")
    assert get_resp.status_code == 200
    assert get_resp.json()["export_folder"] == custom_dir
    assert get_resp.json()["default_select_count"] == 25


def test_save_bundle_uses_saved_config_when_empty(isolated_ai_export_config, tmp_path):
    """target_dir が空の場合、サーバー永続化された保存先フォルダが自動適用されること"""
    client = TestClient(app)
    target_dir = tmp_path / "Persisted_AI_Target"
    target_dir.mkdir(parents=True, exist_ok=True)

    # 設定を保存
    client.post("/api/export/config", json={"export_folder": str(target_dir)})

    # テスト用mdファイル作成
    note_file = tmp_path / "sample_note.md"
    note_file.write_text("# テストノート\n本文です", encoding="utf-8")

    # target_dir を空で save
    save_resp = client.post(
        "/api/export/ai-bundle/save",
        json={
            "file_paths": [str(note_file)],
            "vault_path": str(tmp_path),
            "file_base_name": "TestOutput",
            "target_dir": "",
        },
    )
    assert save_resp.status_code == 200
    save_data = save_resp.json()
    assert save_data["success"] is True
    assert save_data["folder_path"] == str(target_dir.resolve())
    assert (target_dir / "TestOutput_context.md").exists()

