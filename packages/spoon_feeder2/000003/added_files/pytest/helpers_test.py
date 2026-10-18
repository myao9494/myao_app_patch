"""pyenv / runner / settings_store / security の統合テスト（実ファイル・実プロセスを使用）。"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from backend.pyenv import executable_dir_name, executable_name, find_embedded_python, find_venv_python
from backend.runner import resolve_test_command, run_shell_command
from backend.security import UnsafeCommandError, is_allowed_websocket_origin, parse_git_command
from backend.settings_store import load_settings, manual_references, settings_transaction


def _fake_python(base: Path) -> Path:
    target = base / executable_dir_name() / executable_name()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("", encoding="utf-8")
    return target


# ---- pyenv ----------------------------------------------------------------

def test_仮想環境は_venv_venv_envの順に検出する(tmp_path: Path):
    env_python = _fake_python(tmp_path / "env")
    assert find_venv_python(tmp_path) == env_python
    venv_python = _fake_python(tmp_path / "venv")
    assert find_venv_python(tmp_path) == venv_python
    dot_venv_python = _fake_python(tmp_path / ".venv")
    assert find_venv_python(tmp_path) == dot_venv_python


def test_仮想環境がなければNoneを返す(tmp_path: Path):
    assert find_venv_python(tmp_path) is None


def test_EmbeddedPythonは直下を優先し無ければ1階層下のpythonを検出する(tmp_path: Path):
    direct = tmp_path / "embedded" / executable_name()
    direct.parent.mkdir()
    direct.write_text("", encoding="utf-8")
    assert find_embedded_python(tmp_path / "embedded") == direct
    nested = tmp_path / "embedded2" / "python312" / executable_name()
    nested.parent.mkdir(parents=True)
    nested.write_text("", encoding="utf-8")
    assert find_embedded_python(tmp_path / "embedded2") == nested
    assert find_embedded_python(tmp_path / "missing") is None


# ---- runner ---------------------------------------------------------------

def test_テストコマンドは仮想環境のPythonへ書き換えられる(tmp_path: Path):
    python = _fake_python(tmp_path / ".venv")
    assert resolve_test_command(tmp_path, "python -m pytest -q") == f'"{python}" -m pytest -q'
    assert resolve_test_command(tmp_path, "python3") == f'"{python}"'
    assert resolve_test_command(tmp_path, "pytest -x") == f'"{python}" -m pytest -x'


def test_python以外のコマンドや仮想環境なしでは書き換えない(tmp_path: Path):
    assert resolve_test_command(tmp_path, "python -m pytest") == "python -m pytest"
    _fake_python(tmp_path / ".venv")
    assert resolve_test_command(tmp_path, "npm test") == "npm test"
    assert resolve_test_command(tmp_path, "pythonw -m x") == "pythonw -m x"


def test_Embeddedモードでは指定ディレクトリのPythonを使う(tmp_path: Path):
    embedded = tmp_path / "embedded"
    python = embedded / executable_name()
    python.parent.mkdir()
    python.write_text("", encoding="utf-8")
    _fake_python(tmp_path / ".venv")
    assert resolve_test_command(tmp_path, "python -V", mode="embedded", embedded_python_dir=str(embedded)) == f'"{python}" -V'


def test_コマンドの終了コードと出力を取得できる(tmp_path: Path):
    import sys

    code, out, err = run_shell_command(f'"{sys.executable}" -c "import sys; print(\'out\'); sys.stderr.write(\'err\'); sys.exit(3)"', tmp_path, os.environ.copy(), 30)
    assert (code, out.strip(), err.strip()) == (3, b"out", b"err")


# ---- settings_store -------------------------------------------------------

def test_設定トランザクションは正常終了時だけ保存する(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    settings_file = tmp_path / "configs.json"
    monkeypatch.setenv("SPOONFEEDER_CONFIGS_FILE", str(settings_file))
    with settings_transaction() as settings:
        settings["ui"] = {"flag": True}
    assert json.loads(settings_file.read_text(encoding="utf-8"))["ui"] == {"flag": True}
    with pytest.raises(RuntimeError):
        with settings_transaction() as settings:
            settings["ui"] = {"flag": False}
            raise RuntimeError("途中で失敗")
    assert json.loads(settings_file.read_text(encoding="utf-8"))["ui"] == {"flag": True}


def test_存在しない設定ファイルは空の設定として読める(tmp_path: Path):
    assert load_settings(tmp_path / "none.json")["repositories"] == {}


def test_手動参照設定は空要素と不正な型を除いて取得する(tmp_path: Path):
    settings = {"repositories": {str(tmp_path): {"manual_references": {"lib": "/x/lib", "": "/y", "empty": " "}}}}
    assert manual_references(settings, tmp_path) == {"lib": "/x/lib"}
    assert manual_references({"repositories": {str(tmp_path): {"manual_references": []}}}, tmp_path) == {}


# ---- security -------------------------------------------------------------

def test_Gitコマンドは引数リストへ変換され引用符も解釈される():
    assert parse_git_command('git diff HEAD -- "*.py"') == ["git", "diff", "--no-ext-diff", "HEAD", "--", "*.py"]
    assert parse_git_command("")[:2] == ["git", "diff"]
    assert parse_git_command("git status")[:2] == ["git", "status"]


@pytest.mark.parametrize("command", ["ls -la", "git", "git push", "git diff --output=x", "git 'unterminated", "echo git diff"])
def test_許可されないGitコマンドは拒否される(command: str):
    with pytest.raises(UnsafeCommandError):
        parse_git_command(command)


def test_パス指定以降のオプション風文字列は拒否しない():
    assert parse_git_command("git log -- --output")[-1] == "--output"


def test_WebSocketのOrigin判定_ローカルホストとOriginなしは許可し他は拒否する(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("SPOONFEEDER_HOST", raising=False)
    monkeypatch.delenv("SPOONFEEDER_ALLOWED_ORIGINS", raising=False)
    assert is_allowed_websocket_origin(None, "localhost:8077")
    assert is_allowed_websocket_origin("http://localhost:8077", "localhost:8077")
    assert is_allowed_websocket_origin("http://[::1]:8077", "[::1]:8077")
    assert not is_allowed_websocket_origin("http://192.168.0.5:8077", "192.168.0.5:8077")
    assert not is_allowed_websocket_origin("not a url", "localhost")


def test_WebSocketのOrigin判定_LAN公開時は同一Hostと明示許可Originだけ許可する(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SPOONFEEDER_HOST", "0.0.0.0")
    monkeypatch.setenv("SPOONFEEDER_ALLOWED_ORIGINS", "http://dev.example:3000/")
    assert is_allowed_websocket_origin("http://192.168.0.5:8077", "192.168.0.5:8077")
    assert not is_allowed_websocket_origin("http://evil.example", "192.168.0.5:8077")
    assert is_allowed_websocket_origin("http://dev.example:3000", "192.168.0.5:8077")
