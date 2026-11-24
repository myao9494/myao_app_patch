"""
requirements-lock.txt と uv.lock の一致を確かめるテスト

仕様:
- 会社の Windows 端末には uv が無いので、setup_windows.bat は uv.lock から書き出した
  requirements-lock.txt を pip で入れる（docs/startup_scripts.md）。
- requirements-lock.txt は uv.lock の全パッケージを同じ版で固定していること。
  uv.lock を更新したら `uv export` で書き出し直す（手順はファイル冒頭のコメント）。
"""

import re
import tomllib
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent


def _locked_versions() -> dict[str, str]:
    """uv.lock に記録された依存パッケージ（プロジェクト自身を除く）の名前と版"""
    data = tomllib.loads((BACKEND_DIR / "uv.lock").read_text(encoding="utf-8"))
    return {
        _normalize(pkg["name"]): pkg["version"]
        for pkg in data["package"]
        if pkg.get("source", {}).get("virtual") is None and pkg.get("source", {}).get("editable") is None
    }


def _pinned_versions() -> dict[str, str]:
    """requirements-lock.txt で == 固定されたパッケージの名前と版"""
    pinned: dict[str, str] = {}
    for line in (BACKEND_DIR / "requirements-lock.txt").read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        match = re.match(r"^([A-Za-z0-9._-]+)==([^\s;]+)", line)
        assert match, f"== で版を固定していない行があります: {line}"
        pinned[_normalize(match.group(1))] = match.group(2)
    return pinned


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def test_requirements_lock_pins_every_package_in_uv_lock():
    assert _pinned_versions() == _locked_versions()


def test_requirements_lock_keeps_windows_only_packages():
    """Windows でだけ入るパッケージ（pywinpty / pywin32）も含めて書き出していること"""
    text = (BACKEND_DIR / "requirements-lock.txt").read_text(encoding="utf-8")
    assert re.search(r"^pywinpty==.*sys_platform == 'win32'", text, re.MULTILINE)
    assert re.search(r"^pywin32==.*sys_platform == 'win32'", text, re.MULTILINE)
