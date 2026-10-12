"""
フォルダ履歴APIのテスト
- 保存・読み込みの往復、旧形式（文字列リスト）の変換、壊れたデータへの耐性
- 保存先が起動時のカレントディレクトリに依存しないこと
"""
import json

import pytest

from app.routers import history


@pytest.fixture
def history_file(tmp_path, monkeypatch):
    path = tmp_path / "folder_history.json"
    monkeypatch.setattr(history, "HISTORY_FILE", path)
    return path


def test_save_and_load_roundtrip(client, history_file):
    payload = {"history": [{"path": "/a", "count": 3, "timestamp": 1.5}]}

    assert client.post("/api/history", json=payload).json() == {"status": "success"}

    assert client.get("/api/history").json() == [{"path": "/a", "count": 3, "timestamp": 1.5}]
    assert sorted(p.name for p in history_file.parent.iterdir()) == ["folder_history.json"]


def test_converts_legacy_string_list(client, history_file):
    history_file.write_text(json.dumps(["/a", "/b"]), encoding="utf-8")

    data = client.get("/api/history").json()

    assert [item["path"] for item in data] == ["/a", "/b"]
    assert all(item["count"] == 1 for item in data)


def test_skips_broken_entries_and_files(client, history_file):
    history_file.write_text(json.dumps([{"path": "/ok"}, {"count": "x"}, 5]), encoding="utf-8")
    assert [item["path"] for item in client.get("/api/history").json()] == ["/ok"]

    history_file.write_text("{broken", encoding="utf-8")
    assert client.get("/api/history").json() == []


def test_history_file_is_next_to_backend_package():
    assert history.HISTORY_FILE.parent.name == "backend"
