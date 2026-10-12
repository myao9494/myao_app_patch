"""
ゴミ箱移動・ネットワークドライブ判定・ファイルロック検出

- move_to_trash: Windowsは SHFileOperationW（Explorerと同じゴミ箱移動）、それ以外は send2trash を使う
- trash_with_retry: Windowsで一時的なロック（Excel等）が残るケースを短いリトライで吸収する
- is_network_path: 本当にネットワーク上にあるパスだけを True にする
    - Windows: UNCパス、または GetDriveTypeW が DRIVE_REMOTE のドライブ（ローカルの D: 等は False）
    - macOS/Linux: マウントテーブルのファイルシステム種別が smbfs/afpfs/nfs/cifs 等のもの
      （USBメモリ等の外付けローカルディスクは False）
    - 判定できない場合は False（＝ゴミ箱へ移動する安全側）
- get_locking_processes: Restart Manager API でファイルをロックしているプロセスを取得（Windows専用）
- kill_processes: ユーザーが同意したプロセスを終了する
- delete_permanently: ネットワークドライブ上でユーザーが削除を指示した場合のみ使う完全削除
"""
from __future__ import annotations

import os
import platform
import re
import shutil
import signal
import stat
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from app.config import settings

WINDOWS_DELETE_RETRY_COUNT = 10
WINDOWS_DELETE_RETRY_BASE_SECONDS = 0.2
WINDOWS_DELETE_RETRY_MAX_SECONDS = 1.0

# ネットワークファイルシステムとして扱うマウント種別
NETWORK_FS_TYPES = frozenset({
    "smbfs", "afpfs", "nfs", "nfs4", "cifs", "smb3", "smb2", "webdav", "davfs",
    "fuse.sshfs", "sshfs", "osxfuse", "macfuse", "fuse.rclone", "ncpfs", "9p",
})

MOUNT_TABLE_TTL_SECONDS = 30.0
_mount_table_lock = threading.Lock()
_mount_table_cache: tuple[float, list[tuple[str, str]]] | None = None

DRIVE_REMOTE = 4


# ---------------------------------------------------------
# ネットワークドライブ判定
# ---------------------------------------------------------
def _unescape_proc_mount_field(value: str) -> str:
    """/proc/mounts の8進エスケープ（\\040 = 空白など）を戻す。"""
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), value)


def parse_proc_mounts(text: str) -> list[tuple[str, str]]:
    """Linux の /proc/self/mounts を (マウントポイント, 種別) のリストにする。"""
    mounts: list[tuple[str, str]] = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 3:
            mounts.append((_unescape_proc_mount_field(parts[1]), parts[2].lower()))
    return mounts


_MACOS_MOUNT_LINE = re.compile(r"^.+? on (?P<mount>.+) \((?P<fstype>[^,)]+)")


def parse_macos_mount_output(text: str) -> list[tuple[str, str]]:
    """macOS の `mount` コマンド出力を (マウントポイント, 種別) のリストにする。"""
    mounts: list[tuple[str, str]] = []
    for line in text.splitlines():
        match = _MACOS_MOUNT_LINE.match(line.strip())
        if match:
            mounts.append((match.group("mount"), match.group("fstype").strip().lower()))
    return mounts


def _read_mount_table() -> list[tuple[str, str]]:
    """OSのマウントテーブルを読む。失敗時は空リスト（＝すべてローカル扱い）。"""
    try:
        if platform.system() == "Linux":
            with open("/proc/self/mounts", encoding="utf-8", errors="replace") as f:
                return parse_proc_mounts(f.read())
        if platform.system() == "Darwin":
            result = subprocess.run(
                ["/sbin/mount"], capture_output=True, text=True, timeout=3, check=False
            )
            return parse_macos_mount_output(result.stdout)
    except (OSError, subprocess.SubprocessError):
        pass
    return []


def _get_mount_table() -> list[tuple[str, str]]:
    """マウントテーブルを短時間キャッシュして返す。"""
    global _mount_table_cache
    now = time.monotonic()
    with _mount_table_lock:
        if _mount_table_cache and now - _mount_table_cache[0] < MOUNT_TABLE_TTL_SECONDS:
            return _mount_table_cache[1]
    table = _read_mount_table()
    with _mount_table_lock:
        _mount_table_cache = (now, table)
    return table


