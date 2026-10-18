"""
WebSocket対話型ターミナルのテスト仕様

本モジュールは以下の仕様を検証します。
1. Windows/POSIX環境における対話型PTYセッションの起動とコマンド送受信
2. Embedded Pythonモードにおける setenv.bat / setenv.sh の環境変数キャプチャとマージ
3. Embedded版Python（python_console.bat）のターミナル起動とPython環境の優先適用
4. WebSocket経由でのターミナル接続、readyイベント、リサイズ、入出力ストリーミング
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.terminal import (
    PosixPtySession,
    WindowsPtySession,
    build_environment,
    create_session,
    router as terminal_router,
    shell_command,
)


@pytest.mark.skipif(os.name == "nt", reason="POSIX PTYはmacOS/Linux専用です")
def test_対話型PTYでシェルコマンドを実行できる(tmp_path: Path):
    """POSIX環境で対話型PTYセッションが動作することを検証"""
    async def exercise() -> str:
        session = PosixPtySession(tmp_path, build_environment(tmp_path, "normal", ""))
        await session.start()
        try:
            await session.resize(105, 17)
            await session.write("printf '__SPOONFEEDER_PTY_OK__\\n'\n")
            output = ""
            for _ in range(20):
                output += (await asyncio.wait_for(session.read(), timeout=1)).decode("utf-8", errors="replace")
                if "__SPOONFEEDER_PTY_OK__" in output:
                    break
            return output
        finally:
            await session.terminate()

    assert "__SPOONFEEDER_PTY_OK__" in asyncio.run(exercise())


@pytest.mark.skipif(os.name != "nt", reason="Windows PTY専用テストです")
def test_Windows_PTYセッションでシェルコマンドを実行できる(tmp_path: Path):
    """Windows環境でConPTY/WinPTYを用いてシェルコマンドを実行できることを検証"""
    import re

    async def exercise() -> str:
        env = build_environment(tmp_path, "normal", "")
        session = create_session(tmp_path, env, mode="normal", embedded_python_dir="")
        await session.start()
        try:
            await asyncio.sleep(0.5)
            await session.resize(100, 28)
            await session.write("echo __SPOONFEEDER_WINPTY_OK__\r\n")
            output = ""
            for _ in range(30):
                try:
                    chunk = await asyncio.wait_for(session.read(), timeout=0.5)
                    output += session.decode(chunk)
                    clean = re.sub(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])", "", output)
                    if "__SPOONFEEDER_WINPTY_OK__" in clean:
                        break
                except asyncio.TimeoutError:
                    pass
            return output
        finally:
            await session.terminate()

    clean_out = re.sub(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])", "", asyncio.run(exercise()))
    assert "__SPOONFEEDER_WINPTY_OK__" in clean_out


def test_Embeddedモードでsetenvの環境変数をキャプチャしてマージする(tmp_path: Path):
    """Embedded Pythonディレクトリにある setenv スクリプトの環境変数がマージされることを検証"""
    embedded_dir = tmp_path / "custom_py"
    embedded_dir.mkdir()

    if os.name == "nt":
        setenv_file = tmp_path / "setenv.bat"
        setenv_file.write_text(
            "@echo off\n"
            "SET CUSTOM_TEST_VAR=spoonfeeder_embedded_val\n"
            f"SET PYTHON_PATH={embedded_dir}\n"
            "SET PATH=%PYTHON_PATH%;%PATH%\n",
            encoding="utf-8"
        )
    else:
        setenv_file = tmp_path / "setenv.sh"
        setenv_file.write_text(
            "export CUSTOM_TEST_VAR=spoonfeeder_embedded_val\n"
            f"export PYTHON_PATH={embedded_dir}\n"
            "export PATH=$PYTHON_PATH:$PATH\n",
            encoding="utf-8"
        )

    env = build_environment(tmp_path, "embedded", str(embedded_dir))
    assert env.get("CUSTOM_TEST_VAR") == "spoonfeeder_embedded_val"
    assert str(embedded_dir) in env.get("PATH", "")


@pytest.mark.skipif(
    not Path(r"C:\Users\kabu_server\000_work\py3123\python_console.bat").exists(),
    reason="py3123環境が存在する場合のみ実行"
)
def test_Embedded版py3123のpython_console_batがターミナルとして起動できる(tmp_path: Path):
    """C:\\Users\\kabu_server\\000_work\\py3123 の python_console.bat が起動し、Python 3.12.3 で動作することを検証"""
    py3123_dir = Path(r"C:\Users\kabu_server\000_work\py3123")
    cmd = shell_command(tmp_path, mode="embedded", embedded_python_dir=str(py3123_dir))
    assert any("python_console.bat" in arg for arg in cmd)

    async def exercise() -> str:
        env = build_environment(tmp_path, "embedded", str(py3123_dir))
        session = create_session(tmp_path, env, mode="embedded", embedded_python_dir=str(py3123_dir))
        await session.start()
        try:
            await asyncio.sleep(0.5)
            await session.resize(80, 24)
            await session.write("python --version\r\n")
            output = ""
            for _ in range(30):
                try:
                    chunk = await asyncio.wait_for(session.read(), timeout=0.5)
                    output += session.decode(chunk)
                    if "3.12.3" in output or "Python" in output:
                        break
                except asyncio.TimeoutError:
                    pass
            return output
        finally:
            await session.terminate()

    out = asyncio.run(exercise())
    assert "3.12.3" in out or "Python" in out


def test_WebSocket経由でターミナル接続とreadyイベントを受信する(tmp_path: Path):
    """FastAPI WebSocketエンドポイント /api/terminal/ws の接続と ready メッセージの検証"""
    app = FastAPI()
    app.include_router(terminal_router, prefix="/api")

    client = TestClient(app)
    with client.websocket_connect(f"/api/terminal/ws?cwd={tmp_path}") as ws:
        ready_msg = None
        for _ in range(5):
            try:
                data = ws.receive_json()
                if data.get("type") == "ready":
                    ready_msg = data
                    break
            except Exception:
                break

        assert ready_msg is not None
        assert "shell" in ready_msg
        assert "localEcho" in ready_msg
        assert Path(ready_msg["cwd"]).resolve() == tmp_path.resolve()


# ---- 追加: シェル解決 / setenv取り込み / パイプセッション / WebSocket入力 ----------------

import time  # noqa: E402

from backend.terminal import PipeSession, _capture_script_environment, find_python_console_bat  # noqa: E402


def test_python_console_batは指定ファイル_直下_親ディレクトリの順に探索する(tmp_path: Path):
    parent = tmp_path / "parent"
    embedded = parent / "py"
    embedded.mkdir(parents=True)
    assert find_python_console_bat(embedded) is None
    assert find_python_console_bat(None) is None
    (parent / "python_console.bat").write_text("", encoding="utf-8")
    assert find_python_console_bat(embedded) == (parent / "python_console.bat").resolve()
    (embedded / "python_console.bat").write_text("", encoding="utf-8")
    assert find_python_console_bat(embedded) == (embedded / "python_console.bat").resolve()
    assert find_python_console_bat(embedded / "python_console.bat") == (embedded / "python_console.bat").resolve()


@pytest.mark.skipif(os.name == "nt", reason="POSIXシェルの解決を確認するテストです")
def test_POSIXでは対話シェルをログインシェルとして起動する(tmp_path: Path):
    command = shell_command(tmp_path)
    assert Path(command[0]).name in {"zsh", "bash", "sh"} or command[0] == os.environ.get("SHELL")
    assert command[1:] == ["-il"]


@pytest.mark.skipif(os.name == "nt", reason="setenv.shはPOSIX専用です")
def test_setenv_shの追加環境変数をキャプチャする(tmp_path: Path):
    script = tmp_path / "setenv.sh"
    script.write_text("export SPOONFEEDER_CAPTURED=ok\nexport SPOONFEEDER_PATHISH=/a:/b\n", encoding="utf-8")
    captured = _capture_script_environment(script, os.environ.copy())
    assert captured["SPOONFEEDER_CAPTURED"] == "ok" and captured["SPOONFEEDER_PATHISH"] == "/a:/b"


@pytest.mark.skipif(os.name == "nt", reason="POSIXのシェル展開を確認するテストです")
def test_setenv_shのパスに含まれるシェル構文は実行されない(tmp_path: Path):
    evil_dir = tmp_path / 'a"; touch pwned #$(touch pwned2)'
    evil_dir.mkdir()
    script = evil_dir / "setenv.sh"
    script.write_text("export X=1\n", encoding="utf-8")
    assert _capture_script_environment(script, os.environ.copy()).get("X") == "1"
    assert sorted(path.name for path in evil_dir.iterdir()) == ["setenv.sh"]


@pytest.mark.skipif(os.name == "nt", reason="POSIXシェルでパイプセッションを確認するテストです")
def test_パイプセッションでコマンドを実行し出力を受け取れる(tmp_path: Path):
    async def exercise() -> str:
        session = PipeSession(tmp_path, build_environment(tmp_path, "normal", ""))
        await session.start()
        try:
            assert session.local_echo is True
            await session.write("printf '__PIPE_OK__\\n'\r\n")
            output = ""
            deadline = time.monotonic() + 15
            while "__PIPE_OK__" not in output and time.monotonic() < deadline:
                output += session.decode(await asyncio.wait_for(session.read(), timeout=5))
            return output
        finally:
            await session.terminate()

    assert "__PIPE_OK__" in asyncio.run(exercise())


@pytest.mark.skipif(os.name == "nt", reason="POSIX PTYで確認するテストです")
def test_WebSocketはJSONでない生テキストも入力として扱い存在しないcwdでは現在のフォルダで起動する(tmp_path: Path):
    app = FastAPI()
    app.include_router(terminal_router, prefix="/api")
    with TestClient(app).websocket_connect("/api/terminal/ws?cwd=/definitely/not/exist") as ws:
        ready = ws.receive_json()
        assert ready["type"] == "ready" and Path(ready["cwd"]) == Path.cwd()
        ws.send_text("printf '__RAW_%s__\\n' OK\n")
        output = ""
        deadline = time.monotonic() + 15
        while "__RAW_OK__" not in output and time.monotonic() < deadline:
            message = ws.receive_json()
            output += message.get("data", "") if message["type"] == "output" else ""
        assert "__RAW_OK__" in output


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def _wait_until_dead(pid: int, seconds: float = 3.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not _alive(pid):
            return True
        time.sleep(0.05)
    return not _alive(pid)


async def _start_shell_with_background_child(tmp_path: Path) -> tuple[PosixPtySession, int]:
    import re

    session = PosixPtySession(tmp_path, build_environment(tmp_path, "normal", ""))
    await session.start()
    await session.write("sleep 300 & echo CHILD_PID=$!\n")
    output = ""
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        output += (await asyncio.wait_for(session.read(), timeout=5)).decode("utf-8", errors="replace")
        found = re.search(r"CHILD_PID=(\d+)", output)
        if found:
            return session, int(found.group(1))
    raise AssertionError(f"子プロセスのPIDを取得できません: {output!r}")


@pytest.mark.skipif(os.name == "nt", reason="POSIX PTYのプロセス終了を確認するテストです")
def test_ターミナル終了で対話シェルと子プロセスが残らず即座に終わる(tmp_path: Path):
    async def exercise() -> tuple[float, int, int]:
        session, child_pid = await _start_shell_with_background_child(tmp_path)
        shell_pid = session.process.pid
        started = time.monotonic()
        await session.terminate()
        return time.monotonic() - started, shell_pid, child_pid

    elapsed, shell_pid, child_pid = asyncio.run(exercise())
    assert elapsed < 1.5, "対話シェルはSIGTERMを無視するため、SIGHUPで終了させる"
    assert _wait_until_dead(shell_pid)
    assert _wait_until_dead(child_pid), "ターミナルで起動した子プロセスが孤児として残っている"


@pytest.mark.skipif(os.name == "nt", reason="POSIX PTYのプロセス終了を確認するテストです")
def test_終了処理がキャンセルされてもシェルを確実に停止する(tmp_path: Path):
    async def exercise() -> tuple[int, int]:
        session, child_pid = await _start_shell_with_background_child(tmp_path)
        shell_pid = session.process.pid
        task = asyncio.create_task(session.terminate())
        await asyncio.sleep(0)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return shell_pid, child_pid

    shell_pid, child_pid = asyncio.run(exercise())
    assert _wait_until_dead(shell_pid)
    assert _wait_until_dead(child_pid)


@pytest.mark.skipif(os.name == "nt", reason="POSIX PTYのジョブ制御を確認するテストです")
def test_CtrlCで実行中のコマンドを中断してシェルが応答し続ける(tmp_path: Path):
    async def read_for(session: PosixPtySession, seconds: float) -> str:
        output, end = "", time.monotonic() + seconds
        while time.monotonic() < end:
            try:
                output += (await asyncio.wait_for(session.read(), timeout=0.3)).decode("utf-8", errors="replace")
            except asyncio.TimeoutError:
                pass
        return output

    async def exercise() -> str:
        session = PosixPtySession(tmp_path, build_environment(tmp_path, "normal", ""))
        await session.start()
        try:
            await read_for(session, 1.5)
            await session.write("sleep 120\n")
            await read_for(session, 0.7)
            await session.write("\x03")
            await read_for(session, 0.7)
            await session.write("echo __AFTER_CTRL_C__\n")
            return await read_for(session, 2.0)
        finally:
            await session.terminate()

    assert "__AFTER_CTRL_C__" in asyncio.run(exercise())
