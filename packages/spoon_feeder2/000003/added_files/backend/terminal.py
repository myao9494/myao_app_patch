"""
WebSocket対話型ターミナルモジュール (FastAPI APIRouter)

本モジュールは以下の機能を提供します:
1. Windows (pywinpty / ConPTY / WinPTY / Pipeフォールバック) および macOS/Linux (POSIX PTY) での対話型シェルセッションの管理
2. 通常モード (venv / .venv 自動検出) および Embedded Python モードのサポート
3. Embedded Python モードにおける setenv.bat / setenv.sh の差分環境変数キャプチャ・マージ
4. python_console.bat が存在する場合の優先起動と適切な環境変数適用
5. xterm.js 互換の WebSocket 双方向ストリーミングおよびリサイズ処理
"""

from __future__ import annotations

import asyncio
import codecs
import importlib.util
import json
import locale
import os
import platform
import shutil
import signal
import struct
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .pyenv import find_venv_python
from .security import is_allowed_websocket_origin

router = APIRouter()


def find_python_console_bat(embedded_python_dir: str | Path | None) -> Path | None:
    """指定されたEmbedded Pythonディレクトリまたはその親から python_console.bat を探索する"""
    if not embedded_python_dir:
        return None
    candidate = Path(embedded_python_dir).expanduser()
    if candidate.is_file() and candidate.name.lower() == "python_console.bat":
        return candidate.resolve()
    if candidate.is_dir():
        bat = candidate / "python_console.bat"
        if bat.exists() and bat.is_file():
            return bat.resolve()
        parent_bat = candidate.parent / "python_console.bat"
        if parent_bat.exists() and parent_bat.is_file():
            return parent_bat.resolve()
    return None


def shell_command(cwd: Path, mode: str = "normal", embedded_python_dir: str = "") -> list[str]:
    """OSおよび実行モードに応じた最適なシェル起動コマンドを返す"""
    if os.name == "nt":
        if mode == "embedded" and embedded_python_dir:
            console_bat = find_python_console_bat(embedded_python_dir)
            if console_bat:
                return [os.environ.get("COMSPEC", "cmd.exe"), "/K", str(console_bat)]

        shell_pref = os.environ.get("SPOONFEEDER_TERMINAL_SHELL") or os.environ.get("FILE_MANAGER_WINDOWS_TERMINAL_SHELL", "")
        if shell_pref.lower() in {"powershell", "pwsh"}:
            powershell = shutil.which("pwsh") or shutil.which("powershell") or "powershell.exe"
            return [powershell, "-NoLogo", "-NoProfile"]

        return [os.environ.get("COMSPEC", "cmd.exe"), "/Q"]

    zsh = shutil.which("zsh")
    if zsh:
        return [zsh, "-il"]
    shell = os.environ.get("SHELL") or shutil.which("bash") or "/bin/sh"
    return [shell, "-il"]


def _capture_script_environment(script_path: Path, base_env: dict[str, str]) -> dict[str, str]:
    """setenv.bat または setenv.sh を一時実行して差分環境変数を抽出する"""
    extracted: dict[str, str] = {}
    try:
        if os.name == "nt":
            cmd = f'cmd.exe /c "call "{script_path}" && set"'
            result = subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                cwd=str(script_path.parent),
                env=base_env,
                timeout=10,
            )
        else:
            # パスはシェル文字列へ埋め込まず、位置引数($1)として渡す。
            result = subprocess.run(
                [shutil.which("zsh") or "/bin/sh", "-c", 'source "$1" && env', "_", str(script_path)],
                capture_output=True,
                text=True,
                cwd=str(script_path.parent),
                env=base_env,
                timeout=10,
            )

        if result.returncode == 0 and result.stdout:
            for line in result.stdout.splitlines():
                if "=" in line:
                    key, val = line.split("=", 1)
                    extracted[key.strip()] = val.strip()
    except Exception:
        pass
    return extracted


