"""Python実行環境（.venv）の用意と起動スクリプトの約束を確かめる統合テスト。

仕様（claude.md「11. 起動と配布」）:
- Pythonは3.14（自宅のMac・会社のWindowsとも3.14.9。`.python-version`）。サーバーは常に `.venv` のPythonで起動する。
- 依存は版を固定した `backend/requirements-lock.txt` をpipで入れる（会社PCにuvは無い）。
- Windowsは `setup_windows.bat` がPython 3.14を `py -3.14` → `python` の順に探して `.venv` を作り（3.14で動かない
  `.venv` は作り直す）、`requirements-lock.txt` を入れる。`start.bat` は `.venv` が無ければこれを呼ぶ。
- macOSは `start.sh` が同じ手順で `.venv` を用意する。
- `.bat` はCRLFで保存する（LFだとcmd.exeが行を読み違える）。`setup_windows.bat` はASCIIのみ。

Windows上での実行はこのMacでは確かめられないため、スクリプトの約束だけを確かめる。
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "backend" / "requirements-lock.txt"


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _pinned() -> dict[str, str]:
    pinned: dict[str, str] = {}
    for line in LOCK.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            match = re.match(r"^([A-Za-z0-9._-]+)==([^\s;]+)", line)
            assert match, f"==で版を固定していない行があります: {line}"
            pinned[_normalize(match.group(1))] = match.group(2)
    return pinned


def _direct_requirements() -> set[str]:
    names: set[str] = set()
    for line in (ROOT / "backend" / "requirements.txt").read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            names.add(_normalize(re.match(r"^[A-Za-z0-9._-]+", line).group(0)))
    return names


def _batch(name: str) -> bytes:
    return (ROOT / name).read_bytes()


def test_requirements_lockはrequirements_txtの全パッケージを版固定している() -> None:
    assert _direct_requirements() <= set(_pinned())


def test_requirements_lockはWindowsだけで入るpywinptyを含む() -> None:
    assert re.search(r"^pywinpty==.*sys_platform == 'win32'", LOCK.read_text(encoding="utf-8"), re.MULTILINE)


def test_requirements_lockは先頭でUTF8を宣言している() -> None:
    # 宣言が無いと、pipが日本語版Windowsの既定（cp932）で読んで日本語コメントで失敗することがある
    assert LOCK.read_bytes().splitlines()[0] == b"# -*- coding: utf-8 -*-"


def test_Pythonの版は3_14_9に固定されている() -> None:
    assert (ROOT / ".python-version").read_text(encoding="utf-8").strip() == "3.14.9"


def test_batファイルはすべてCRLFで保存されている() -> None:
    for name in ("setup_windows.bat", "start.bat"):
        assert b"\n" not in _batch(name).replace(b"\r\n", b""), name


def test_setup_windows_batはASCIIのみで書かれている() -> None:
    _batch("setup_windows.bat").decode("ascii")


def test_setup_windows_batはPython314をpyランチャーから探す() -> None:
    script = _batch("setup_windows.bat").decode("ascii")
    assert script.index("py -3.14") < script.index('set "PY_CMD=python"') and "sys.version_info[:2] == (3, 14)" in script


def test_setup_windows_batは314で動かないvenvを作り直す() -> None:
    assert "%PY_CMD% -m venv --clear .venv" in _batch("setup_windows.bat").decode("ascii")


def test_setup_windows_batは版固定の一覧をpipで入れuvを使わない() -> None:
    script = _batch("setup_windows.bat").decode("ascii")
    assert '"%VENV_PY%" -m pip install -r backend\\requirements-lock.txt' in script
    assert not re.search(r"^\s*uv\s", script, re.MULTILINE | re.IGNORECASE)


def test_setup_windows_batのgoto先ラベルがすべて存在する() -> None:
    script = _batch("setup_windows.bat").decode("ascii")
    labels = {line.strip()[1:].lower() for line in script.splitlines() if line.strip().startswith(":")}
    targets = {line.strip().split(":")[-1].lower() for line in script.splitlines() if "goto :" in line.lower()}
    assert targets <= labels


def test_start_batはvenvが無ければsetup_windows_batを呼びシステムのpythonを使わない() -> None:
    script = _batch("start.bat").decode("utf-8")
    assert 'call "%~dp0setup_windows.bat" /nopause' in script
    assert "set PYTHON=python" not in script and "venv\\Scripts\\python.exe" in script


def test_start_shは314で動かないvenvを作り直して版固定の一覧を入れる() -> None:
    script = (ROOT / "start.sh").read_text(encoding="utf-8")
    assert "sys.version_info[:2] == (3, 14)" in script and "-m venv --clear" in script
    assert "backend/requirements-lock.txt" in script and "PYTHON=python3" not in script
