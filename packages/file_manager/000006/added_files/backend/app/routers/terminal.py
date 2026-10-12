"""
WebSocket ターミナルルーター
- Windows: 既定で cmd.exe + パイプ実装、必要時のみ pywinpty を使用
- POSIX: pty を使用
- 管理者権限なしでも動作するように設計
"""
import asyncio
import codecs
import functools
import json
import locale
import os
import platform
import shutil
import struct
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi import APIRouter, WebSocket

from app.config import settings

router = APIRouter()


def should_use_winpty() -> bool:
    """Windows で pywinpty を明示利用するかどうかを返す"""
    value = os.environ.get("FILE_MANAGER_WINDOWS_TERMINAL_BACKEND", "").strip().lower()
    return value in {"winpty", "conpty", "pywinpty"}


def get_windows_shell() -> str:
    """Windows のターミナルシェル種別を返す"""
    value = os.environ.get("FILE_MANAGER_WINDOWS_TERMINAL_SHELL", "").strip().lower()
    if value in {"powershell", "pwsh"}:
        return "powershell"
    return "cmd"

def get_shell_command() -> list[str]:
    """実行する対話型シェルコマンドを返す"""
    if platform.system() == "Windows":
        if get_windows_shell() == "cmd":
            return [os.environ.get("COMSPEC", "cmd.exe"), "/Q"]
        powershell = shutil.which("pwsh") or shutil.which("powershell") or "powershell.exe"
        return [
            powershell,
            "-NoLogo",
            "-NoProfile",
            "-NoExit",
            "-Command",
            "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
        ]

    shell = os.environ.get("SHELL") or shutil.which("zsh") or shutil.which("bash") or "/bin/sh"
    return [shell, "-i"]

def resolve_terminal_cwd(raw_cwd: str | None) -> Path:
    """開始ディレクトリを決定し、不正または存在しない場合はデフォルトへフォールバックする"""
    if raw_cwd:
        # 文字列のクリーンアップ（引用符などの除去）
        raw_cwd = raw_cwd.strip("'\"")
        candidate = Path(raw_cwd).expanduser()
        if candidate.exists() and candidate.is_dir():
            return candidate

    return settings.start_dir


def _split_completion_token(line: str) -> tuple[str, str, str]:
    """補完対象のトークンを `先頭部分`, `トークン本体`, `引用符` に分解する"""
    in_quote = False
    quote_char = ""
    token_start = 0

    for index, char in enumerate(line):
        if char in {'"', "'"}:
            if in_quote and char == quote_char:
                in_quote = False
                quote_char = ""
            elif not in_quote:
                in_quote = True
                quote_char = char
        elif char.isspace() and not in_quote:
            token_start = index + 1

    prefix = line[:token_start]
    token = line[token_start:]
    token_quote = token[0] if token.startswith(("\"", "'")) else ""
    raw_token = token[1:] if token_quote else token
    return prefix, raw_token, token_quote


def _common_prefix(values: list[str], *, case_sensitive: bool) -> str:
    """候補一覧の共通接頭辞を返す"""
    if not values:
        return ""

    prefix = values[0]
    for value in values[1:]:
        matched: list[str] = []
        for left, right in zip(prefix, value):
            if left == right if case_sensitive else left.lower() == right.lower():
                matched.append(left)
            else:
                break
        prefix = "".join(matched)
        if not prefix:
            break
    return prefix


