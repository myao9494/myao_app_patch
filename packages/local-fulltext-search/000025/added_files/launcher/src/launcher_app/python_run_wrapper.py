"""
ランチャーが .py を実行するときに挟む起動用ラッパー。

使い方: <venv などの python> python_run_wrapper.py <対象スクリプト> [引数...]

仕様:
- 対象スクリプトを `python script.py` と同じ条件で実行する（__name__ は "__main__"、sys.argv[0] は対象スクリプト、
  sys.path[0] は対象スクリプトのフォルダ。ラッパーのフォルダは import 先に残さない）。
- 例外で止まったら、コンソールへ通常どおりトレースバックを出し（ラッパーと runpy の行は除く）、
  末尾（例外の行を含む最大 POPUP_MAX_CHARS 文字）をポップアップで知らせる。終了コードは 1。
- sys.exit で 0 以外の終了コードになったときもポップアップで知らせ、終了コードはそのまま返す。
  sys.exit("文言") は python と同じく文言を stderr へ出して終了コード 1。
- 正常終了と Ctrl+C（KeyboardInterrupt。終了コード 130）ではポップアップを出さない。
- ポップアップは Windows が MessageBox（ctypes）、macOS が osascript の display dialog。出せなくても
  コンソールの表示と終了コードは変えない。
- 実行するのは利用者の venv の Python なので、このファイルは標準ライブラリだけを使い、古い Python 3 でも動く書き方にする。
  launcher_app の他のモジュールを import しない（WPF ランチャーはこのファイルだけを取り出して使う）。
"""

import os
import runpy
import subprocess
import sys
import traceback

POPUP_MAX_CHARS = 1500
KEYBOARD_INTERRUPT_EXIT_CODE = 130
_WRAPPER_FILE = os.path.abspath(__file__)
_RUNPY_FILES = {os.path.abspath(runpy.__file__), "<frozen runpy>"}


def _applescript_string(text):
    """AppleScript の文字列リテラルに埋め込めるよう、\\ と \" を逃がして引用符で囲む。"""
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def show_popup(title, message):
    """エラーをポップアップで知らせる（閉じるまで待つ）。対応していない OS では何もしない。"""
    if sys.platform == "win32":
        import ctypes

        mb_iconerror, mb_setforeground, mb_topmost = 0x10, 0x10000, 0x40000
        ctypes.windll.user32.MessageBoxW(None, message, title, mb_iconerror | mb_setforeground | mb_topmost)
    elif sys.platform == "darwin":
        script = "display dialog {} with title {} buttons {{\"OK\"}} default button \"OK\" with icon stop".format(
            _applescript_string(message), _applescript_string(title)
        )
        subprocess.run(["osascript", "-e", script], check=False)


def _trim_tail(text):
    """ポップアップ用に末尾（例外の行）を残して前を省く。"""
    text = text.rstrip()
    if len(text) <= POPUP_MAX_CHARS:
        return text
    return "…（前略。全文はコンソールを見てください）\n" + text[-POPUP_MAX_CHARS:]


def _strip_wrapper_frames(tb):
    """トレースバックの先頭からラッパー自身と runpy の行を除く（python script.py と同じ見た目にする）。"""
    while tb is not None:
        filename = tb.tb_frame.f_code.co_filename
        if os.path.abspath(filename) != _WRAPPER_FILE and filename not in _RUNPY_FILES and os.path.abspath(filename) not in _RUNPY_FILES:
            break
        tb = tb.tb_next
    return tb


def _notify(show, script, message):
    """ポップアップを出す。出せなくてもスクリプトの結果（表示・終了コード）は変えない。"""
    try:
        show("Python 実行エラー: " + os.path.basename(script), "スクリプト: " + script + "\n\n" + message)
    except Exception:
        pass


def _prepare_environment(script):
    """sys.argv と sys.path を `python script.py` と同じにそろえる。"""
    script_dir = os.path.dirname(script)
    first = os.path.abspath(sys.path[0] or os.getcwd()) if sys.path else ""
    if first == os.path.dirname(_WRAPPER_FILE):
        # python python_run_wrapper.py で起動したときに入るラッパーのフォルダを、対象スクリプトのフォルダへ置き換える
        sys.path[0] = script_dir
    else:
        sys.path.insert(0, script_dir)


def run(argv, show_popup=show_popup):
    """argv（[ラッパー, 対象スクリプト, 引数...]）の対象スクリプトを実行し、終了コードを返す。"""
    if len(argv) < 2:
        sys.stderr.write("使い方: python python_run_wrapper.py <スクリプト> [引数...]\n")
        return 2
    script = os.path.abspath(argv[1])
    sys.argv = [script] + list(argv[2:])
    _prepare_environment(script)
    try:
        runpy.run_path(script, run_name="__main__")
    except SystemExit as exit_request:
        code = exit_request.code
        if code is None:
            return 0
        if isinstance(code, int):
            if code != 0:
                _notify(show_popup, script, "終了コード {} で終了しました。".format(code))
            return code
        sys.stderr.write(str(code) + "\n")
        _notify(show_popup, script, "終了コード 1 で終了しました。\n\n" + _trim_tail(str(code)))
        return 1
    except KeyboardInterrupt as interrupted:
        traceback.print_exception(type(interrupted), interrupted, _strip_wrapper_frames(interrupted.__traceback__))
        return KEYBOARD_INTERRUPT_EXIT_CODE
    except BaseException as error:
        tb = _strip_wrapper_frames(error.__traceback__)
        traceback.print_exception(type(error), error, tb)
        sys.stderr.flush()
        _notify(show_popup, script, _trim_tail("".join(traceback.format_exception(type(error), error, tb))))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(run(sys.argv))
