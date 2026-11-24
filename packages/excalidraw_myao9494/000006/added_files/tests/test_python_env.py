"""Python 実行環境（backend/.venv）の用意と起動スクリプトの約束を確かめるテスト。

仕様（docs/architecture.md「起動スクリプト」）:
- Python は 3.14（Mac・会社の Windows とも 3.14.9）。サーバーは常に backend/.venv の Python で起動する
- 依存の版は backend/requirements-lock.txt で固定する。requirements.txt / requirements-dev.txt の
  全パッケージを == で固定し、Windows だけで入るもの（colorama）も含める
- Windows は setup_windows.bat が pip だけで backend\\.venv を作る（会社 PC には uv が無い）
- macOS は backend/ensure_venv.sh が backend/.venv を用意し、起動スクリプトはそのあとで .venv の Python を使う
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _requirement_names(path: Path) -> set[str]:
    names = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            names.add(_normalize(re.match(r"^[A-Za-z0-9._-]+", line).group(0)))
    return names


def _pinned(path: Path) -> dict[str, str]:
    pinned = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        match = re.match(r"^([A-Za-z0-9._-]+)==([^\s;]+)", line)
        assert match, f"== で版を固定していない行があります: {line}"
        pinned[_normalize(match.group(1))] = match.group(2)
    return pinned


def test_requirements_lock_pins_all_direct_requirements():
    pinned = _pinned(BACKEND / "requirements-lock.txt")
    direct = _requirement_names(BACKEND / "requirements.txt") | _requirement_names(
        BACKEND / "requirements-dev.txt"
    )
    assert direct <= set(pinned)


def test_requirements_lock_keeps_windows_only_packages():
    text = (BACKEND / "requirements-lock.txt").read_text(encoding="utf-8")
    assert re.search(r"^colorama==.*sys_platform == 'win32'", text, re.MULTILINE)


def test_python_version_is_314():
    assert (BACKEND / ".python-version").read_text(encoding="utf-8").strip() == "3.14.9"


def test_setup_windows_batch_contract():
    raw = (ROOT / "setup_windows.bat").read_bytes()
    # LF だけだと cmd が行を読み違えるため CRLF で保存する
    assert b"\r\n" in raw and b"\n" not in raw.replace(b"\r\n", b"")
    script = raw.decode("utf-8")

    # Python 3.14 を py ランチャー → python の順に探し、uv には頼らない
    assert script.index("py -3.14") < script.index('set "PY_CMD=python"')
    assert "sys.version_info[:2] == (3, 14)" in script
    assert not re.search(r"^\s*uv\s", script, re.MULTILINE | re.IGNORECASE)

    # backend\.venv を作り（壊れている・版が違うときは作り直す）、版固定の一覧を入れる
    assert "%PY_CMD% -m venv --clear .venv" in script
    assert '"%VENV_PY%" -m pip install -r requirements-lock.txt' in script
    assert "import fastapi, uvicorn, lzstring, multipart" in script
    assert "/nopause" in script

    labels = {
        line.strip()[1:].lower()
        for line in script.splitlines()
        if line.strip().startswith(":")
    }
    goto_targets = {
        line.strip().split(":")[-1].lower()
        for line in script.splitlines()
        if "goto :" in line.lower()
    }
    assert goto_targets <= labels


def test_start_servers_batch_is_crlf():
    raw = (ROOT / "start_servers.bat").read_bytes()
    assert b"\n" not in raw.replace(b"\r\n", b"")


def test_mac_start_scripts_use_backend_venv():
    for script_path, ensure_call in (
        (ROOT / "start_servers.sh", "./backend/ensure_venv.sh"),
        (ROOT / "start_dev.sh", "./backend/ensure_venv.sh"),
        (BACKEND / "start_server.sh", "./ensure_venv.sh"),
    ):
        script = script_path.read_text(encoding="utf-8")
        assert ensure_call in script, script_path
        assert ".venv/bin/python -m uvicorn" in script, script_path
        # システムの python や backend/venv では起動しない
        assert not re.search(r"^\s*python3? -m uvicorn", script, re.MULTILINE), script_path
        assert "./venv/bin/python" not in script, script_path


def test_ensure_venv_script_contract():
    script = (BACKEND / "ensure_venv.sh").read_text(encoding="utf-8")
    assert "requirements-lock.txt" in script
    assert "sys.version_info[:2] == (3, 14)" in script
    assert "-m venv --clear" in script