def build_completion_result(cwd: Path, line: str) -> dict[str, str]:
    """現在行に対するパス補完結果を返す"""
    prefix, token, token_quote = _split_completion_token(line)
    if not token:
        return {"append": "", "line": line}

    expanded = Path(token).expanduser()
    token_path = expanded if expanded.is_absolute() else cwd / expanded
    parent = token_path.parent if token_path.parent != Path("") else cwd
    fragment = token_path.name

    if not parent.exists() or not parent.is_dir():
        return {"append": "", "line": line}

    case_sensitive = os.name != "nt"
    entries = sorted(parent.iterdir(), key=lambda item: item.name.lower() if not case_sensitive else item.name)
    matches = [
        entry for entry in entries
        if (entry.name.startswith(fragment) if case_sensitive else entry.name.lower().startswith(fragment.lower()))
    ]

    if not matches:
        return {"append": "", "line": line}

    names = [entry.name for entry in matches]
    common_name = _common_prefix(names, case_sensitive=case_sensitive)
    if common_name == fragment and len(matches) != 1:
        return {"append": "", "line": line}

    target_entry = matches[0] if len(matches) == 1 else None
    completed_name = target_entry.name if target_entry is not None else common_name
    append = completed_name[len(fragment):]

    if target_entry is not None and target_entry.is_dir():
        append += os.sep

    completed_token = f"{token_quote}{raw}" if (raw := token + append) else ""
    return {
        "append": append,
        "line": f"{prefix}{completed_token}",
    }


def update_input_buffer(current_line: str, data: str) -> str:
    """入力されたキー列から現在行バッファを更新する"""
    if data == "\r":
        return ""
    if data == "\u007f":
        return current_line[:-1]
    if data == "\t":
        return current_line
    if data.startswith("\u001b"):
        return current_line
    return current_line + data


def resolve_next_terminal_cwd(current_cwd: Path, line: str) -> Path:
    """入力行が cd 系コマンドなら次のカレントディレクトリを推定する"""
    stripped = line.strip()
    if not stripped:
        return current_cwd

    lowered = stripped.lower()
    prefixes = ("cd ", "chdir ", "pushd ")
    if lowered in {"cd", "chdir"}:
        return current_cwd
    if not lowered.startswith(prefixes):
        return current_cwd

    parts = stripped.split(maxsplit=1)
    if len(parts) < 2:
        return current_cwd

    argument = parts[1].strip()
    if not argument:
        return current_cwd

    if argument.lower().startswith("/d "):
        argument = argument[3:].strip()

    argument = argument.strip("'\"")
    if not argument:
        return current_cwd

    candidate = Path(argument).expanduser()
    if not candidate.is_absolute():
        candidate = current_cwd / candidate

    try:
        resolved = candidate.resolve(strict=False)
    except Exception:
        resolved = candidate

    if resolved.exists() and resolved.is_dir():
        return resolved

    return current_cwd

class ShellProcess:
    """シェルプロセスとの入出力を抽象化する"""

    def __init__(self, cwd: Path):
        self.cwd = cwd
        self._reader_executor: ThreadPoolExecutor | None = None

    async def run_blocking_reader(self, func, *args) -> bytes:
        """Windows向けのブロッキング読み取りを接続専用スレッドで実行する。"""
        if self._reader_executor is None:
            self._reader_executor = ThreadPoolExecutor(
                max_workers=1,
                thread_name_prefix="file-manager-terminal-reader",
            )
        loop = asyncio.get_running_loop()
        call = functools.partial(func, *args)
        return await loop.run_in_executor(self._reader_executor, call)

    def shutdown_reader_executor(self) -> None:
        """接続専用Executorを待機せず閉じ、新規タスクの投入を止める。"""
        if self._reader_executor is not None:
            self._reader_executor.shutdown(wait=False, cancel_futures=True)
            self._reader_executor = None

    async def start(self) -> None:
        raise NotImplementedError

    async def read_chunk(self) -> bytes:
        raise NotImplementedError

    async def write_input(self, data: str) -> None:
        raise NotImplementedError

    async def resize(self, cols: int, rows: int) -> None:
        return None

    def decode_output(self, chunk: bytes) -> str:
        return chunk.decode("utf-8", errors="replace")

    async def wait(self) -> int:
        raise NotImplementedError

    async def terminate(self) -> None:
        raise NotImplementedError

