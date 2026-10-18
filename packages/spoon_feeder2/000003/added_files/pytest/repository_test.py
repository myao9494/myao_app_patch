"""実ファイルと実Gitを使うリポジトリAPI統合テスト。"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SPOONFEEDER_CONFIGS_FILE", str(Path(__file__).parent / ".test_configs.json"))

from backend.main import app  # noqa: E402


client = TestClient(app)
GIT_AVAILABLE = shutil.which("git") is not None


@pytest.fixture
def repository(tmp_path: Path) -> Path:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("def greet(name):\n    return f'Hello {name}'\n", encoding="utf-8")
    (tmp_path / "Program.cs").write_text("namespace Demo;\npublic class Program { public static void Run() { } }\n", encoding="utf-8")
    (tmp_path / ".gitignore").write_text("ignored/\n", encoding="utf-8")
    (tmp_path / "ignored").mkdir()
    (tmp_path / "ignored" / "secret.py").write_text("SECRET = True\n", encoding="utf-8")
    if GIT_AVAILABLE:
        subprocess.run(["git", "init", str(tmp_path)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(tmp_path), "add", ".gitignore", "src/main.py", "Program.cs"], check=True, capture_output=True)
    return tmp_path


@pytest.mark.skipif(not GIT_AVAILABLE, reason="Gitのignore統合確認にはgitコマンドが必要です")
def test_ignoredディレクトリ内部を走査しない(repository: Path):
    response = client.post("/api/repository_structure", json={"library_path": str(repository), "show_ignored": True})
    assert "secret.py" not in response.text


@pytest.mark.skipif(not GIT_AVAILABLE, reason="Gitのignore統合確認にはgitコマンドが必要です")
def test_ignoredディレクトリの入口を表示できる(repository: Path):
    response = client.post("/api/repository_structure", json={"library_path": str(repository), "show_ignored": True})
    assert '"name":"ignored"' in response.text and '"ignored":true' in response.text


@pytest.mark.skipif(not GIT_AVAILABLE, reason="Git管理ファイルのコンテキスト確認にはgitコマンドが必要です")
def test_コンテキストにリポジトリ構造を含める(repository: Path):
    response = client.post("/api/repository_context", json={"library_path": str(repository), "selected_files": ["src/main.py"]})
    assert "<repository_structure>" in response.json()["context"]


@pytest.mark.skipif(not GIT_AVAILABLE, reason="Git管理ファイルのコンテキスト確認にはgitコマンドが必要です")
def test_コンテキストからignoredファイルを除外する(repository: Path):
    response = client.post("/api/repository_context", json={"library_path": str(repository), "selected_files": ["ignored/secret.py"]})
    assert response.json()["file_count"] == 0


@pytest.mark.skipif(not GIT_AVAILABLE, reason="Git管理リポジトリの解析確認にはgitコマンドが必要です")
def test_PythonとCSharpを依存関係マップへ掲載する(repository: Path):
    response = client.post("/api/dependency_map", json={"library_path": str(repository)})
    file_nodes = {node["id"] for node in response.json()["nodes"] if node["type"] == "file"}
    assert {"src/main.py", "Program.cs"}.issubset(file_nodes)


@pytest.mark.skipif(os.name == "nt", reason="POSIX用venv自動検出テストです")
def test_テスト実行は対象リポジトリのvenvを優先する(tmp_path: Path):
    (tmp_path / ".venv" / "bin").mkdir(parents=True)
    python_wrapper = tmp_path / ".venv" / "bin" / "python"
    python_wrapper.write_text(f"#!/bin/sh\nexec {sys.executable!r} \"$@\"\n", encoding="utf-8")
    python_wrapper.chmod(0o755)
    (tmp_path / "test_smoke.py").write_text("def test_smoke():\n    assert True\n", encoding="utf-8")
    response = client.post("/api/test", json={"library_path": str(tmp_path), "test_command": "python -m pytest -q"})
    assert response.json()["status"] == "success"


def test_リポジトリ履歴削除API(repository: Path):
    # まずリポジトリを読み込んで登録させる
    client.post("/api/repository_structure", json={"library_path": str(repository)})
    repos_before = client.get("/api/repositories").json()["repositories"]
    assert str(repository) in repos_before

    # 履歴から削除
    del_resp = client.post("/api/remove_repository", json={"library_path": str(repository)})
    assert del_resp.status_code == 200
    assert del_resp.json()["status"] == "success"

    # 削除されていることを確認
    repos_after = client.get("/api/repositories").json()["repositories"]
    assert str(repository) not in repos_after


def test_壊れた設定ファイルは退避され履歴が上書き消失しない(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    settings_file = tmp_path / "broken_configs.json"
    broken = '{"repositories": {"/keep/me": {"selected_files": ["a.py"]}}, '  # 途中で切れたJSON
    settings_file.write_text(broken, encoding="utf-8")
    monkeypatch.setenv("SPOONFEEDER_CONFIGS_FILE", str(settings_file))
    repo = tmp_path / "repo"
    repo.mkdir()
    client.post("/api/save_settings", json={"library_path": str(repo), "selected_files": []})
    backups = list(tmp_path.glob("broken_configs.json.corrupt*"))
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8") == broken


@pytest.mark.skipif(os.name == "nt", reason="POSIXのsleepとプロセスグループで確認するテストです")
def test_テスト実行は孫プロセスが残ってもタイムアウトで戻る(tmp_path: Path):
    import time

    started = time.monotonic()
    response = client.post("/api/test", json={
        "library_path": str(tmp_path), "test_command": "sleep 20 & sleep 20", "timeout_sec": 1,
    })
    assert time.monotonic() - started < 8
    assert response.json()["status"] == "failed"
