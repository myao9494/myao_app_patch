"""
Python 実行環境（backend/.venv）の用意と起動スクリプトの約束を確かめるテスト。

仕様（CLAUDE.md「起動」）:
- Python は 3.14（Mac・会社の Windows とも 3.14.9）。サーバーは常に backend/.venv の Python で起動する
- 会社の Windows 端末には uv が無い。setup_windows.bat が pip だけで backend\\.venv を作り、
  uv.lock から書き出した requirements-lock.txt（版固定）を入れる。Windows の起動バッチは uv を使わない
- macOS の start_app.sh / start_dev.sh は backend/ensure_venv.sh で venv を用意してから、その Python で起動する
"""
import re
import tomllib
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
ROOT_DIR = BACKEND_DIR.parent


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _locked_versions() -> dict[str, str]:
    """uv.lock に記録された依存パッケージ（プロジェクト自身を除く）の名前と版"""
    data = tomllib.loads((BACKEND_DIR / "uv.lock").read_text(encoding="utf-8"))
    return {
        _normalize(pkg["name"]): pkg["version"]
        for pkg in data["package"]
        if "virtual" not in pkg.get("source", {}) and "editable" not in pkg.get("source", {})
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


def _read_crlf_batch(name: str) -> str:
    """CRLF で保存されていることを確かめてから中身を返す（LF だと cmd が行を読み違える）"""
    raw = (ROOT_DIR / name).read_bytes()
    assert b"\n" not in raw.replace(b"\r\n", b""), f"{name} に LF だけの改行があります"
    return raw.decode("utf-8")


def test_requirements_lock_pins_every_package_in_uv_lock():
    assert _pinned_versions() == _locked_versions()


def test_requirements_lock_keeps_windows_only_packages():
    text = (BACKEND_DIR / "requirements-lock.txt").read_text(encoding="utf-8")
    assert re.search(r"^colorama==.*sys_platform == 'win32'", text, re.MULTILINE)


def test_python_version_is_314():
    assert (BACKEND_DIR / ".python-version").read_text(encoding="utf-8").strip() == "3.14.9"


def test_setup_windows_batch_contract():
    script = _read_crlf_batch("setup_windows.bat")

    # Python 3.14 を py ランチャー → python の順に探し、uv には頼らない
    assert script.index("py -3.14") < script.index('set "PY_CMD=python"')
    assert "sys.version_info[:2] == (3, 14)" in script
    assert not re.search(r"^\s*uv\s", script, re.MULTILINE | re.IGNORECASE)

    # backend\.venv を作り（壊れている・版が違うときは作り直す）、版固定の一覧を入れる
    assert "%PY_CMD% -m venv --clear .venv" in script
    assert '"%VENV_PY%" -m pip install -r requirements-lock.txt' in script
    assert "/nopause" in script

    labels = {line.strip()[1:].lower() for line in script.splitlines() if line.strip().startswith(":") and not line.strip().startswith("::")}
    goto_targets = {line.strip().split(":")[-1].lower() for line in script.splitlines() if "goto :" in line.lower()}
    assert goto_targets <= labels


def test_windows_start_batches_use_backend_venv_without_uv():
    for name in ("start_app.bat", "start_dev.bat"):
        script = _read_crlf_batch(name)
        assert "uv run" not in script, name
        assert r'set "PYTHON_EXE=%~dp0backend\.venv\Scripts\python.exe"' in script, name
        assert r'call "%~dp0setup_windows.bat" /nopause' in script, name
        assert '"%PYTHON_EXE%" -m uvicorn main:app' in script, name


def test_mac_start_scripts_use_backend_venv():
    for name in ("start_app.sh", "start_dev.sh"):
        script = (ROOT_DIR / name).read_text(encoding="utf-8")
        assert 'source "$ROOT_DIR/backend/ensure_venv.sh"' in script, name
        assert '"$BACKEND_PYTHON" -m uvicorn main:app' in script, name
        assert "uv run" not in script, name


def test_ensure_venv_script_contract():
    script = (BACKEND_DIR / "ensure_venv.sh").read_text(encoding="utf-8")
    # uv があれば uv.lock どおりに揃え、無ければ pip で requirements-lock.txt を入れる
    assert "uv sync --frozen --inexact" in script
    assert "requirements-lock.txt" in script
    assert "-m venv --clear" in script
    assert "sys.version_info[:2] == (3, 14)" in script