def find_mount_fstype(path_str: str, mounts: list[tuple[str, str]]) -> Optional[str]:
    """パスを含む最も深いマウントポイントの種別を返す。"""
    best: tuple[int, str] | None = None
    for mount_point, fstype in mounts:
        mp = mount_point.rstrip("/") or "/"
        if path_str == mp or path_str.startswith(mp if mp == "/" else mp + "/"):
            if best is None or len(mp) > best[0]:
                best = (len(mp), fstype)
    return best[1] if best else None


def _windows_drive_type(drive_root: str) -> int:
    import ctypes

    try:
        return int(ctypes.windll.kernel32.GetDriveTypeW(drive_root))
    except Exception:
        return 0


def is_network_path(path: Path | str) -> bool:
    """パスがネットワーク上のファイルシステムにあるかを判定する（不明時は False）。"""
    path_str = str(path)

    if settings.is_windows:
        if path_str.startswith(("\\\\", "//")):
            return True
        if len(path_str) >= 2 and path_str[1] == ":" and path_str[0].isalpha():
            return _windows_drive_type(f"{path_str[0].upper()}:\\") == DRIVE_REMOTE
        return False

    try:
        real = os.path.realpath(path_str)
    except (OSError, ValueError):
        real = os.path.abspath(path_str)
    fstype = find_mount_fstype(real, _get_mount_table())
    return fstype in NETWORK_FS_TYPES if fstype else False


# ---------------------------------------------------------
# ゴミ箱移動
# ---------------------------------------------------------
def _move_to_trash_windows(path_str: str) -> None:
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", wintypes.UINT),
            ("pFrom", wintypes.LPCWSTR),
            ("pTo", wintypes.LPCWSTR),
            ("fFlags", wintypes.WORD),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", wintypes.LPVOID),
            ("lpszProgressTitle", wintypes.LPCWSTR),
        ]

    FO_DELETE = 3
    FOF_ALLOWUNDO = 0x0040       # ゴミ箱に移動
    FOF_NOCONFIRMATION = 0x0010  # 確認ダイアログ非表示
    FOF_NOERRORUI = 0x0400       # エラーUI非表示
    FOF_SILENT = 0x0004          # 進捗UI非表示

    op = SHFILEOPSTRUCTW()
    op.hwnd = None
    op.wFunc = FO_DELETE
    op.pFrom = str(Path(path_str).resolve()) + "\0\0"
    op.pTo = None
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT
    op.fAnyOperationsAborted = False
    op.hNameMappings = None
    op.lpszProgressTitle = None

    result = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if result != 0:
        raise OSError(f"SHFileOperationW failed with error code {result}")
    if op.fAnyOperationsAborted:
        raise OSError("File deletion was aborted by user or system")


def move_to_trash(path_str: str) -> None:
    """ファイル/フォルダをゴミ箱へ移動する（フォルダは階層を保ったまま丸ごと）。"""
    if settings.is_windows:
        _move_to_trash_windows(path_str)
        return
    from send2trash import send2trash

    send2trash(path_str)


def clear_windows_readonly(path: Path) -> None:
    """Windowsの読み取り専用属性を外す（削除・置換の失敗を防ぐ）。"""
    if not settings.is_windows:
        return
    try:
        path.chmod(path.stat().st_mode | stat.S_IWRITE)
    except OSError:
        pass


def trash_with_retry(path: Path) -> None:
    """
    ゴミ箱への移動を行う。Windowsでは一時的なロックを想定して最大約8秒リトライする。
    失敗した場合は例外を送出する（完全削除へのフォールバックは絶対にしない）。
    """
    retry_count = WINDOWS_DELETE_RETRY_COUNT if settings.is_windows else 1
    for attempt in range(retry_count):
        try:
            clear_windows_readonly(path)
            move_to_trash(str(path))
            return
        except OSError:
            if attempt == retry_count - 1:
                raise
            time.sleep(min(
                WINDOWS_DELETE_RETRY_BASE_SECONDS * (attempt + 1),
                WINDOWS_DELETE_RETRY_MAX_SECONDS,
            ))


# ---------------------------------------------------------
# 完全削除（ネットワークドライブ上でユーザーが削除を指示した場合のみ）
# ---------------------------------------------------------
def _rmtree_retry_readonly(func, path_str, exc):
    """Windowsでreadonlyが原因のrmtree失敗を再試行する（shutil.rmtree の onexc 用）"""
    if isinstance(exc, tuple):  # onerror 互換（exc_info）
        exc = exc[1]
    if not settings.is_windows or not isinstance(exc, PermissionError):
        raise exc
    clear_windows_readonly(Path(path_str))
    func(path_str)


