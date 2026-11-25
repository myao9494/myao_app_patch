"""Python実行環境（.venv）の用意と起動スクリプトの約束のテスト。

仕様（AGENTS.md「起動とPython実行環境」）:
- Pythonは3.14（Mac・会社のWindowsとも3.14.9。`.python-version`）。バックエンドは常にプロジェクト直下の
  `.venv` のPythonで起動する（システムの python は使わない）。
- 依存は版を固定した `backend/requirements-lock.txt` をpipで入れる（会社PCにuvは無い）。
- Windowsは `setup_windows.bat` がPython 3.14を `py -3.14` → `python` の順に探して `.venv` を作り（3.14で動かない
  `.venv` は作り直す）、`requirements-lock.txt`（pywin32を含む）を入れる。`start_windows.bat` は `.venv` が無ければ呼ぶ。
- Macの `start_mac.command` も3.14で動かない `.venv` を作り直し、`.venv` のPythonで起動する。
- `.bat` はASCIIのみ・CRLF（日本語コードページのcmd.exeが行を読み違えないように）。

Windows上での実行はこのMacでは確かめられないので、スクリプトの約束だけを確かめる。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "backend" / "requirements-lock.txt"


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _names(path: Path) -> set[str]:
    names = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            match = re.match(r"^[A-Za-z0-9._-]+", line)
            assert match is not None
            names.add(_normalize(match.group(0)))
    return names


def _batch(name: str) -> str:
    raw = (ROOT / name).read_bytes()
    assert b"\n" not in raw.replace(b"\r\n", b""), f"{name} に LF だけの改行があります"
    return raw.decode("ascii")  # ASCII以外が入っていれば UnicodeDecodeError


class RequirementsLockTest(unittest.TestCase):
    def test_lock_pins_every_requirement_with_exact_versions(self) -> None:
        lines = [line.split("#", 1)[0].strip() for line in LOCK.read_text(encoding="utf-8").splitlines()]
        lines = [line for line in lines if line]
        self.assertTrue(all(re.match(r"^[A-Za-z0-9._-]+==\S+", line) for line in lines), lines)
        self.assertLessEqual(_names(ROOT / "backend" / "requirements.txt"), _names(LOCK))

    def test_lock_installs_pywin32_only_on_windows(self) -> None:
        self.assertRegex(LOCK.read_text(encoding="utf-8"), re.compile(r"^pywin32==\S+ ; sys_platform == 'win32'$", re.MULTILINE))

    def test_lock_declares_utf8_first(self) -> None:
        # 宣言が無いと、pipが日本語版Windowsの既定（cp932）で読み、日本語コメントで失敗することがある
        self.assertEqual(LOCK.read_bytes().splitlines()[0], b"# -*- coding: utf-8 -*-")

    def test_python_version_is_314(self) -> None:
        self.assertEqual((ROOT / ".python-version").read_text(encoding="utf-8").strip(), "3.14.9")

    def test_venv_is_not_committed(self) -> None:
        self.assertIn(".venv/", (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines())


class WindowsScriptsTest(unittest.TestCase):
    def test_setup_finds_python314_with_py_launcher_first(self) -> None:
        script = _batch("setup_windows.bat")
        self.assertLess(script.index("py -3.14"), script.index('set "PY_CMD=python"'))
        self.assertIn("sys.version_info[:2] == (3, 14)", script)

    def test_setup_recreates_venv_and_installs_lock_without_uv(self) -> None:
        script = _batch("setup_windows.bat")
        self.assertIn("%PY_CMD% -m venv --clear .venv", script)
        self.assertIn('"%VENV_PY%" -m pip install -r backend\\requirements-lock.txt', script)
        self.assertIsNone(re.search(r"^\s*uv\s", script, re.MULTILINE | re.IGNORECASE))

    def test_setup_goto_targets_exist(self) -> None:
        script = _batch("setup_windows.bat")
        labels = {line.strip()[1:].lower() for line in script.splitlines() if line.strip().startswith(":")}
        targets = {m.lower() for m in re.findall(r"goto :?([A-Za-z_]+)", script, re.IGNORECASE)}
        self.assertLessEqual(targets, labels)

    def test_start_uses_venv_python_and_runs_setup_when_missing(self) -> None:
        script = _batch("start_windows.bat")
        self.assertIn('call "%~dp0setup_windows.bat" /nopause', script)
        self.assertNotIn('cmd /c "python backend\\server.py"', script)

    def test_start_launches_backend_directly_without_nested_quotes(self) -> None:
        # cmd /c の入れ子の引用符(""...""）は start 経由で壊れやすいので、venvのPythonを直接起動する
        script = _batch("start_windows.bat")
        self.assertIn('start "Outlook Address Maker Backend" /min "%PYTHON_EXE%" backend\\server.py', script)
        self.assertNotIn('cmd /c ""%PYTHON_EXE%"', script)

    def test_start_shows_the_error_when_backend_fails(self) -> None:
        # 最小化ウィンドウはPythonが落ちると消えてエラーが残らない。事前にimportを確かめ、失敗時は前面で起動し直して見せる
        script = _batch("start_windows.bat")
        self.assertIn('"%PYTHON_EXE%" -c "import backend.server"', script)
        self.assertLess(script.index('-c "import backend.server"'), script.index('/min "%PYTHON_EXE%"'))
        self.assertLess(script.index("Backend did not start"), script.rindex('"%PYTHON_EXE%" backend\\server.py'))


class MacScriptTest(unittest.TestCase):
    def test_start_mac_uses_python314_venv(self) -> None:
        script = (ROOT / "start_mac.command").read_text(encoding="utf-8")
        self.assertIn("sys.version_info[:2] == (3, 14)", script)
        self.assertIn(".venv/bin/python backend/server.py", script)
        self.assertNotIn("python3 backend/server.py", script)


if __name__ == "__main__":
    unittest.main()
