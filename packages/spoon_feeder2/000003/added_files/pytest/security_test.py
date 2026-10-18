"""
セキュリティ関連の統合テスト (security_test.py)

仕様:
1. /api/git_diff はシェルを経由せず、読み取り専用のgitサブコマンドだけを実行する（コマンド注入の防止）。
2. ターミナルWebSocketは、別オリジンのWebページ（CSWSH）からの接続を拒否する。
3. 起動スクリプトの既定待受アドレスはローカルホスト(127.0.0.1)である。
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

os.environ.setdefault("SPOONFEEDER_CONFIGS_FILE", str(Path(__file__).parent / ".test_configs.json"))

from backend.main import app  # noqa: E402

client = TestClient(app)
GIT_AVAILABLE = shutil.which("git") is not None
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def git_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "main.py").write_text("print('a')\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q", str(repo)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "Tester"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "t@example.com"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "init"], check=True, capture_output=True)
    return repo


@pytest.mark.skipif(not GIT_AVAILABLE, reason="gitコマンドが必要です")
@pytest.mark.skipif(os.name == "nt", reason="touchコマンドを使うPOSIX専用テストです")
@pytest.mark.parametrize("suffix", ["; touch {marker}", "&& touch {marker}", "| touch {marker}", "$(touch {marker})", "`touch {marker}`"])
def test_git差分コマンドにシェル構文を混ぜても実行されない(git_repo: Path, tmp_path: Path, suffix: str):
    marker = tmp_path / "injected.txt"
    command = "git status " + suffix.format(marker=marker)
    client.post("/api/git_diff", json={"library_path": str(git_repo), "command": command})
    assert not marker.exists()


@pytest.mark.skipif(not GIT_AVAILABLE, reason="gitコマンドが必要です")
def test_git差分コマンドの出力先オプションはファイルを書かずに拒否される(git_repo: Path, tmp_path: Path):
    marker = tmp_path / "written.patch"
    (git_repo / "main.py").write_text("print('b')\n", encoding="utf-8")
    response = client.post("/api/git_diff", json={"library_path": str(git_repo), "command": f"git diff --output={marker}"})
    assert response.status_code == 400
    assert not marker.exists()


@pytest.mark.skipif(not GIT_AVAILABLE, reason="gitコマンドが必要です")
@pytest.mark.parametrize("command", ["git commit -am x", "git push", "git -c core.pager=sh log", "git checkout ."])
def test_読み取り専用以外のgitサブコマンドは拒否される(git_repo: Path, command: str):
    response = client.post("/api/git_diff", json={"library_path": str(git_repo), "command": command})
    assert response.status_code == 400


@pytest.mark.skipif(not GIT_AVAILABLE, reason="gitコマンドが必要です")
def test_引用符付きのパス指定も従来どおり使える(git_repo: Path):
    (git_repo / "main.py").write_text("print('b')\n", encoding="utf-8")
    response = client.post("/api/git_diff", json={"library_path": str(git_repo), "command": 'git diff HEAD -- "*.py"'})
    assert response.status_code == 200
    assert "+print('b')" in response.json()["diff"]


def test_別オリジンからのターミナル接続は拒否される(tmp_path: Path):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/api/terminal/ws?cwd={tmp_path}", headers={"origin": "http://evil.example"}) as ws:
            ws.receive_json()


@pytest.mark.skipif(os.name == "nt", reason="POSIX PTYで確認するテストです")
@pytest.mark.parametrize("origin", ["http://localhost:8077", "http://127.0.0.1:8077", None])
def test_ローカルオリジンまたはOriginなしのターミナル接続は許可される(tmp_path: Path, origin: str | None):
    headers = {"origin": origin} if origin else {}
    with client.websocket_connect(f"/api/terminal/ws?cwd={tmp_path}", headers=headers) as ws:
        assert ws.receive_json()["type"] == "ready"


@pytest.mark.parametrize("script", ["start.sh", "start.bat"])
def test_起動スクリプトの既定待受アドレスはローカルホスト(script: str):
    text = (ROOT / script).read_text(encoding="utf-8")
    assert "127.0.0.1" in text
    assert "0.0.0.0" not in text


# ---- DNSリバインディング対策(Hostヘッダー検証) -----------------------------

@pytest.mark.parametrize("host", ["localhost:8077", "127.0.0.1:8077", "[::1]:8077", "localhost"])
def test_ローカルホストのHostヘッダーのAPI呼び出しは許可される(host: str):
    assert client.get("/api/health", headers={"host": host}).status_code == 200


@pytest.mark.parametrize("host", ["attacker.example:8077", "evil.example", "127.0.0.1.evil.example"])
def test_ローカルホスト以外のHostヘッダーのAPI呼び出しは拒否される(host: str):
    assert client.get("/api/health", headers={"host": host}).status_code == 403


def test_リバインディングされたHostでは変更系APIも実行されない(tmp_path: Path):
    response = client.post("/api/test", headers={"host": "attacker.example:8077"}, json={"library_path": str(tmp_path), "test_command": "touch pwned"})
    assert response.status_code == 403
    assert not (tmp_path / "pwned").exists()


def test_別Hostのままターミナルへ接続しても拒否される(tmp_path: Path):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/api/terminal/ws?cwd={tmp_path}", headers={"host": "attacker.example:8077"}) as ws:
            ws.receive_json()


def test_SPOONFEEDER_ALLOWED_HOSTSに列挙したHostは許可される(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SPOONFEEDER_ALLOWED_HOSTS", "testserver, dev.example")
    assert client.get("/api/health", headers={"host": "dev.example:8077"}).status_code == 200


def test_LAN公開を明示した場合は任意のHostを許可する(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SPOONFEEDER_HOST", "0.0.0.0")
    assert client.get("/api/health", headers={"host": "192.168.0.5:8077"}).status_code == 200
