"""
テストコマンドの解決と、子孫プロセスまで確実に終了できるコマンド実行モジュール (runner.py)

仕様:
1. resolve_test_command: `python ...` / `pytest ...` で始まるコマンドを、選択中の環境（仮想環境 / Embedded Python）のPythonで実行する形へ書き換える。
2. run_shell_command: シェル経由で実行し、タイムアウト時はプロセスグループ（Windowsは taskkill /T）ごと終了する。
   孫プロセスがパイプを握ったまま残ってもタイムアウトで確実に戻る。
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
from pathlib import Path

from .pyenv import find_embedded_python, find_venv_python


def resolve_test_command(root: Path, command: str, mode: str = "normal", embedded_python_dir: str = "") -> str:
    """Prefer the selected environment's Python for default test commands."""
    if mode == "embedded" and embedded_python_dir:
        python_path = find_embedded_python(embedded_python_dir)
    else:
        python_path = find_venv_python(root)
    if python_path is None:
        return command

    quoted_python = f'"{python_path}"'
    stripped = command.strip()
    if re.match(r"^(?:python|python3)(?:\s|$)", stripped, re.IGNORECASE):
        rest = re.sub(r"^\S+", "", stripped)
        return quoted_python + rest
    if re.match(r"^pytest(?:\s|$)", stripped, re.IGNORECASE):
        return f"{quoted_python} -m {stripped}"
    return command


def _kill_process_tree(process: subprocess.Popen) -> None:
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True, timeout=10)
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        process.kill()


def run_shell_command(command: str, cwd: Path, env: dict[str, str], timeout: int) -> tuple[int | None, bytes, bytes]:
    """コマンドを実行し (終了コード, stdout, stderr) を返す。タイムアウト時の終了コードはNone。"""
    options: dict = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    process = subprocess.Popen(command, cwd=cwd, env=env, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **options)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
        return process.returncode, stdout, stderr
    except subprocess.TimeoutExpired:
        _kill_process_tree(process)
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            stdout, stderr = b"", b""
        return None, stdout or b"", stderr or b""