def build_environment(cwd: Path, mode: str, embedded_python_dir: str) -> dict[str, str]:
    """実行モードに基づいて最適化された環境変数を生成する"""
    env = os.environ.copy()
    paths: list[str] = []
    virtual_environment = ""

    if mode == "embedded" and embedded_python_dir:
        embedded_path = Path(embedded_python_dir).expanduser()
        candidates_dirs = [embedded_path]
        if embedded_path.is_dir():
            candidates_dirs.append(embedded_path.parent)

        script_name = "setenv.bat" if os.name == "nt" else "setenv.sh"
        for d in candidates_dirs:
            script_file = d / script_name
            if script_file.exists() and script_file.is_file():
                diff_env = _capture_script_environment(script_file, env)
                if diff_env:
                    env.update(diff_env)
                break

        if embedded_path.is_dir():
            paths.append(str(embedded_path))
            for sub in embedded_path.iterdir():
                if sub.is_dir() and sub.name.lower().startswith("python"):
                    paths.append(str(sub))
                    break
        env.pop("VIRTUAL_ENV", None)
    else:
        venv_python = find_venv_python(cwd)
        if venv_python:
            paths.append(str(venv_python.parent))
            virtual_environment = str(venv_python.parent.parent)

    if paths:
        existing_path = env.get("PATH", "")
        env["PATH"] = os.pathsep.join(paths + ([existing_path] if existing_path else []))

    if virtual_environment:
        env["VIRTUAL_ENV"] = virtual_environment

    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("COLORTERM", "truecolor")
    return env


class ShellSession:
    """共通の非同期シェルセッション基底クラス"""

    local_echo = False

    def __init__(self, cwd: Path, env: dict[str, str], mode: str = "normal", embedded_python_dir: str = ""):
        self.cwd = cwd
        self.env = env
        self.mode = mode
        self.embedded_python_dir = embedded_python_dir

    async def start(self) -> None: raise NotImplementedError
    async def read(self) -> bytes: raise NotImplementedError
    async def write(self, data: str) -> None: raise NotImplementedError
    async def resize(self, cols: int, rows: int) -> None: return None
    async def terminate(self) -> None: raise NotImplementedError
    def decode(self, data: bytes) -> str: return data.decode("utf-8", errors="replace")


_PTY_LAUNCHER = (
    "import fcntl, os, sys, termios\n"
    "os.setsid()\n"
    "fcntl.ioctl(0, termios.TIOCSCTTY, 0)\n"
    "os.execvp(sys.argv[1], sys.argv[1:])\n"
)


def _descendant_pids(root_pid: int) -> list[int]:
    """root_pid の子孫プロセスのPID一覧（psの親子関係から取得。取得できなければ空）。"""
    try:
        listing = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    children: dict[int, list[int]] = {}
    for line in listing.splitlines():
        parts = line.split()
        if len(parts) == 2 and all(part.isdigit() for part in parts):
            children.setdefault(int(parts[1]), []).append(int(parts[0]))
    found: list[int] = []
    stack = [root_pid]
    while stack:
        for child in children.get(stack.pop(), []):
            found.append(child)
            stack.append(child)
    return found


