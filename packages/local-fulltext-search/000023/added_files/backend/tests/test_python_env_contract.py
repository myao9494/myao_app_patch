"""
Python 実行環境（backend/.venv）の用意と起動スクリプトの約束を固定するテスト。

仕様（docs/runtime_and_distribution.md「Python 実行環境」）:
- Python は 3.14（Mac・会社の Windows とも 3.14.9）。バックエンドは常に backend/.venv の Python で動かす。
- 会社の Windows には uv が無い。setup_windows.bat が pip だけで backend\\.venv を作り、
  版を固定した requirements-lock.txt を入れる。既存の venv が 3.14 で動かなければ作り直す。
- GPU 版は setup_windows_cuda.bat（= setup_windows.bat /cuda）。requirements-cuda.txt が CUDA 12.6 の
  索引を足して同じ requirements-lock.txt を入れるので、torch だけが同じ版の +cu126 になる。
  CUDA 12.4 には Python 3.14 用の torch が無く、黙って CPU 版が入るため使わない。
- start_windows.bat は backend\\.venv が無ければ setup_windows.bat を呼んでから起動する。システムの python は使わない。
- Mac の start_dev.sh も requirements-lock.txt を入れ、3.14 でない venv は作り直す。
"""

import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = PROJECT_ROOT / "backend"


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _requirement_lines(path: Path) -> list[str]:
    lines = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line and not line.startswith("-"):
            lines.append(line)
    return lines


def _pinned_versions() -> dict[str, str]:
    pinned = {}
    for line in _requirement_lines(BACKEND_DIR / "requirements-lock.txt"):
        match = re.match(r"^([A-Za-z0-9._-]+)==([^\s;]+)", line)
        assert match, f"== で版を固定していない行があります: {line}"
        pinned[_normalize(match.group(1))] = match.group(2)
    return pinned


def _read_crlf_batch(name: str) -> str:
    """CRLF で保存されていることを確かめてから中身を返す（LF だと cmd が行を読み違える）"""
    raw = (PROJECT_ROOT / name).read_bytes()
    assert b"\n" not in raw.replace(b"\r\n", b""), f"{name} に LF だけの改行があります"
    return raw.decode("utf-8")


def _assert_goto_targets_exist(script: str) -> None:
    labels = {
        line.strip()[1:].lower()
        for line in script.splitlines()
        if line.strip().startswith(":") and not line.strip().startswith("::")
    }
    goto_targets = {line.strip().split(":")[-1].lower() for line in script.splitlines() if "goto :" in line.lower()}
    assert goto_targets <= labels


def test_requirements_lock_pins_every_direct_requirement() -> None:
    pinned = _pinned_versions()
    direct = {
        _normalize(re.match(r"^[A-Za-z0-9._-]+", line).group(0))
        for line in _requirement_lines(BACKEND_DIR / "requirements.txt")
    }

    assert direct <= set(pinned)
    # Python 3.14 用の wheel がある版（2.11 以前は Rust でのビルドになり失敗する）
    assert pinned["pydantic"] == "2.12.5"
    # PyPI（Mac・CPU の Windows）と CUDA 12.6 の索引の両方にある版にそろえる
    assert pinned["torch"] == "2.14.1"


def test_requirements_lock_keeps_platform_markers() -> None:
    text = (BACKEND_DIR / "requirements-lock.txt").read_text(encoding="utf-8")

    assert re.search(r"^pyobjc-framework-cocoa==.*sys_platform == 'darwin'", text, re.MULTILINE | re.IGNORECASE)
    assert re.search(r"^colorama==.*sys_platform == 'win32'", text, re.MULTILINE)


def test_cuda_requirements_use_cuda126_index_and_the_same_lock() -> None:
    text = (BACKEND_DIR / "requirements-cuda.txt").read_text(encoding="utf-8")

    assert "--extra-index-url https://download.pytorch.org/whl/cu126" in text
    assert "-r requirements-lock.txt" in text
    # CPU 版の torch 2.14.1 が入った venv でも GPU 版に入れ替わるよう、+cu126 を明示する
    assert re.search(r"^torch==2\.14\.1\+cu126$", text, re.MULTILINE)
    active_lines = [line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    assert not any("cu124" in line for line in active_lines)


def test_python_version_is_314() -> None:
    assert (BACKEND_DIR / ".python-version").read_text(encoding="utf-8").strip() == "3.14.9"


def test_setup_windows_batch_contract() -> None:
    script = _read_crlf_batch("setup_windows.bat")

    # Python 3.14 を py ランチャー → python の順に探し、uv には頼らない
    assert script.index("py -3.14") < script.index('set "PY_CMD=python"')
    assert "sys.version_info[:2] == (3, 14)" in script
    assert not re.search(r"^\s*uv\s", script, re.MULTILINE | re.IGNORECASE)

    # backend\.venv を作り（壊れている・3.14 でないときは作り直す）、版固定の一覧を入れる
    assert "%PY_CMD% -m venv --clear .venv" in script
    assert 'set "REQ_FILE=requirements-lock.txt"' in script
    assert 'set "REQ_FILE=requirements-cuda.txt"' in script
    assert '"%VENV_PY%" -m pip install -r "%REQ_FILE%"' in script
    assert "/nopause" in script and "/cuda" in script
    _assert_goto_targets_exist(script)


def test_setup_windows_cuda_batch_delegates_to_setup_windows() -> None:
    script = _read_crlf_batch("setup_windows_cuda.bat")

    assert 'call "%~dp0setup_windows.bat" /cuda' in script
    assert "torch.cuda.is_available()" in script


def test_start_windows_uses_backend_venv_only() -> None:
    script = _read_crlf_batch("start_windows.bat")

    assert 'set "PYTHON_EXE=%BACKEND_DIR%\\.venv\\Scripts\\python.exe"' in script
    assert 'call "%APP_ROOT%setup_windows.bat" /nopause' in script
    assert 'set "PYTHON_EXE=python"' not in script
    assert "venv\\Scripts\\python.exe\" (" not in script
    assert '"%PYTHON_EXE%" run.py' in script


def test_mac_start_dev_installs_lock_into_python314_venv() -> None:
    script = (PROJECT_ROOT / "start_dev.sh").read_text(encoding="utf-8")

    assert "requirements-lock.txt" in script
    assert "sys.version_info[:2] == (3, 14)" in script
    assert "-m venv --clear" in script
