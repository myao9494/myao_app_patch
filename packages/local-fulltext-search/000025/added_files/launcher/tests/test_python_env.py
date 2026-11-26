"""
ランチャーで .py を開くときに使う Python（venv）の選び方と起動のしかたを検証する。

- スクリプトと同じ階層の .venv があればその Python で実行する。
- 無ければ設定（python_venv_path）の venv の Python で実行する。
- どちらも無い（設定が空欄）ときは、システムの Python（PATH 上の python。macOS は python3）で実行する。
- 設定した venv が見つからないときは、別の Python で代わりに動かさずエラーにする。
"""

from pathlib import Path

import pytest

from launcher_app.python_env import (
    PythonEnvError,
    is_python_script,
    system_python_command,
    open_python_script,
    resolve_python_interpreter,
    run_python_script,
    venv_interpreter,
)


def make_venv(folder: Path, *, windows: bool = False) -> Path:
    """venv の中の Python 実行ファイルだけを置いた最小の venv を作り、その実行ファイルを返す。"""
    interpreter = folder / ("Scripts/python.exe" if windows else "bin/python")
    interpreter.parent.mkdir(parents=True)
    interpreter.write_text("")
    return interpreter


def make_script(folder: Path) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    script = folder / "job.py"
    script.write_text("print('hello')\n")
    return script


def test_only_py_files_are_python_scripts() -> None:
    assert is_python_script("/work/job.py") is True
    assert is_python_script("C:/work/JOB.PY") is True
    assert is_python_script("/work/job.bat") is False
    assert is_python_script("/work/job.pyc") is False


def test_venv_interpreter_finds_posix_and_windows_layouts(tmp_path: Path) -> None:
    posix = make_venv(tmp_path / "posix" / ".venv")
    windows = make_venv(tmp_path / "win" / ".venv", windows=True)

    assert venv_interpreter(str(tmp_path / "posix" / ".venv")) == str(posix)
    assert venv_interpreter(str(tmp_path / "win" / ".venv")) == str(windows)
    assert venv_interpreter(str(tmp_path / "missing" / ".venv")) is None


def test_venv_interpreter_accepts_the_python_executable_itself(tmp_path: Path) -> None:
    """設定に venv フォルダでなく python 実行ファイルを書いても、そのまま使う。"""
    interpreter = make_venv(tmp_path / ".venv")

    assert venv_interpreter(str(interpreter)) == str(interpreter)


def test_sibling_venv_is_used_first(tmp_path: Path) -> None:
    """スクリプトと同じ階層の .venv は、設定の venv より優先する。"""
    script = make_script(tmp_path / "project")
    sibling = make_venv(tmp_path / "project" / ".venv")
    configured_dir = tmp_path / "shared" / ".venv"
    make_venv(configured_dir)

    assert resolve_python_interpreter(str(script), str(configured_dir)) == str(sibling)


def test_configured_venv_is_used_when_no_sibling_venv(tmp_path: Path) -> None:
    script = make_script(tmp_path / "project")
    configured_dir = tmp_path / "shared" / ".venv"
    configured = make_venv(configured_dir)

    assert resolve_python_interpreter(str(script), f"  {configured_dir}  ") == str(configured)


def test_venv_in_parent_folder_is_not_treated_as_sibling(tmp_path: Path) -> None:
    """同じ階層だけを見る。親フォルダの .venv は使わない。"""
    script = make_script(tmp_path / "project" / "sub")
    make_venv(tmp_path / "project" / ".venv")

    assert resolve_python_interpreter(str(script), "") == system_python_command()


def test_system_python_command_is_python_on_windows_and_python3_elsewhere(monkeypatch) -> None:
    monkeypatch.setattr("platform.system", lambda: "Windows")
    assert system_python_command() == "python"
    monkeypatch.setattr("platform.system", lambda: "Darwin")
    assert system_python_command() == "python3"


def test_no_venv_and_no_setting_uses_system_python(tmp_path: Path) -> None:
    """同じ階層に .venv が無く、設定も空欄なら、システムの Python（PATH から探すコマンド名）で実行する。"""
    script = make_script(tmp_path / "project")

    assert resolve_python_interpreter(str(script), "") == system_python_command()
    assert resolve_python_interpreter(str(script), "   ") == system_python_command()


