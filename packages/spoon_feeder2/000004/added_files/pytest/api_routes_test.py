"""ignore / references / tools / repositories ルーターのAPI統合テスト。"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)
GIT_AVAILABLE = shutil.which("git") is not None


# ---- 無視リスト -----------------------------------------------------------

def test_無視リストは正規化と重複排除をして保存し取得できる(tmp_path: Path):
    saved = client.post("/api/save_ignore_patterns", json={"library_path": str(tmp_path), "patterns": ["/logs\\", "logs", " !keep/ ", "", "*.tmp"]}).json()
    assert saved["patterns"] == ["logs", "!keep", "*.tmp"]
    loaded = client.post("/api/ignore_patterns", json={"library_path": str(tmp_path)}).json()
    assert loaded["patterns"] == ["logs", "!keep", "*.tmp"]
    assert loaded["config_file"] == ".spoonfeeder.json"


def test_無視リストから登録済みパスを削除できる(tmp_path: Path):
    client.post("/api/save_ignore_patterns", json={"library_path": str(tmp_path), "patterns": ["logs", "data"]})
    removed = client.post("/api/remove_ignore_pattern", json={"library_path": str(tmp_path), "path": "logs"}).json()
    assert (removed["status"], removed["patterns"]) == ("success", ["data"])


def test_無視リストにないパスの削除は変更なしを返す(tmp_path: Path):
    client.post("/api/save_ignore_patterns", json={"library_path": str(tmp_path), "patterns": ["data"]})
    result = client.post("/api/remove_ignore_pattern", json={"library_path": str(tmp_path), "path": "other"}).json()
    assert (result["status"], result["patterns"]) == ("unchanged", ["data"])


def test_無視リストの削除対象が空なら400を返す(tmp_path: Path):
    assert client.post("/api/remove_ignore_pattern", json={"library_path": str(tmp_path), "path": "/"}).status_code == 400


# ---- 参照リポジトリの手動対応付け -----------------------------------------

def test_参照リポジトリの手動対応付けを保存し取得し削除できる(tmp_path: Path):
    main, lib = tmp_path / "main", tmp_path / "lib"
    main.mkdir(), lib.mkdir()
    body = {"library_path": str(main), "module": "mylib", "repository_path": str(lib)}
    assert client.post("/api/save_reference_mapping", json=body).json()["status"] == "success"
    found = client.post("/api/reference_modules", json={"library_path": str(main)}).json()
    assert found["manual_references"] == {"mylib": str(lib.resolve())}
    client.post("/api/remove_reference_mapping", json=body)
    assert client.post("/api/reference_modules", json={"library_path": str(main)}).json()["manual_references"] == {}


def test_メインリポジトリ自身や空のモジュール名は対応付けできない(tmp_path: Path):
    main = tmp_path / "main"
    main.mkdir()
    same = {"library_path": str(main), "module": "m", "repository_path": str(main)}
    blank = {"library_path": str(main), "module": " ", "repository_path": str(tmp_path)}
    assert client.post("/api/save_reference_mapping", json=same).status_code == 400
    assert client.post("/api/save_reference_mapping", json=blank).status_code == 400


def test_Embeddedモードでは参照リポジトリ機能は無効を返す(tmp_path: Path):
    result = client.post("/api/reference_modules", json={"library_path": str(tmp_path), "python_mode": "embedded"}).json()
    assert result["enabled"] is False


# ---- テスト実行・フィードバック・Git --------------------------------------

def _python_command(code: str) -> str:
    return f'"{sys.executable}" -c "{code}"'


def test_テスト実行は成功と失敗の終了コードを返す(tmp_path: Path):
    ok = client.post("/api/test", json={"library_path": str(tmp_path), "test_command": _python_command("print(1)")}).json()
    ng = client.post("/api/test", json={"library_path": str(tmp_path), "test_command": _python_command("raise SystemExit(2)")}).json()
    assert (ok["status"], ok["exit_code"]) == ("success", 0)
    assert (ng["status"], ng["exit_code"]) == ("failed", 2)


def test_テスト実行は対象リポジトリを作業ディレクトリにする(tmp_path: Path):
    result = client.post("/api/test", json={"library_path": str(tmp_path), "test_command": _python_command("import os; print(os.getcwd())")}).json()
    assert Path(result["stdout"].strip()).resolve() == tmp_path.resolve()


def test_テスト結果フィードバックはCDATA終端を安全にエスケープする(tmp_path: Path):
    body = {"library_path": str(tmp_path), "test_command": "pytest <x>", "output": "fail ]]> end", "exit_code": 1}
    context = client.post("/api/feedback_context", json=body).json()["context"]
    assert "pytest &lt;x&gt;" in context
    assert "fail ]]]]><![CDATA[> end" in context
    assert "<exit_code>1</exit_code>" in context


@pytest.mark.skipif(not GIT_AVAILABLE, reason="gitコマンドが必要です")
def test_git_initで初期化し二度目は既存と返す(tmp_path: Path):
    first = client.post("/api/git_init", json={"library_path": str(tmp_path)}).json()
    second = client.post("/api/git_init", json={"library_path": str(tmp_path)}).json()
    assert first["status"] == "success" and (tmp_path / ".git").is_dir()
    assert "すでに" in second["message"]


def test_存在しないフォルダは400を返す(tmp_path: Path):
    assert client.post("/api/git_diff", json={"library_path": str(tmp_path / "none")}).status_code == 400
    assert client.post("/api/test", json={"library_path": str(tmp_path / "none")}).status_code == 400


def test_コンテキスト保存は指定フォルダにリポジトリ名_context_txtを書き出す(tmp_path: Path):
    repo = tmp_path / "my_repo"
    repo.mkdir()
    out = tmp_path / "out" / "nested"
    data = client.post("/api/save_context", json={"library_path": str(repo), "context": "<file>日本語</file>", "target_dir": str(out)}).json()
    assert data["file_name"] == "my_repo_context.txt"
    assert (out / "my_repo_context.txt").read_text(encoding="utf-8") == "<file>日本語</file>"


def test_コンテキスト保存は保存先未指定ならMkDocsと共通の保存先設定を使う(tmp_path: Path):
    repo = tmp_path / "my_repo"
    repo.mkdir()
    out = tmp_path / "shared"
    client.post("/api/mkdocs/export_config", json={"export_folder": str(out)})
    client.post("/api/save_context", json={"library_path": str(repo), "context": "x"})
    assert (out / "my_repo_context.txt").read_text(encoding="utf-8") == "x"


def test_コンテキスト保存は存在しないリポジトリなら400を返す(tmp_path: Path):
    response = client.post("/api/save_context", json={"library_path": str(tmp_path / "none"), "context": "x", "target_dir": str(tmp_path)})
    assert response.status_code == 400


# ---- リポジトリ -----------------------------------------------------------

def test_リポジトリ履歴から削除すると一覧に出なくなる(tmp_path: Path):
    repo = tmp_path / "repo"
    repo.mkdir()
    client.post("/api/repository_structure", json={"library_path": str(repo)})
    assert str(repo.resolve()) in client.get("/api/repositories").json()["repositories"]
    client.post("/api/remove_repository", json={"library_path": str(repo)})
    assert str(repo.resolve()) not in client.get("/api/repositories").json()["repositories"]


def test_ファイルプレビューはリポジトリ外のパスを拒否する(tmp_path: Path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (tmp_path / "secret.txt").write_text("secret", encoding="utf-8")
    response = client.post("/api/file_content", json={"library_path": str(repo), "file_path": "../secret.txt"})
    assert response.status_code == 400


def test_ファイルプレビューは内容とサイズを返す(tmp_path: Path):
    (tmp_path / "a.py").write_text("x = 1\n", encoding="utf-8")
    result = client.post("/api/file_content", json={"library_path": str(tmp_path), "file_path": "a.py"}).json()
    assert (result["content"], result["size"]) == ("x = 1\n", 6)


def test_コンテキスト生成後に選択ファイルが履歴へ保存される(tmp_path: Path):
    (tmp_path / "a.py").write_text("x = 1\n", encoding="utf-8")
    (tmp_path / "b.py").write_text("y = 2\n", encoding="utf-8")
    result = client.post("/api/repository_context", json={"library_path": str(tmp_path), "selected_files": ["a.py"]}).json()
    assert result["file_count"] == 1 and "y = 2" not in result["context"]
    structure = client.post("/api/repository_structure", json={"library_path": str(tmp_path)}).json()
    assert structure["selected_files"] == ["a.py"]
