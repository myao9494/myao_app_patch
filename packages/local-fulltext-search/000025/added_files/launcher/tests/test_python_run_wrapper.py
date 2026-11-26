"""
ランチャーが .py を実行するときに挟む起動用ラッパー（launcher_app/python_run_wrapper.py）を検証する。

- 対象スクリプトを `python script.py` と同じ条件（__main__・sys.argv・sys.path[0]）で実行する。
- 例外で止まったら、コンソールへトレースバックを出し（ラッパー自身の行は出さない）、末尾をポップアップで知らせる。
- 0 以外の終了コードで終わったときもポップアップで知らせ、終了コードはそのまま返す。
- 正常終了と Ctrl+C（KeyboardInterrupt）ではポップアップを出さない。
"""

import subprocess
import sys
from pathlib import Path

import pytest

from launcher_app import python_run_wrapper
from launcher_app.python_run_wrapper import run

WRAPPER_PATH = Path(python_run_wrapper.__file__)


@pytest.fixture
def popups(monkeypatch) -> list[tuple[str, str]]:
    """ポップアップの代わりに (タイトル, 本文) を記録する。sys.argv / sys.path は実行後に元へ戻す。"""
    monkeypatch.setattr(sys, "argv", list(sys.argv))
    monkeypatch.setattr(sys, "path", list(sys.path))
    return []


def write_script(folder: Path, body: str, name: str = "job.py") -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    script = folder / name
    script.write_text(body, encoding="utf-8")
    return script


def run_script(script: Path, popups: list[tuple[str, str]], *args: str) -> int:
    return run(["python_run_wrapper.py", str(script), *args], show_popup=lambda title, message: popups.append((title, message)))


def test_successful_script_runs_as_main_without_popup(tmp_path: Path, popups, capsys) -> None:
    script = write_script(
        tmp_path / "project",
        "import sys\n"
        "print(__name__, sys.argv[1:], sys.path[0] == __import__('os').path.dirname(__file__))\n"
        "print(__file__)\n",
    )

    assert run_script(script, popups, "a", "b c") == 0

    out = capsys.readouterr().out.splitlines()
    assert out[0] == "__main__ ['a', 'b c'] True"
    assert out[1] == str(script)
    assert popups == []


def test_script_can_import_modules_next_to_it(tmp_path: Path, popups, capsys) -> None:
    write_script(tmp_path / "project", "VALUE = 42\n", name="helper.py")
    script = write_script(tmp_path / "project", "import helper\nprint(helper.VALUE)\n")

    assert run_script(script, popups) == 0
    assert capsys.readouterr().out.strip() == "42"


def test_exception_prints_traceback_without_wrapper_frames_and_shows_popup(tmp_path: Path, popups, capsys) -> None:
    script = write_script(tmp_path / "project", "def main():\n    return 1 / 0\n\nmain()\n")

    assert run_script(script, popups) == 1

    err = capsys.readouterr().err
    assert err.startswith("Traceback (most recent call last):")
    assert "ZeroDivisionError: division by zero" in err
    assert str(script) in err
    assert "python_run_wrapper" not in err and "runpy" not in err
    assert len(popups) == 1
    title, message = popups[0]
    assert "job.py" in title
    assert "ZeroDivisionError: division by zero" in message
    assert "python_run_wrapper" not in message


def test_syntax_error_is_reported(tmp_path: Path, popups, capsys) -> None:
    script = write_script(tmp_path / "project", "def broken(:\n    pass\n")

    assert run_script(script, popups) == 1

    assert "SyntaxError" in capsys.readouterr().err
    assert "SyntaxError" in popups[0][1]


def test_missing_module_is_reported(tmp_path: Path, popups, capsys) -> None:
    script = write_script(tmp_path / "project", "import module_that_does_not_exist_12345\n")

    assert run_script(script, popups) == 1

    assert "ModuleNotFoundError" in popups[0][1]


def test_long_traceback_is_trimmed_in_popup_but_kept_in_console(tmp_path: Path, popups, capsys) -> None:
    script = write_script(tmp_path / "project", "raise ValueError('x' * 5000)\n")

    run_script(script, popups)

    assert "x" * 5000 in capsys.readouterr().err
    message = popups[0][1]
    assert len(message) <= python_run_wrapper.POPUP_MAX_CHARS + 200
    assert message.rstrip().endswith("x"), "末尾（例外の行）を残して前を省く"


def test_nonzero_exit_code_is_kept_and_reported(tmp_path: Path, popups, capsys) -> None:
    script = write_script(tmp_path / "project", "import sys\nsys.exit(3)\n")

    assert run_script(script, popups) == 3

    assert len(popups) == 1
    assert "終了コード 3" in popups[0][1]


def test_exit_with_message_prints_it_and_reports(tmp_path: Path, popups, capsys) -> None:
    """sys.exit("...") は python と同じく stderr へ出して終了コード 1。ポップアップにも文言を載せる。"""
    script = write_script(tmp_path / "project", "import sys\nsys.exit('設定ファイルがありません')\n")

    assert run_script(script, popups) == 1

    assert "設定ファイルがありません" in capsys.readouterr().err
    assert "設定ファイルがありません" in popups[0][1]


def test_zero_exit_and_keyboard_interrupt_do_not_show_popup(tmp_path: Path, popups, capsys) -> None:
    zero = write_script(tmp_path / "a", "import sys\nsys.exit(0)\n")
    interrupted = write_script(tmp_path / "b", "raise KeyboardInterrupt\n")

    assert run_script(zero, popups) == 0
    assert run_script(interrupted, popups) == 130
    assert popups == []


def test_popup_failure_does_not_hide_the_error(tmp_path: Path, popups, capsys) -> None:
    """ポップアップを出せなくても、コンソールのトレースバックと終了コードは保つ。"""
    script = write_script(tmp_path / "project", "raise RuntimeError('boom')\n")

    def _broken_popup(title: str, message: str) -> None:
        raise OSError("no display")

    code = run(["python_run_wrapper.py", str(script)], show_popup=_broken_popup)

    assert code == 1
    assert "RuntimeError: boom" in capsys.readouterr().err


def test_wrapper_runs_as_a_standalone_file(tmp_path: Path) -> None:
    """ランチャーは venv の Python で、このファイルを単体で起動する（launcher_app を import できない環境でも動く）。"""
    script = write_script(tmp_path / "project", "import sys, os\nprint(sys.argv[1], os.getcwd() == os.path.dirname(__file__))\n")

    completed = subprocess.run(
        [sys.executable, "-I", str(WRAPPER_PATH), str(script), "arg1"],
        cwd=script.parent,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == "arg1 True"


def test_missing_script_argument_is_usage_error(popups, capsys) -> None:
    assert run(["python_run_wrapper.py"], show_popup=lambda *_: popups.append(_)) == 2
    assert "使い方" in capsys.readouterr().err