class PosixPtySession(ShellSession):
    """macOS/Linux環境用 PTY シェルセッション"""

    def __init__(self, cwd: Path, env: dict[str, str], mode: str = "normal", embedded_python_dir: str = ""):
        super().__init__(cwd, env, mode, embedded_python_dir)
        self.master_fd: int | None = None
        self.process: subprocess.Popen[bytes] | None = None

    async def start(self) -> None:
        import pty
        self.master_fd, slave_fd = pty.openpty()
        cmd = shell_command(self.cwd, self.mode, self.embedded_python_dir)
        # PTYをシェルの制御端末にする(Ctrl+CのSIGINT配送・ジョブ制御・端末切断時のSIGHUPに必要)。
        # fork後のpreexec_fnはスレッド併用で危険なため、execする前に小さなランチャーで setsid + TIOCSCTTY を行う。
        self.process = subprocess.Popen(
            [sys.executable, "-c", _PTY_LAUNCHER, *cmd], stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
            cwd=self.cwd, env=self.env, close_fds=True,
        )
        os.close(slave_fd)

    async def read(self) -> bytes:
        """出力を1回分読む。イベントループのreaderで待つため、キャンセルしても出力を取りこぼさない。"""
        fd = self.master_fd
        if fd is None:
            return b""
        loop = asyncio.get_running_loop()
        future: asyncio.Future[bytes] = loop.create_future()

        def on_readable() -> None:
            loop.remove_reader(fd)
            try:
                data = os.read(fd, 8192)
            except OSError:  # スレーブ側が閉じられた(EIO)
                data = b""
            if not future.done():
                future.set_result(data)

        try:
            loop.add_reader(fd, on_readable)
        except (OSError, ValueError):
            return b""
        try:
            return await future
        finally:
            if self.master_fd is not None:
                loop.remove_reader(fd)

    async def write(self, data: str) -> None:
        if self.master_fd is not None:
            await asyncio.to_thread(os.write, self.master_fd, data.encode("utf-8"))

    async def resize(self, cols: int, rows: int) -> None:
        if self.master_fd is None: return
        import fcntl
        import termios
        size = struct.pack("HHHH", max(rows, 1), max(cols, 1), 0, 0)
        await asyncio.to_thread(fcntl.ioctl, self.master_fd, termios.TIOCSWINSZ, size)

    def _signal_group(self, sig: int) -> None:
        """シェルと、そこから起動された子プロセスを含むプロセスグループへシグナルを送る。"""
        if self.process is None:
            return
        try:
            os.killpg(self.process.pid, sig)  # ランチャーが setsid するため pgid == pid
        except (ProcessLookupError, PermissionError):
            pass

    def _close_master(self) -> None:
        if self.master_fd is not None:
            try:
                asyncio.get_running_loop().remove_reader(self.master_fd)
            except (RuntimeError, ValueError, OSError):
                pass
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None

    async def terminate(self) -> None:
        """端末を閉じる。対話シェルはSIGTERMを無視するため、端末切断と同じSIGHUPで終了させる。

        macOSでは制御端末を持つシェルが未読の出力を残したまま終了待ちになるため、SIGHUPの直後にマスター側を閉じる。
        2秒以内に終了しない場合、または処理がキャンセルされた場合でもSIGKILLで確実に停止する。
        """
        process = self.process
        # ジョブ制御で別プロセスグループになったバックグラウンドジョブも止めるため、先に子孫を控えておく。
        descendants = _descendant_pids(process.pid) if process and process.poll() is None else []
        try:
            if process and process.poll() is None:
                self._signal_group(signal.SIGHUP)
            self._close_master()
            if process and process.poll() is None:
                try:
                    await asyncio.wait_for(asyncio.to_thread(process.wait), timeout=2)
                except Exception:
                    pass
        finally:
            self._close_master()
            if process and process.poll() is None:
                self._signal_group(signal.SIGKILL)
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
            for pid in descendants:
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass


class WindowsPtySession(ShellSession):
    """Windows環境用 pywinpty (ConPTY / WinPTY) 非同期シェルセッション"""

    def __init__(self, cwd: Path, env: dict[str, str], mode: str = "normal", embedded_python_dir: str = ""):
        super().__init__(cwd, env, mode, embedded_python_dir)
        self.pty_process: Any = None
        self.queue: asyncio.Queue[bytes] | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.thread: threading.Thread | None = None
        self.stopped = False

    async def start(self) -> None:
        from winpty import PtyProcess
        cmd = shell_command(self.cwd, self.mode, self.embedded_python_dir)
        self.loop = asyncio.get_running_loop()
        self.queue = asyncio.Queue()
        self.stopped = False
        self.pty_process = await asyncio.to_thread(
            PtyProcess.spawn,
            cmd,
            cwd=str(self.cwd),
            env=self.env,
            dimensions=(28, 100),
        )
        self.thread = threading.Thread(target=self._reader_thread, daemon=True)
        self.thread.start()

    def _reader_thread(self) -> None:
        while not self.stopped and self.pty_process and self.pty_process.isalive():
            try:
                data = self.pty_process.read()
                if not data:
                    break
                if self.loop and self.loop.is_running() and self.queue:
                    self.loop.call_soon_threadsafe(
                        self.queue.put_nowait,
                        data.encode("utf-8", errors="replace")
                    )
            except (EOFError, OSError, Exception):
                break
        if self.loop and self.loop.is_running() and self.queue:
            self.loop.call_soon_threadsafe(self.queue.put_nowait, b"")

    async def read(self) -> bytes:
        if self.queue is None:
            return b""
        return await self.queue.get()

    async def write(self, data: str) -> None:
        if self.pty_process is not None:
            try:
                await asyncio.to_thread(self.pty_process.write, data)
            except Exception:
                pass

    async def resize(self, cols: int, rows: int) -> None:
        if self.pty_process is not None:
            try:
                await asyncio.to_thread(self.pty_process.setwinsize, max(rows, 1), max(cols, 1))
            except Exception:
                pass

    async def terminate(self) -> None:
        self.stopped = True
        if self.pty_process is not None:
            try:
                await asyncio.to_thread(self.pty_process.terminate, True)
            except Exception:
                pass
            self.pty_process = None