class PtyShellProcess(ShellProcess):
    """POSIX環境向けPTYベースの対話型シェル"""

    def __init__(self, cwd: Path):
        super().__init__(cwd)
        self.master_fd: int | None = None
        self.process: subprocess.Popen | None = None

    async def start(self) -> None:
        import pty
        self.master_fd, slave_fd = pty.openpty()
        env = os.environ.copy()
        env.setdefault("TERM", "xterm-256color")

        self.process = subprocess.Popen(
            get_shell_command(),
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            cwd=self.cwd,
            env=env,
            close_fds=True,
        )
        os.close(slave_fd)

    async def read_chunk(self) -> bytes:
        if self.master_fd is None:
            return b""

        loop = asyncio.get_running_loop()
        future: asyncio.Future[bytes] = loop.create_future()
        master_fd = self.master_fd

        def read_ready() -> None:
            # EOFではFDが読み取り可能のままになるため、最初の通知で必ず解除する。
            loop.remove_reader(master_fd)
            try:
                chunk = os.read(master_fd, 4096)
            except OSError:
                chunk = b""
            if not future.done():
                future.set_result(chunk)

        loop.add_reader(master_fd, read_ready)
        try:
            return await future
        finally:
            loop.remove_reader(master_fd)

    async def write_input(self, data: str) -> None:
        if self.master_fd is None:
            return
        os.write(self.master_fd, data.encode("utf-8"))

    async def resize(self, cols: int, rows: int) -> None:
        if self.master_fd is None:
            return
        import fcntl
        import termios
        winsize = struct.pack("HHHH", max(rows, 1), max(cols, 1), 0, 0)
        fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, winsize)

    async def wait(self) -> int:
        if self.process is None:
            return 0
        while self.process.poll() is None:
            await asyncio.sleep(0.05)
        return int(self.process.returncode or 0)

    async def terminate(self) -> None:
        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.wait(), timeout=2)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.wait()
        self.shutdown_reader_executor()

class WinPtyShellProcess(ShellProcess):
    """Windows向け pywinpty ベースの対話型シェル"""

    def __init__(self, cwd: Path):
        super().__init__(cwd)
        self.pty: Any = None

    async def start(self) -> None:
        try:
            from winpty import PTY as PtyClass
        except ImportError:
            from winpty import Pty as PtyClass
            
        shell_cmd = get_shell_command()[0]
        # Jupyter Notebook のように、管理者権限なしでも安定して動作させるため、
        # WinPTY (backend=1) の使用を優先するか、ConPTYでエラーが出た場合は安全にフォールバックする
        try:
            self.pty = PtyClass(80, 24, backend=1) 
            self.pty.spawn(shell_cmd, cwd=str(self.cwd))
        except Exception as e:
            print(f"Failed to start with WinPTY, trying ConPTY: {e}")
            self.pty = PtyClass(80, 24, backend=0)
            self.pty.spawn(shell_cmd, cwd=str(self.cwd))

    async def read_chunk(self) -> bytes:
        if self.pty is None:
            return b""
        try:
            # readはブロックするためto_threadを使用
            data = await self.run_blocking_reader(self.pty.read, 4096)
            return data.encode("utf-8", errors="replace")
        except (EOFError, Exception):
            return b""

    async def write_input(self, data: str) -> None:
        if self.pty is None:
            return
        self.pty.write(str(data))

    async def resize(self, cols: int, rows: int) -> None:
        if self.pty is None:
            return
        try:
            c = max(int(cols), 1)
            r = max(int(rows), 1)
            self.pty.set_size(c, r)
        except Exception:
            pass

    async def wait(self) -> int:
        if self.pty is None:
            return 0
        while self.pty.isalive():
            await asyncio.sleep(0.1)
        return 0

    async def terminate(self) -> None:
        if self.pty:
            pty_instance = self.pty
            self.pty = None
            try:
                await asyncio.to_thread(pty_instance.close)
            except Exception:
                pass
        self.shutdown_reader_executor()