def test_missing_configured_venv_is_an_error(tmp_path: Path) -> None:
    """設定した venv が無いときは、システムの Python など別の Python で代わりに動かさない。"""
    script = make_script(tmp_path / "project")

    with pytest.raises(PythonEnvError, match="見つかりません"):
        resolve_python_interpreter(str(script), str(tmp_path / "missing" / ".venv"))


def test_relative_configured_venv_is_an_error(tmp_path: Path) -> None:
    script = make_script(tmp_path / "project")

    with pytest.raises(PythonEnvError, match="絶対パス"):
        resolve_python_interpreter(str(script), ".venv")


def test_scripts_run_through_the_bundled_wrapper_by_default() -> None:
    """失敗をポップアップで知らせるため、既定では同梱の起動用ラッパー経由で実行する。"""
    from launcher_app import python_env, python_run_wrapper

    assert python_env.PYTHON_RUN_WRAPPER == python_run_wrapper.__file__
    assert Path(python_env.PYTHON_RUN_WRAPPER).is_file()


def test_windows_runs_script_with_venv_python_in_new_console(monkeypatch) -> None:
    """Windows は新しいコンソールで、スクリプトの親フォルダを current dir にして、ラッパー経由で venv の Python で実行する。"""
    started: list[tuple[list[str], dict[str, object]]] = []
    monkeypatch.setattr("platform.system", lambda: "Windows")
    monkeypatch.setattr("subprocess.Popen", lambda command, **kwargs: started.append((command, kwargs)))

    run_python_script("C:/work/scripts/job.py", "C:/venvs/tool/Scripts/python.exe", wrapper_path="C:/launcher/python_run_wrapper.py")

    assert started == [(
        [
            "cmd", "/c", "start", "", "/d", "C:/work/scripts",
            "C:/venvs/tool/Scripts/python.exe", "C:/launcher/python_run_wrapper.py", "C:/work/scripts/job.py",
        ],
        {},
    )]


def test_macos_runs_script_in_terminal_with_quoted_paths(monkeypatch) -> None:
    """macOS はターミナルで、親フォルダへ cd してから venv の Python で実行する（空白・引用符を含むパスも崩さない）。"""
    started: list[list[str]] = []
    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("subprocess.Popen", lambda command, **kwargs: started.append(command))

    run_python_script('/Users/me/my work/say "hi".py', "/Users/me/.venv/bin/python", wrapper_path="/Apps/launcher app/python_run_wrapper.py")

    assert len(started) == 1
    command = started[0]
    assert command[0] == "osascript"
    applescript = "\n".join(command[2::2])
    assert 'tell application "Terminal"' in applescript
    # シェルでは cd '/Users/me/my work' && /Users/me/.venv/bin/python '/Apps/launcher app/python_run_wrapper.py' '/Users/me/my work/say "hi".py'
    # AppleScript の文字列では " と \ を逃がす
    assert "do script \"cd '/Users/me/my work' && /Users/me/.venv/bin/python '/Apps/launcher app/python_run_wrapper.py' '/Users/me/my work/say \\\"hi\\\".py'\"" in applescript


def test_open_python_script_runs_system_python_without_venv(tmp_path: Path, monkeypatch) -> None:
    script = make_script(tmp_path / "project")
    ran: list[tuple[str, str]] = []
    monkeypatch.setattr("launcher_app.python_env.run_python_script", lambda path, interpreter: ran.append((path, interpreter)))

    open_python_script(str(script), "")

    assert ran == [(str(script), system_python_command())]


def test_open_python_script_runs_with_resolved_venv(tmp_path: Path, monkeypatch) -> None:
    script = make_script(tmp_path / "project")
    sibling = make_venv(tmp_path / "project" / ".venv")
    ran: list[tuple[str, str]] = []
    monkeypatch.setattr("launcher_app.python_env.run_python_script", lambda path, interpreter: ran.append((path, interpreter)))

    open_python_script(str(script), "")

    assert ran == [(str(script), str(sibling))]