class PipeSession(ShellSession):
    """PTYが使用できない環境向けのパイプフォールバック"""

    local_echo = True

    def __init__(self, cwd: Path, env: dict[str, str], mode: str = "normal", embedded_python_dir: str = ""):
        super().__init__(cwd, env, mode, embedded_python_dir)
        self.process: subprocess.Popen[bytes] | None = None
        self.encoding = locale.getpreferredencoding(False) or "utf-8"
        self.decoder = codecs.getincrementaldecoder(self.encoding)(errors="replace")

    async def start(self) -> None:
        cmd = shell_command(self.cwd, self.mode, self.embedded_python_dir)
        self.process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=self.cwd,
            env=self.env,
            bufsize=0,
        )

    async def read(self) -> bytes:
        if not self.process or not self.process.stdout:
            return b""
        try:
            read1 = getattr(self.process.stdout, "read1", None)
            if callable(read1):
                return await asyncio.to_thread(read1, 4096)
            return await asyncio.to_thread(self.process.stdout.read, 1)
        except Exception:
            return b""

    async def write(self, data: str) -> None:
        if self.process and self.process.stdin:
            try:
                normalized = data.replace("\r\n", "\n").replace("\r", "\n")
                if os.name == "nt":
                    normalized = normalized.replace("\n", "\r\n")
                self.process.stdin.write(normalized.encode(self.encoding, errors="replace"))
                self.process.stdin.flush()
            except Exception:
                pass

    async def terminate(self) -> None:
        if self.process and self.process.poll() is None:
            try:
                self.process.terminate()
            except Exception:
                pass
        self.process = None

    def decode(self, data: bytes) -> str:
        return self.decoder.decode(data)


def create_session(cwd: Path, env: dict[str, str], mode: str = "normal", embedded_python_dir: str = "") -> ShellSession:
    """環境に応じて最適なシェルセッションインスタンスを生成する"""
    if platform.system() != "Windows":
        return PosixPtySession(cwd, env, mode, embedded_python_dir)
    if importlib.util.find_spec("winpty") is not None:
        return WindowsPtySession(cwd, env, mode, embedded_python_dir)
    return PipeSession(cwd, env, mode, embedded_python_dir)


@router.websocket("/terminal/ws")
async def terminal_websocket(
    websocket: WebSocket,
    cwd: str = ".",
    mode: str = "normal",
    embedded_python_dir: str = ""
):
    """WebSocket経由で対話型ターミナルセッションを提供するエンドポイント"""
    if not is_allowed_websocket_origin(websocket.headers.get("origin"), websocket.headers.get("host")):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    working = Path(cwd).expanduser().resolve()
    if not working.is_dir():
        working = Path.cwd()

    env = build_environment(working, mode, embedded_python_dir)
    session = create_session(working, env, mode=mode, embedded_python_dir=embedded_python_dir)

    try:
        await session.start()
    except Exception as exc:
        if platform.system() == "Windows" and not isinstance(session, PipeSession):
            session = PipeSession(working, env, mode=mode, embedded_python_dir=embedded_python_dir)
            try:
                await session.start()
            except Exception as fallback:
                await websocket.send_json({"type": "error", "data": str(fallback)})
                await websocket.close()
                return
        else:
            await websocket.send_json({"type": "error", "data": str(exc)})
            await websocket.close()
            return

    cmd = shell_command(working, mode=mode, embedded_python_dir=embedded_python_dir)
    console_bat = find_python_console_bat(embedded_python_dir)
    if mode == "embedded" and console_bat:
        shell_label = "python_console.bat"
    else:
        shell_label = Path(cmd[0]).name

    await websocket.send_json({
        "type": "ready",
        "cwd": str(working),
        "shell": shell_label,
        "localEcho": session.local_echo,
    })

    async def pump() -> None:
        try:
            while True:
                chunk = await session.read()
                if not chunk:
                    break
                await websocket.send_json({"type": "output", "data": session.decode(chunk)})
        except Exception:
            pass

    output_task = asyncio.create_task(pump())
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                message = {"type": "input", "data": raw}

            if message.get("type") == "resize":
                await session.resize(int(message.get("cols", 100)), int(message.get("rows", 28)))
            elif message.get("type") == "input":
                await session.write(str(message.get("data", "")))
    except WebSocketDisconnect:
        pass
    finally:
        output_task.cancel()
        await session.terminate()
