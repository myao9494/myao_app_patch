"""
ランチャーで .py を開くときに使う Python（venv）を選び、そのスクリプトを実行する。

仕様（WPF ランチャーの PythonEnv.cs と同じ約束）:
- スクリプトと同じ階層（親フォルダの直下）に `.venv` があれば、その venv の Python で実行する。
  さらに上の階層の `.venv` は見ない。
- 無ければ、Web 設定ドロワーの「Python 実行環境（.venv）」（共有設定 `python_venv_path`。絶対パス）の venv で実行する。
  venv フォルダの代わりに python 実行ファイルそのものを指定してもよい。
- どちらも無い（設定が空欄）ときは、システムの Python で実行する。コマンド名（Windows は python、
  macOS / Linux は python3）だけを渡し、実行ファイルは PATH から探させる（macOS はターミナルのシェルの PATH）。
- 設定した venv が見つからない・絶対パスでないときは、別の Python で代わりに動かさず PythonEnvError にする。
- 実行時の current dir はスクリプトの親フォルダ。Windows は新しいコンソール、macOS はターミナルで実行して出力を見られるようにする。
- 起動用ラッパー（python_run_wrapper.py）を挟んで実行し、スクリプトが例外や 0 以外の終了コードで終わったら
  トレースバックの末尾をポップアップで知らせる（コンソールの表示はそのまま）。
"""

import os
import platform
import shlex
import subprocess

# venv の中で Python 実行ファイルが置かれる場所（Windows の venv と macOS / Linux の venv）
VENV_INTERPRETER_CANDIDATES = (
    os.path.join("Scripts", "python.exe"),
    os.path.join("bin", "python"),
    os.path.join("bin", "python3"),
)
SIBLING_VENV_NAME = ".venv"
# 失敗をポップアップで知らせる起動用ラッパー（venv の Python で単体のファイルとして起動する）
PYTHON_RUN_WRAPPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "python_run_wrapper.py")


class PythonEnvError(Exception):
    """設定した venv が使えないため、.py を実行しなかったことを表す。"""


def is_python_script(path: str) -> bool:
    """拡張子が .py（大文字小文字は問わない）のファイルかを返す。"""
    return os.path.splitext(path)[1].lower() == ".py"


def system_python_command() -> str:
    """システムの Python のコマンド名を返す（Windows は python、それ以外は python3。PATH から探す）。"""
    return "python" if platform.system() == "Windows" else "python3"


def venv_interpreter(venv_path: str) -> str | None:
    """
    venv フォルダから Python 実行ファイルのパスを返す。見つからなければ None。
    python 実行ファイルそのものを渡されたときは、そのまま返す。
    """
    if os.path.isfile(venv_path):
        return venv_path
    if not os.path.isdir(venv_path):
        return None
    for candidate in VENV_INTERPRETER_CANDIDATES:
        interpreter = os.path.join(venv_path, candidate)
        if os.path.isfile(interpreter):
            return interpreter
    return None


def resolve_python_interpreter(script_path: str, configured_venv: str) -> str:
    """
    スクリプトを実行する Python（パスまたはコマンド名）を返す。
    優先順: スクリプトと同じ階層の .venv → 設定の venv → システムの Python。
    設定した venv が使えないときは PythonEnvError（システムの Python で代わりに動かさない）。
    """
    script_dir = os.path.dirname(script_path)
    sibling = venv_interpreter(os.path.join(script_dir, SIBLING_VENV_NAME)) if script_dir else None
    if sibling:
        return sibling
    configured = str(configured_venv or "").strip()
    if not configured:
        return system_python_command()
    if not os.path.isabs(configured):
        raise PythonEnvError(f"Python 実行環境（.venv）は絶対パスで指定してください: {configured}")
    interpreter = venv_interpreter(configured)
    if interpreter is None:
        raise PythonEnvError(f"Python 実行環境（.venv）が見つかりません: {configured}")
    return interpreter


def _applescript_string(text: str) -> str:
    """AppleScript の文字列リテラルに埋め込めるよう、\\ と \" を逃がして引用符で囲む。"""
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def run_python_script(script_path: str, interpreter: str, wrapper_path: str = PYTHON_RUN_WRAPPER) -> None:
    """指定した Python で、起動用ラッパー経由でスクリプトを実行する。current dir はスクリプトの親フォルダ。"""
    working_directory = os.path.dirname(script_path) or os.getcwd()
    system = platform.system()
    if system == "Windows":
        # start は新しいコンソールを開く。/d で current dir を指定する。
        subprocess.Popen(["cmd", "/c", "start", "", "/d", working_directory, interpreter, wrapper_path, script_path])
    elif system == "Darwin":
        # GUI から直接起動すると出力が見えないため、ターミナルの新しいウインドウで実行する。
        shell_command = " ".join(
            ["cd", shlex.quote(working_directory), "&&", shlex.quote(interpreter), shlex.quote(wrapper_path), shlex.quote(script_path)]
        )
        lines = ['tell application "Terminal"', "activate", f"do script {_applescript_string(shell_command)}", "end tell"]
        command = ["osascript"]
        for line in lines:
            command += ["-e", line]
        subprocess.Popen(command)
    else:
        subprocess.Popen([interpreter, wrapper_path, script_path], cwd=working_directory)


def open_python_script(script_path: str, configured_venv: str) -> None:
    """
    .py を開く入口。選んだ Python でスクリプトを実行する。
    設定した venv が使えないときは PythonEnvError をそのまま投げる（呼び出し側で表示する）。
    """
    run_python_script(script_path, resolve_python_interpreter(script_path, configured_venv))
