"""
デスクトップランチャープロセスの起動・停止・再起動・ログ取得を管理する。

【仕様】
- Windows は発行済み WPF 版（通常版 → single-file 版）だけを起動する。どちらも無ければ起動せず、
  発行手順（publish.ps1）を含む理由を `last_error` とログへ残す（Python / Flet 版は廃止）。
- macOS は Python の Cocoa 版（`python -m launcher_app.main`）を PYTHONPATH 付きで起動する。
"""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Callable, Literal

from app.config import PROJECT_ROOT_DIR, settings


LauncherStatus = Literal["running", "stopped", "exited"]


class LauncherManager:
    """
    FastAPI プロセス配下でランチャーを子プロセスとして管理する。
    """

    def __init__(
        self,
        *,
        wpf_resolver: Callable[[], Path | None] | None = None,
        platform_name: str | None = None,
    ) -> None:
        self.process: subprocess.Popen[str] | None = None
        self.log_path = settings.launcher_log_path
        self.launcher_src = PROJECT_ROOT_DIR / "launcher" / "src"
        self.python_executable = _resolve_launcher_python()
        self._wpf_resolver = wpf_resolver or _resolve_wpf_launcher
        self.wpf_executable = self._wpf_resolver()
        self.platform_name = platform_name or sys.platform
        self.last_error: str | None = None

    def autostart_if_enabled(self) -> None:
        """
        設定が有効な場合だけランチャーを起動する。
        """
        if settings.launcher_autostart:
            self.start()

    def start(self) -> dict[str, object]:
        """
        未起動ならランチャーを起動し、現在状態を返す。
        """
        if self.is_running():
            return self.status()
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        existing_pythonpath = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = f"{self.launcher_src}{os.pathsep}{existing_pythonpath}" if existing_pythonpath else str(self.launcher_src)
        env.setdefault("LAUNCHER_API_BASE_URL", f"http://127.0.0.1:{settings.bind_port}")
        env.setdefault("LAUNCHER_WEB_BASE_URL", "http://127.0.0.1:8001")
        self.wpf_executable = self._wpf_resolver()
        command = self._launch_command()
        with self.log_path.open("a", encoding="utf-8") as log_file:
            log_file.write(f"\n--- launcher start {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
            log_file.flush()
            if command is None:
                self.process = None
                self.last_error = (
                    "WPF launcher is not published. Run launcher/windows/publish.ps1 "
                    "(or set SEARCH_APP_WPF_LAUNCHER_PATH)."
                )
                log_file.write(f"{self.last_error}\n")
                return self.status()
            try:
                self.process = subprocess.Popen(
                    command,
                    cwd=str(PROJECT_ROOT_DIR),
                    env=env,
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
                self.last_error = None
            except (OSError, subprocess.SubprocessError) as error:
                self.process = None
                self.last_error = f"Launcher process could not be started: {error}"
                log_file.write(f"{self.last_error}\n")
        return self.status()

    def _launch_command(self) -> list[str] | None:
        """
        起動コマンドを決める。WPF 版があればそれ、Windows で無ければ None（起動しない）、
        それ以外（macOS）は Python の Cocoa 版。
        """
        if self.wpf_executable is not None:
            return [str(self.wpf_executable)]
        if self.platform_name == "win32":
            return None
        return [self.python_executable, "-m", "launcher_app.main"]

    def stop(self) -> dict[str, object]:
        """
        起動中のランチャーへ終了要求を送り、短時間待ってから状態を返す。
        """
        if not self.is_running():
            return self.status()
        assert self.process is not None
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        return self.status()

    def restart(self) -> dict[str, object]:
        """
        ランチャーを停止してから再起動する。
        """
        self.stop()
        return self.start()

    def is_running(self) -> bool:
        """
        子プロセスが生存しているかを返す。
        """
        return self.process is not None and self.process.poll() is None

    def status(self) -> dict[str, object]:
        """
        UI 表示用の状態とログ末尾を返す。
        """
        returncode = self.process.poll() if self.process is not None else None
        status: LauncherStatus
        if self.is_running():
            status = "running"
        elif self.process is None:
            status = "stopped"
        else:
            status = "exited"
        return {
            "status": status,
            "is_running": status == "running",
            "pid": self.process.pid if self.process is not None and status == "running" else None,
            "returncode": returncode,
            "last_error": self.last_error,
            "autostart": settings.launcher_autostart,
            "log_path": str(self.log_path),
            "logs": self.read_logs(),
        }

    def read_logs(self, *, max_lines: int = 200) -> list[str]:
        """
        ランチャーログの末尾を返す。
        """
        if not self.log_path.exists():
            return []
        lines = self.log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        return lines[-max_lines:]


def _resolve_launcher_python() -> str:
    """
    ランチャー依存が入るプロジェクトルート .venv の Python を優先する。
    """
    candidate = PROJECT_ROOT_DIR / ".venv" / "bin" / "python"
    if candidate.exists():
        return str(candidate)
    windows_candidate = PROJECT_ROOT_DIR / ".venv" / "Scripts" / "python.exe"
    if windows_candidate.exists():
        return str(windows_candidate)
    return sys.executable


def _resolve_wpf_launcher() -> Path | None:
    """
    Windowsでは発行済みWPF版を通常フォルダ版、単一EXE版の順に選ぶ。
    """
    if sys.platform != "win32":
        return None
    explicit_path = os.getenv("SEARCH_APP_WPF_LAUNCHER_PATH", "").strip()
    candidates = [
        Path(explicit_path) if explicit_path else None,
        PROJECT_ROOT_DIR / "launcher" / "windows" / "publish" / "folder" / "LocalSearchLauncher.exe",
        PROJECT_ROOT_DIR / "launcher" / "windows" / "publish" / "single-file" / "LocalSearchLauncher.exe",
    ]
    return next((path.resolve() for path in candidates if path is not None and path.is_file()), None)