class PipeShellProcess(ShellProcess):
    """PTYが使えない場合のフォールバック（非推奨）"""

    def __init__(self, cwd: Path):
        super().__init__(cwd)
        self.process: subprocess.Popen | None = None
        if os.name == "nt" and get_windows_shell() == "cmd":
            self.encoding = locale.getpreferredencoding(False) or "utf-8"
            self.output_encoding = self.encoding
        else:
            self.encoding = "utf-8" if os.name == "nt" else (locale.getpreferredencoding(False) or "utf-8")
            self.output_encoding = self.encoding
        self.decoder = codecs.getincrementaldecoder(self.output_encoding)(errors="replace")

    async def start(self) -> None:
        self.process = subprocess.Popen(
            get_shell_command(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=self.cwd,
            text=False,
            bufsize=0
        )

    async def read_chunk(self) -> bytes:
        if not self.process or not self.process.stdout:
            return b""
        try:
            read1 = getattr(self.process.stdout, "read1", None)
            if callable(read1):
                return await self.run_blocking_reader(read1, 4096)
            return await self.run_blocking_reader(self.process.stdout.read, 1)
        except Exception:
            return b""

    async def write_input(self, data: str) -> None:
        if not self.process or not self.process.stdin:
            return
        try:
            normalized = str(data)
            if os.name == "nt":
                normalized = normalized.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")
            self.process.stdin.write(normalized.encode(self.encoding, errors="replace"))
            self.process.stdin.flush()
        except Exception:
            pass

    def decode_output(self, chunk: bytes) -> str:
        return self.decoder.decode(chunk)

    async def wait(self) -> int:
        if self.process is None:
            return 0
        while self.process.poll() is None:
            await asyncio.sleep(0.05)
        return int(self.process.returncode or 0)

    async def terminate(self) -> None:
        if self.process:
            try:
                if self.process.poll() is None:
                    self.process.terminate()
                    try:
                        await asyncio.wait_for(self.wait(), timeout=2)
                    except asyncio.TimeoutError:
                        self.process.kill()
                        await self.wait()
                # プロセス終了後なら、読み取り中スレッドをブロックせず閉じられる。
                if self.process.stdin:
                    self.process.stdin.close()
                if self.process.stdout:
                    self.process.stdout.close()
            except Exception:
                pass
        self.shutdown_reader_executor()

def create_shell_process(cwd: Path) -> ShellProcess:
    """環境に応じて最適なシェル実装を返す"""
    if platform.system() != "Windows":
        return PtyShellProcess(cwd)
    if should_use_winpty():
        try:
            import winpty # noqa
            return WinPtyShellProcess(cwd)
        except ImportError:
            print("Warning: pywinpty not found. Falling back to PipeShellProcess.")
    return PipeShellProcess(cwd)


def should_use_local_echo(shell: ShellProcess) -> bool:
    """クライアント側で入力文字をローカル描画すべきか判定する"""
    return isinstance(shell, PipeShellProcess)


def normalize_terminal_size(cols: object, rows: object) -> tuple[int, int]:
    """WebSocketから受け取った端末サイズを安全な整数範囲へ正規化する。"""
    try:
        normalized_cols = int(cols) if cols is not None else 80
    except (TypeError, ValueError, OverflowError):
        normalized_cols = 80
    try:
        normalized_rows = int(rows) if rows is not None else 24
    except (TypeError, ValueError, OverflowError):
        normalized_rows = 24
    return (
        max(1, min(normalized_cols, 1_000)),
        max(1, min(normalized_rows, 1_000)),
    )


async def terminate_shell_safely(shell: ShellProcess) -> None:
    """不調なシェルの終了処理がWebSocketハンドラを永続的に止めないようにする。"""
    try:
        await asyncio.wait_for(shell.terminate(), timeout=3)
    except (asyncio.TimeoutError, Exception):
        shell.shutdown_reader_executor()

@router.websocket("/terminal/ws")
async def terminal_websocket(websocket: WebSocket, cwd: str | None = None):
    """WebSocket経由で対話型ターミナルを提供する"""
    await websocket.accept()

    resolved_cwd = resolve_terminal_cwd(cwd)
    current_cwd = resolved_cwd
    input_buffer = ""
    shell = create_shell_process(resolved_cwd)
    try:
        await shell.start()
        await websocket.send_json({
            "type": "ready",
            "localEcho": should_use_local_echo(shell),
            "cwd": str(current_cwd),
        })
    except Exception as e:
        if platform.system() == "Windows" and not isinstance(shell, PipeShellProcess):
            await terminate_shell_safely(shell)
            shell = PipeShellProcess(resolved_cwd)
            try:
                await shell.start()
                await websocket.send_json({
                    "type": "ready",
                    "localEcho": should_use_local_echo(shell),
                    "cwd": str(current_cwd),
                })
            except Exception as fallback_error:
                await terminate_shell_safely(shell)
                try:
                    await websocket.send_json({"type": "output", "data": f"\r\nError starting shell: {str(fallback_error)}\r\n"})
                    await websocket.close()
                except Exception:
                    pass
                return
        else:
            await terminate_shell_safely(shell)
            try:
                await websocket.send_json({"type": "output", "data": f"\r\nError starting shell: {str(e)}\r\n"})
                await websocket.close()
            except Exception:
                pass
            return

    async def forward_output():
        try:
            while True:
                chunk = await shell.read_chunk()
                if not chunk:
                    break
                try:
                    await websocket.send_json({
                        "type": "output",
                        "data": shell.decode_output(chunk),
                    })
                except Exception:
                    break
            # 通常のシェル終了なら終了コードを通知する。読み取りだけが壊れた場合は
            # 短時間で諦め、外側の後始末へ進んでフリーズを防ぐ。
            try:
                exit_code = await asyncio.wait_for(shell.wait(), timeout=0.2)
            except asyncio.TimeoutError:
                return
            try:
                await websocket.send_json({"type": "exit", "code": exit_code})
            except Exception:
                pass
        except asyncio.CancelledError:
            raise
        except Exception:
            pass

    async def receive_input():
        nonlocal current_cwd, input_buffer
        try:
            while True:
                message = await websocket.receive_text()
                if not message:
                    continue
                try:
                    payload = json.loads(message)
                except Exception:
                    continue
                if not isinstance(payload, dict):
                    continue
                
                m_type = payload.get("type")
                if m_type == "input":
                    data = payload.get("data", "")
                    if not isinstance(data, str):
                        continue
                    await shell.write_input(data)
                    if data == "\r":
                        next_cwd = resolve_next_terminal_cwd(current_cwd, input_buffer)
                        input_buffer = ""
                        if next_cwd != current_cwd:
                            current_cwd = next_cwd
                            await websocket.send_json({
                                "type": "cwd",
                                "cwd": str(current_cwd),
                            })
                    else:
                        input_buffer = update_input_buffer(input_buffer, data)
                elif m_type == "complete":
                    line = payload.get("line", "")
                    if not isinstance(line, str):
                        continue
                    try:
                        result = await asyncio.wait_for(
                            asyncio.to_thread(build_completion_result, current_cwd, line),
                            timeout=2,
                        )
                    except asyncio.TimeoutError:
                        result = {"append": "", "line": line}
                    await websocket.send_json({
                        "type": "completion",
                        "append": result["append"],
                        "line": result["line"],
                    })
                elif m_type == "resize":
                    cols, rows = normalize_terminal_size(
                        payload.get("cols", 80),
                        payload.get("rows", 24),
                    )
                    await shell.resize(cols, rows)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass

    output_task = asyncio.create_task(forward_output())
    input_task = asyncio.create_task(receive_input())

    try:
        await asyncio.wait([output_task, input_task], return_when=asyncio.FIRST_COMPLETED)
    except Exception:
        pass
    finally:
        output_task.cancel()
        input_task.cancel()
        await terminate_shell_safely(shell)
        try:
            await asyncio.gather(output_task, input_task, return_exceptions=True)
        except asyncio.CancelledError:
            # WebSocket切断時はStarlette側からハンドラ自体もキャンセルされ得る。
            pass
        try:
            await websocket.close()
        except Exception:
            pass
