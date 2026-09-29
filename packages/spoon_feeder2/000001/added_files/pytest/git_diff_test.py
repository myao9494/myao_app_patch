"""
Git差分取得APIのテスト (git_diff_test.py)

仕様:
1. 指定されたGitリポジトリ内でGit diffコマンドを実行し、差分出力を取得する。
2. コマンド未指定時はデフォルトで 'git diff HEAD -- *.py' を実行し、Pythonファイルの差分のみを抽出する。
3. ユーザーが指定した任意のGitコマンド（例: 'git diff HEAD' など）を実行できる。
4. Gitリポジトリでないディレクトリが指定された場合はHTTP 400エラーを返却する。
5. 'git' で始まらない不正なコマンドが指定された場合はセキュリティのためHTTP 400エラーで拒否する。
6. 差分が存在しない場合は空文字と成功ステータスを返却する。
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SPOONFEEDER_CONFIGS_FILE", str(Path(__file__).parent / ".test_configs.json"))

from backend.main import app  # noqa: E402

client = TestClient(app)
GIT_AVAILABLE = shutil.which("git") is not None


@pytest.fixture
def git_repo(tmp_path: Path) -> Path:
    """テスト用のGitリポジトリを作成し、コミット済みファイルと変更ファイルを用意する。"""
    (tmp_path / "main.py").write_text("def hello():\n    print('hello')\n", encoding="utf-8")
    (tmp_path / "readme.txt").write_text("readme content\n", encoding="utf-8")
    if GIT_AVAILABLE:
        subprocess.run(["git", "init", str(tmp_path)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(tmp_path), "config", "user.name", "Tester"], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(tmp_path), "config", "user.email", "tester@example.com"], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(tmp_path), "add", "main.py", "readme.txt"], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(tmp_path), "commit", "-m", "Initial commit"], check=True, capture_output=True)
    return tmp_path


@pytest.mark.skipif(not GIT_AVAILABLE, reason="Git差分テストにはgitコマンドが必要です")
def test_デフォルトコマンドでPythonファイルの差分のみを取得できる(git_repo: Path):
    (git_repo / "main.py").write_text("def hello():\n    print('hello world!')\n", encoding="utf-8")
    (git_repo / "readme.txt").write_text("updated readme\n", encoding="utf-8")

    response = client.post("/api/git_diff", json={"library_path": str(git_repo)})
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "success"
    assert "main.py" in data["diff"]
    assert "readme.txt" not in data["diff"]
    assert "+    print('hello world!')" in data["diff"]


@pytest.mark.skipif(not GIT_AVAILABLE, reason="Git差分テストにはgitコマンドが必要です")
def test_カスタムコマンドで指定した差分を取得できる(git_repo: Path):
    (git_repo / "main.py").write_text("def hello():\n    print('hello world!')\n", encoding="utf-8")
    (git_repo / "readme.txt").write_text("updated readme\n", encoding="utf-8")

    response = client.post("/api/git_diff", json={
        "library_path": str(git_repo),
        "command": "git diff HEAD -- *.txt"
    })
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "success"
    assert "readme.txt" in data["diff"]
    assert "main.py" not in data["diff"]


@pytest.mark.skipif(not GIT_AVAILABLE, reason="Git差分テストにはgitコマンドが必要です")
def test_差分がない場合は空文字列を返す(git_repo: Path):
    response = client.post("/api/git_diff", json={"library_path": str(git_repo)})
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "success"
    assert data["diff"] == ""


def test_非Gitリポジトリの場合は400エラーを返す(tmp_path: Path):
    response = client.post("/api/git_diff", json={"library_path": str(tmp_path)})
    assert response.status_code == 400
    assert "Gitリポジトリ" in response.json()["detail"]


def test_git以外のコマンドは拒否される(git_repo: Path):
    response = client.post("/api/git_diff", json={
        "library_path": str(git_repo),
        "command": "echo malicious"
    })
    assert response.status_code == 400
    assert "git" in response.json()["detail"]
