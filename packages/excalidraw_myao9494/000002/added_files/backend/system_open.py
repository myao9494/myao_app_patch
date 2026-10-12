"""
OS 連携: ファイル・フォルダ・URL を既定アプリで開く、シェルコマンドを実行する
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

# macOS では PATH に code コマンドがなくても標準のアプリ配置から起動できる
MAC_VSCODE_EXECUTABLE = Path("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")


def is_windows() -> bool:
    return sys.platform.startswith("win")


def normalize_filepath(raw_path: Optional[str]) -> str:
    """前後の空白・ダブルクォートを除き、環境変数と ~ を展開する。"""
    if raw_path is None:
        return ""
    trimmed = raw_path.strip()
    if len(trimmed) >= 2 and trimmed.startswith('"') and trimmed.endswith('"'):
        trimmed = trimmed[1:-1]
    return os.path.expandvars(os.path.expanduser(trimmed))


def launch_with_system(path_or_url: str) -> None:
    """ファイル・フォルダ・URL を OS の既定ハンドラーで開く（完了まで待つ）。"""
    if is_windows():
        # UNC パスも含めて Windows の既定アプリに委譲
        os.startfile(path_or_url)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.run(["open", path_or_url], check=True)
    else:
        subprocess.run(["xdg-open", path_or_url], check=True)


def open_folder_in_file_manager(folder: Path) -> None:
    """フォルダを OS のファイルマネージャーで開く（終了を待たない）。"""
    if is_windows():
        subprocess.Popen(["explorer", str(folder)])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(folder)])
    else:
        subprocess.Popen(["xdg-open", str(folder)])


def find_vscode_executable() -> Optional[str]:
    """VS Code の code コマンドを探す。見つからなければ None。"""
    executable = shutil.which("code") or shutil.which("code.cmd")
    if not executable and sys.platform == "darwin" and MAC_VSCODE_EXECUTABLE.is_file():
        executable = str(MAC_VSCODE_EXECUTABLE)
    return executable


def strip_cmd_prefix(raw_command: Optional[str]) -> str:
    """図形リンクの `cmd <コマンド>` から先頭の `cmd` を取り除く。"""
    if raw_command is None:
        return ""
    trimmed = raw_command.strip()
    lower = trimmed.lower()
    if lower == "cmd":
        return ""
    if lower.startswith("cmd") and trimmed[3:4].isspace():
        return trimmed[3:].lstrip()
    return trimmed


def normalize_command_for_platform(command: str) -> str:
    """全角ダブルクォートを半角に、Windows では円記号をバックスラッシュに置き換える。"""
    if not command:
        return ""
    normalized = command.replace("＂", '"')
    if is_windows():
        normalized = normalize_windows_path_separators(normalized)
    return normalized


def normalize_windows_path_separators(text: str) -> str:
    """日本語環境で入力されがちな円記号（半角・全角）をバックスラッシュにする。"""
    return text.replace("¥", "\\").replace("￥", "\\")


def spawn_system_command(command: str, cwd: Optional[str] = None) -> subprocess.Popen:
    """シェル経由でコマンドを起動する（終了を待たない）。Windows では新しいコンソールで開く。"""
    if is_windows():
        creationflags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
        return subprocess.Popen(command, shell=True, cwd=cwd, creationflags=creationflags)

    default_shell = "/bin/zsh" if sys.platform == "darwin" else "/bin/bash"
    return subprocess.Popen(
        command,
        shell=True,
        executable=os.environ.get("SHELL") or default_shell,
        cwd=cwd,
        start_new_session=True,
    )


def spawn_detached(args: list[str]) -> subprocess.Popen:
    """アプリを起動し、このサーバーの終了に巻き込まないよう切り離す。"""
    return subprocess.Popen(args, start_new_session=True)
