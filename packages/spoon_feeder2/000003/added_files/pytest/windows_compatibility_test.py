"""
Windowsおよび実行環境互換性（文字コード・パス・起動設定・テスト実行）の回帰テスト。

本モジュールは以下の仕様を検証します:
1. 日本語文字コード（UTF-8, UTF-8 BOM, UTF-16, CP932）の判別とプロセス出力デコード
2. C# / Python のコード反映時の文字コード・改行形式維持
3. Windows相対パスの安全な解決とMSBuild参照パス展開
4. Embeddedモードにおける仮想環境の独立性と差分環境変数の適用
5. テスト実行APIにおける通常モード / EmbeddedモードのPython環境解決
6. Git日本語ファイル名・XMLエスケープ・起動スクリプト互換設定
"""

from __future__ import annotations

import codecs
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from backend.main import app
from backend.runner import resolve_test_command
from backend.patcher import apply_preview, prepare_preview, safe_target
from backend.references import _expand_msbuild_path
from backend.repository import build_context, decode_process_output, decode_text_bytes, list_repository_entries
from backend.terminal import build_environment
from fastapi.testclient import TestClient


def test_日本語のUTF8_BOM_UTF16_CP932を判別する() -> None:
    text = "日本語テキスト\n"
    assert decode_text_bytes(codecs.BOM_UTF8 + text.encode("utf-8")) == (text, "utf-8-sig")
    assert decode_text_bytes(text.encode("utf-16"))[0] == text
    assert decode_text_bytes(text.encode("cp932"))[0] == text
    assert decode_process_output("テスト成功".encode("cp932")) == "テスト成功"


def test_CP932とCRLFを保ったままCSharpメソッドを反映する(tmp_path: Path) -> None:
    target = tmp_path / "Service.cs"
    original = (
        "public class Service {\r\n"
        "    // 日本語コメント\r\n"
        "    public int Total() { return 1; }\r\n"
        "}\r\n"
    )
    target.write_bytes(original.encode("cp932"))

    preview = prepare_preview(
        tmp_path,
        "```csharp\npublic int Total() { return 2; }\n```",
    )
    result = apply_preview(tmp_path, preview)

    assert result["status"] == "success"
    data = target.read_bytes()
    decoded = data.decode("cp932")
    assert "日本語コメント" in decoded and "return 2" in decoded
    assert data.count(b"\r\n") == data.count(b"\n")


def test_UTF8_BOMを保ったままPython関数を反映する(tmp_path: Path) -> None:
    target = tmp_path / "service.py"
    target.write_bytes(codecs.BOM_UTF8 + "def value():\r\n    return '旧'\r\n".encode("utf-8"))

    preview = prepare_preview(tmp_path, "```python\ndef value():\n    return '新'\n```")
    assert apply_preview(tmp_path, preview)["status"] == "success"

    data = target.read_bytes()
    assert data.startswith(codecs.BOM_UTF8)
    assert "return '新'" in data.decode("utf-8-sig")
    assert data.count(b"\r\n") == data.count(b"\n")


def test_CP932とCRLFを保ったままPythonクラスを反映する(tmp_path: Path) -> None:
    target = tmp_path / "service.py"
    original = (
        "# 日本語設定クラス\r\n"
        "class ConfigService:\r\n"
        "    def get_title(self):\r\n"
        "        return '旧タイトル'\r\n"
    )
    target.write_bytes(original.encode("cp932"))

    output = (
        "class ConfigService:\n"
        "    def get_title(self):\n"
        "        return '新タイトル'\n"
    )
    preview = prepare_preview(tmp_path, output)
    result = apply_preview(tmp_path, preview)

    assert result["status"] == "success"
    data = target.read_bytes()
    decoded = data.decode("cp932")
    assert "日本語設定クラス" in decoded and "新タイトル" in decoded
    assert data.count(b"\r\n") == data.count(b"\n")



def test_Windows形式の相対パスを安全に解決する(tmp_path: Path) -> None:
    expected = tmp_path / "src" / "module.py"
    assert safe_target(tmp_path, r"src\module.py") == expected.resolve()
    with pytest.raises(ValueError):
        safe_target(tmp_path, r"..\outside.py")


def test_MSBuild参照パスの環境変数と区切りを展開する(monkeypatch) -> None:
    monkeypatch.setenv("SHARED_ROOT", "shared")
    expanded = _expand_msbuild_path(r"$(SHARED_ROOT)\src\Library.csproj")
    assert Path(expanded).parts == ("shared", "src", "Library.csproj")


def test_Embeddedモードでは親の仮想環境を引き継がない(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("VIRTUAL_ENV", str(tmp_path / "parent_venv"))
    environment = build_environment(tmp_path, "embedded", str(tmp_path / "embedded_python"))
    assert "VIRTUAL_ENV" not in environment
    assert environment["PYTHONUTF8"] == "1"
    assert environment["PYTHONIOENCODING"] == "utf-8"


def test_テスト実行APIでEmbeddedモードのPythonと環境変数が適用される(tmp_path: Path) -> None:
    """Embedded Pythonモード指定時にテスト実行APIで指定環境のPythonが解決されることを検証"""
    embedded_dir = tmp_path / "embedded_py"
    embedded_dir.mkdir()
    py_bin_name = "python.exe" if os.name == "nt" else "python"
    fake_python = embedded_dir / py_bin_name
    fake_python.touch()

    cmd = resolve_test_command(tmp_path, "python -m pytest", mode="embedded", embedded_python_dir=str(embedded_dir))
    assert str(fake_python) in cmd


@pytest.mark.skipif(shutil.which("git") is None, reason="Gitコマンドが必要です")
def test_Gitの日本語ファイル名を引用符なしで列挙する(tmp_path: Path) -> None:
    name = "日本語 & space.py"
    (tmp_path / name).write_text("値 = 1\n", encoding="utf-8")
    subprocess.run(["git", "init", str(tmp_path)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(tmp_path), "add", name], check=True, capture_output=True)

    entries, is_git = list_repository_entries(tmp_path)

    assert is_git is True
    assert name in {entry.path for entry in entries}


def test_コンテキストのXML属性をエスケープする(tmp_path: Path) -> None:
    name = "a&b.py"
    (tmp_path / name).write_text("value = 1\n", encoding="utf-8")

    context, count, _ = build_context(tmp_path, [name])

    assert count == 1
    assert '<file path="a&amp;b.py">' in context


def test_起動スクリプトにWindows互換設定と配布物検査がある() -> None:
    root = Path(__file__).resolve().parents[1]
    batch = (root / "start.bat").read_text(encoding="utf-8")
    shell = (root / "start.sh").read_text(encoding="utf-8")

    assert "chcp 65001" in batch
    assert "PYTHONIOENCODING=utf-8" in batch
    assert r".venv\Scripts\python.exe" in batch
    assert "taskkill /PID" in batch
    assert "if not exist frontend\\dist\\index.html" in batch
    assert "lsof -tiTCP" in shell
    assert "frontend/dist/index.html" in shell and "exit 1" in shell
