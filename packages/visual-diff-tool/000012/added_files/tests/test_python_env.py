"""
Python 実行環境（.venv）の用意と起動スクリプトの約束を確かめるテスト。

仕様（claude.md「起動と Python 実行環境」）:
- Python は 3.14（Mac・会社の Windows とも 3.14.9。`.python-version`）。サーバーは常に .venv の Python で起動する。
- 依存は版を固定した requirements-lock.txt を pip で入れる（会社 PC に uv は無い）。
  requirements.txt と requirements-3d.txt の全パッケージを == で固定する。
- Windows は setup_windows.bat が Python 3.14 を py -3.14 → python の順に探し、3.14 で動く .venv
  （消せない古い .venv があるときは .venv_windows）を用意して requirements-lock.txt を入れる。
  start_windows.bat は起動のたびにこれを呼んでから、同じ順で選んだ venv の Python で起動する。
- macOS の start_mac.sh は 3.14 で動かない .venv を作り直してから requirements-lock.txt を入れる。
- .bat は ASCII のみ・CRLF（日本語コードページの cmd.exe が行を読み違えないように）。

Windows 上での実行はこの Mac では確かめられないので、スクリプトの約束だけを確かめる。
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "requirements-lock.txt"


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _requirement_names(path: Path) -> set[str]:
    names = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line and not line.startswith("-"):
            names.add(_normalize(re.match(r"^[A-Za-z0-9._-]+", line).group(0)))
    return names


def _pinned() -> dict[str, str]:
    pinned = {}
    for line in LOCK.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            match = re.match(r"^([A-Za-z0-9._-]+)==([^\s;]+)", line)
            assert match, f"== で版を固定していない行があります: {line}"
            pinned[_normalize(match.group(1))] = match.group(2)
    return pinned


def _batch(name: str) -> str:
    raw = (ROOT / name).read_bytes()
    assert b"\n" not in raw.replace(b"\r\n", b""), f"{name} に LF だけの改行があります"
    return raw.decode("ascii")  # ASCII 以外が入っていれば UnicodeDecodeError


def _labels_cover_jumps(script: str) -> bool:
    labels = {line.strip()[1:].lower() for line in script.splitlines() if line.strip().startswith(":") and not line.strip().startswith("::")}
    jumps = {m.lower() for m in re.findall(r"(?:goto|call) :([A-Za-z_]+)", script, re.IGNORECASE)}
    return jumps <= labels


class RequirementsLockTest(unittest.TestCase):
    def test_pins_every_direct_requirement(self):
        direct = _requirement_names(ROOT / "requirements.txt") | _requirement_names(ROOT / "requirements-3d.txt")
        self.assertLessEqual(direct, set(_pinned()))

    def test_keeps_platform_markers(self):
        # uvloop には Windows 用の wheel が無い。目印が消えると会社 PC の pip install が失敗する
        self.assertRegex(LOCK.read_text(encoding="utf-8"), re.compile(r"^uvloop==.*sys_platform != 'win32'", re.MULTILINE))

    def test_declares_utf8_first(self):
        # 宣言が無いと、pip が日本語版 Windows の既定（cp932）で読み、日本語コメントで失敗することがある
        self.assertEqual(LOCK.read_bytes().splitlines()[0], b"# -*- coding: utf-8 -*-")

    def test_python_version_is_314(self):
        self.assertEqual((ROOT / ".python-version").read_text(encoding="utf-8").strip(), "3.14.9")


class WindowsScriptsTest(unittest.TestCase):
    def test_setup_finds_python314_with_py_launcher_first(self):
        script = _batch("setup_windows.bat")
        self.assertLess(script.index("py -3.14"), script.index('set "PY_CMD=python"'))
        self.assertIn("sys.version_info[:2] == (3, 14)", script)

    def test_setup_installs_lock_with_pip_without_uv(self):
        script = _batch("setup_windows.bat")
        self.assertIn('"%VENV_DIR%\\Scripts\\python.exe" -m pip install -r requirements-lock.txt', script)
        self.assertIsNone(re.search(r"^\s*uv\s", script, re.MULTILINE | re.IGNORECASE))

    def test_setup_recreates_venv_with_python314(self):
        script = _batch("setup_windows.bat")
        self.assertIn('%PY_CMD% -m venv --clear "%VENV_DIR%"', script)
        self.assertIn(".venv_windows", script)
        self.assertTrue(_labels_cover_jumps(script))

    def test_start_runs_setup_then_uses_venv_python(self):
        script = _batch("start_windows.bat")
        self.assertIn('call "%~dp0setup_windows.bat" /nopause', script)
        self.assertIn('"..\\%VENV_DIR%\\Scripts\\python.exe" run.py', script)
        self.assertNotIn("py -3 -m venv", script)
        self.assertTrue(_labels_cover_jumps(script))


class MacScriptTest(unittest.TestCase):
    def test_start_mac_rebuilds_non_314_venv_and_installs_lock(self):
        script = (ROOT / "start_mac.sh").read_text(encoding="utf-8")
        self.assertIn("sys.version_info[:2] == (3, 14)", script)
        self.assertIn("-m pip install -r requirements-lock.txt", script)


if __name__ == "__main__":
    unittest.main()