def rmtree(path: Path) -> None:
    """読み取り専用属性にも対応したフォルダの完全削除（移動元の後片付けなどで使用）"""
    shutil.rmtree(path, onexc=_rmtree_retry_readonly)


def delete_permanently(
    path: Path,
    on_progress: Optional[Callable[[str], None]] = None,
    is_cancelled: Optional[Callable[[], bool]] = None,
) -> None:
    """
    ゴミ箱を使えないネットワークドライブ上の項目を完全削除する。
    フォルダは深い階層から1件ずつ削除し、進捗通知とキャンセルに対応する。
    """
    if path.is_symlink() or not path.is_dir():
        clear_windows_readonly(path)
        path.unlink()
        if on_progress:
            on_progress(path.name)
        return

    for root, dirs, files in os.walk(path, topdown=False):
        if is_cancelled and is_cancelled():
            raise InterruptedError("キャンセルされました")
        root_path = Path(root)
        for name in files:
            file_path = root_path / name
            clear_windows_readonly(file_path)
            file_path.unlink()
            if on_progress:
                on_progress(name)
        for name in dirs:
            dir_path = root_path / name
            if dir_path.is_symlink():
                dir_path.unlink()
            else:
                dir_path.rmdir()
    path.rmdir()


# ---------------------------------------------------------
# ロック検出・プロセス終了（Windows）
# ---------------------------------------------------------
def get_locking_processes(path_str: str) -> list[dict]:
    """Restart Manager API を使用して、ファイルをロックしているプロセスのリストを取得する(Windows専用)"""
    if not settings.is_windows:
        return []

    import ctypes
    from ctypes import wintypes

    try:
        rstrtmgr = ctypes.windll.rstrtmgr
    except AttributeError:
        return []

    class RM_UNIQUE_PROCESS(ctypes.Structure):
        _fields_ = [
            ("dwProcessId", wintypes.DWORD),
            ("ProcessStartTime", wintypes.FILETIME),
        ]

    class RM_PROCESS_INFO(ctypes.Structure):
        _fields_ = [
            ("Process", RM_UNIQUE_PROCESS),
            ("strAppName", wintypes.WCHAR * 256),
            ("strServiceShortName", wintypes.WCHAR * 63),
            ("ApplicationType", wintypes.DWORD),
            ("AppStatus", wintypes.ULONG),
            ("TSSessionId", wintypes.DWORD),
            ("bRestartable", wintypes.BOOL),
        ]

    session_handle = wintypes.DWORD()
    session_key = (wintypes.WCHAR * 256)()
    if rstrtmgr.RmStartSession(ctypes.byref(session_handle), 0, session_key) != 0:
        return []

    locking_processes: list[dict] = []
    try:
        paths = (wintypes.LPCWSTR * 1)(path_str)
        if rstrtmgr.RmRegisterResources(session_handle, 1, paths, 0, None, 0, None) != 0:
            return []
        needed = wintypes.DWORD(0)
        count = wintypes.DWORD(0)
        reboot_reasons = wintypes.DWORD(0)
        res = rstrtmgr.RmGetList(
            session_handle, ctypes.byref(needed), ctypes.byref(count), None, ctypes.byref(reboot_reasons)
        )
        if res == 234:  # ERROR_MORE_DATA
            count = needed
            infos = (RM_PROCESS_INFO * needed.value)()
            res = rstrtmgr.RmGetList(
                session_handle, ctypes.byref(needed), ctypes.byref(count), infos, ctypes.byref(reboot_reasons)
            )
            if res == 0:
                for i in range(count.value):
                    locking_processes.append({
                        "pid": infos[i].Process.dwProcessId,
                        "name": infos[i].strAppName,
                    })
    finally:
        rstrtmgr.RmEndSession(session_handle)

    return locking_processes


def kill_processes(pids: list[int]) -> None:
    """ユーザーが同意したPIDのプロセスを終了させる（Windows: TerminateProcess / POSIX: SIGKILL）"""
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM if settings.is_windows else signal.SIGKILL)
        except OSError:
            pass


def remove_tree_quietly(path: Path) -> None:
    """自分で作成した一時的なコピー先などを片付ける（失敗は無視）。"""
    try:
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.is_dir():
            rmtree(path)
    except OSError:
        pass
