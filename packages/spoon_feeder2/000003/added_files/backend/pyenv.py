"""
Python実行環境（リポジトリ直下の仮想環境 / Embedded Python）の検出モジュール (pyenv.py)

仕様:
1. リポジトリ直下の仮想環境は `.venv` / `venv` / `env` の順で検出する（テスト実行・ターミナル・依存解析で共通）。
2. Embedded Pythonは、指定ディレクトリ直下、または直下のサブディレクトリにある python 実行ファイルを使う。
"""

from __future__ import annotations

import os
from pathlib import Path

VENV_NAMES = (".venv", "venv", "env")


def executable_dir_name() -> str:
    return "Scripts" if os.name == "nt" else "bin"


def executable_name() -> str:
    return "python.exe" if os.name == "nt" else "python"


def find_venv_python(root: Path) -> Path | None:
    """リポジトリ直下の仮想環境のPython実行ファイルを返す（シンボリックリンクは解決しない）。"""
    for name in VENV_NAMES:
        candidate = root / name / executable_dir_name() / executable_name()
        if candidate.is_file():
            return candidate
    return None


def find_embedded_python(embedded_python_dir: str | Path) -> Path | None:
    """Embedded Pythonディレクトリ（直下または1階層下）のPython実行ファイルを返す。"""
    base = Path(embedded_python_dir).expanduser()
    direct = base / executable_name()
    if direct.is_file():
        return direct
    if base.is_dir():
        for sub in base.iterdir():
            candidate = sub / executable_name()
            if sub.is_dir() and candidate.is_file():
                return candidate
    return None
