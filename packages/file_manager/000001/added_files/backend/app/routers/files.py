"""
ファイル操作APIルーター
- ファイル一覧取得
- ファイル検索（Liveモード）
- ファイル操作（コピー、移動、削除、リネーム）

注: インデックス検索は外部サービス（file_index_service）に移行
"""
import fnmatch
import hashlib
import html
import zipfile
import threading
import queue
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple, Dict
import webbrowser
import urllib.parse

from fastapi import APIRouter, HTTPException, Query, BackgroundTasks, Request
from fastapi.responses import FileResponse, RedirectResponse, Response, HTMLResponse
from pydantic import BaseModel

import os
import io
import shutil
import platform
import subprocess
import ctypes
import struct
import stat
import time

from app.config import get_editor_preferences, settings
from app.task_manager import task_manager, TaskInfo

router = APIRouter()

# ターミナルの長時間待機処理と分離し、PTY接続が増えてもファイルAPIを応答可能に保つ。
FILE_IO_EXECUTOR = ThreadPoolExecutor(
    max_workers=max(4, min(settings.file_io_workers, 64)),
    thread_name_prefix="file-manager-io",
)

WINDOWS_DELETE_RETRY_COUNT = 10
WINDOWS_DELETE_RETRY_BASE_SECONDS = 0.2
WINDOWS_DELETE_RETRY_MAX_SECONDS = 1.0


class FileItem(BaseModel):
    """ファイル/フォルダアイテムのスキーマ"""

    name: str
    type: str  # "file" or "directory"
    path: str
    size: Optional[int] = None
    modified: Optional[str] = None


class DirectoryResponse(BaseModel):
    """ディレクトリ一覧のレスポンススキーマ"""

    type: str = "directory"
    path: str
    items: List[FileItem]


class FolderLatestModifiedRequest(BaseModel):
    """フォルダ配下の最新更新日時を求めるリクエスト"""

    path: str


class FolderLatestModifiedResponse(BaseModel):
    """フォルダ配下の最新更新日時の集計結果"""

    path: str
    modified: str
    scanned_entries: int
    truncated: bool = False


class GitFolderStatusesRequest(BaseModel):
    """ペイン内フォルダのGit状態を一括取得するリクエスト"""

    paths: List[str]


class GitFolderStatusItem(BaseModel):
    """フォルダ単位のGit変更有無"""

    path: str
    has_changes: bool
    changed_files: List[str] = []
    has_more_changes: bool = False
    ahead_count: int = 0
    behind_count: int = 0


class GitFolderStatusesResponse(BaseModel):
    """Git変更有無の一括取得結果"""

    items: List[GitFolderStatusItem]


class SearchResponse(BaseModel):
    """検索結果のレスポンススキーマ"""

    query: str
    path: str
    depth: int
    total: int
    items: List[FileItem]


class ObsidianPathResponse(BaseModel):
    """Obsidianパスレスポンスのスキーマ"""

    path: str


def _is_recursive_symlink_target(path_str: str, search_root: str) -> bool:
    """
    ベース配下を指すシンボリックリンクを検出する。

    再帰探索や一覧表示で同一ツリーへ戻るリンクを辿ると、
    大量走査やループの原因になるため除外する。
    """
    try:
        resolved = str(Path(path_str).resolve(strict=True))
    except (OSError, RuntimeError):
        return True
    return resolved.startswith(search_root)


def _bring_explorer_to_front(process_id: int, target_path: Path) -> None:
    """
    Windowsで起動したExplorerウィンドウを前面に出すことを試みる。

    Windowsのフォアグラウンド制御制限により必ず成功する保証はないが、
    起動直後の数回リトライでユーザー体感を改善する。
    """
    if platform.system() != "Windows":
        return

    def worker() -> None:
        try:
            user32 = ctypes.windll.user32
            kernel32 = ctypes.windll.kernel32
        except Exception:
            return

        target_name = target_path.name.lower()
        shell_window = user32.GetShellWindow()

        def try_focus_window(hwnd: int) -> bool:
            if not hwnd or hwnd == shell_window:
                return False
            if not user32.IsWindowVisible(hwnd):
                return False

            class_name_buffer = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, class_name_buffer, len(class_name_buffer))
            class_name = class_name_buffer.value
            if class_name not in {"CabinetWClass", "ExploreWClass"}:
                return False

            window_text_buffer = ctypes.create_unicode_buffer(512)
            user32.GetWindowTextW(hwnd, window_text_buffer, len(window_text_buffer))
            window_title = window_text_buffer.value.lower()

            window_process_id = ctypes.c_ulong()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(window_process_id))

            if (
                window_process_id.value != process_id
                and target_name
                and target_name not in window_title
            ):
                return False
            return _focus_window_handle(user32, kernel32, hwnd, restore_minimized=True)

        for _ in range(10):
            focused = False

            @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
            def enum_windows_proc(hwnd, _lparam):
                nonlocal focused
                if focused:
                    return False
                focused = try_focus_window(hwnd)
                return not focused

            try:
                user32.EnumWindows(enum_windows_proc, 0)
            except Exception:
                return

            if focused:
                return
            time.sleep(0.2)

    threading.Thread(target=worker, daemon=True).start()


def _schedule_macos_obsidian_activation() -> None:
    """
    macOSでObsidianを少し遅らせて前面化する。

    ブラウザで /api/fullpath を開いた直後は、レスポンス描画でブラウザが
    再度アクティブになることがあるため、Obsidian URI 起動後に短い遅延を
    入れてアプリをactivateする。
    """
    subprocess.Popen([
        "/bin/sh",
        "-c",
        "sleep 0.35; /usr/bin/osascript -e 'tell application \"Obsidian\" to activate'",
    ])


def _bring_obsidian_to_front() -> None:
    """
    Obsidianウィンドウを前面に出すことを試みる。

    obsidian:// 起動では既存のObsidianウィンドウが別デスクトップに残ることがあるため、
    起動直後にタイトルからObsidianウィンドウを探して前面化を数回リトライする。
    """
    if platform.system() == "Darwin":
        _schedule_macos_obsidian_activation()
        return

    if platform.system() != "Windows":
        return

    def worker() -> None:
        try:
            user32 = ctypes.windll.user32
            kernel32 = ctypes.windll.kernel32
        except Exception:
            return

        shell_window = user32.GetShellWindow()
        title_keywords = ("obsidian",)

        def try_focus_window(hwnd: int) -> bool:
            if not hwnd or hwnd == shell_window:
                return False
            if not user32.IsWindowVisible(hwnd):
                return False

            title_buffer = ctypes.create_unicode_buffer(512)
            user32.GetWindowTextW(hwnd, title_buffer, len(title_buffer))
            window_title = title_buffer.value.lower()
            if not window_title or not any(keyword in window_title for keyword in title_keywords):
                return False
            return _focus_window_handle(user32, kernel32, hwnd, restore_minimized=True)

        for _ in range(15):
            focused = False

            @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
            def enum_windows_proc(hwnd, _lparam):
                nonlocal focused
                if focused:
                    return False
                focused = try_focus_window(hwnd)
                return not focused

            try:
                user32.EnumWindows(enum_windows_proc, 0)
            except Exception:
                return

            if focused:
                return
            time.sleep(0.2)

    threading.Thread(target=worker, daemon=True).start()


def _focus_window_handle(user32, kernel32, hwnd: int, restore_minimized: bool) -> bool:
    """
    Windowsウィンドウを前面化する。

    非最小化ウィンドウに SW_RESTORE を送ると最大化や全画面状態が崩れることがあるため、
    最小化時だけ復元して、それ以外は前面化のみ行う。
    """
    if not hwnd or not user32.IsWindowVisible(hwnd):
        return False

    current_thread_id = kernel32.GetCurrentThreadId()
    window_thread_id = user32.GetWindowThreadProcessId(hwnd, None)
    attached = False
    if window_thread_id and window_thread_id != current_thread_id:
        attached = bool(user32.AttachThreadInput(current_thread_id, window_thread_id, True))

    try:
        is_iconic = bool(getattr(user32, "IsIconic", lambda _hwnd: False)(hwnd))
        if restore_minimized and is_iconic:
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        user32.BringWindowToTop(hwnd)
        return bool(user32.SetForegroundWindow(hwnd))
    finally:
        if attached:
            user32.AttachThreadInput(current_thread_id, window_thread_id, False)


# ---------------------------------------------------------
# NASパス変換設定
# ---------------------------------------------------------
async def run_with_timeout(func, *args, **kwargs):
    """
    同期関数をスレッドプールで実行し、設定されたタイムアウト秒数で制限する。
    タイムアウト時は 504 Gateway Timeout を返します。
    """
    import asyncio
    import functools
    from app.config import get_editor_preferences

    prefs = get_editor_preferences()
    timeout_val = prefs.get("apiTimeout", 10)
    try:
        timeout_sec = float(timeout_val)
    except (ValueError, TypeError):
        timeout_sec = 10.0

    loop = asyncio.get_running_loop()
    # partial化して引数を固定してExecutorで実行
    p_func = functools.partial(func, *args, **kwargs)

    try:
        return await asyncio.wait_for(
            loop.run_in_executor(FILE_IO_EXECUTOR, p_func),
            timeout=timeout_sec
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail=f"処理がタイムアウトしました（設定値: {timeout_sec}秒）。ネットワークが遅い可能性があります。"
        )


def convert_storage_path(path: str) -> str:
    """
    ストレージパスやURLの変更に対応するための変換関数。
    normalize_pathの冒頭などで呼び出され、アプリ全体に適用されます。
    
    引数:
        path (str): 入力パスまたはURL
        
    戻り値:
        str: 変換後のパスまたはURL
    """
    if not path:
        return path

    preferences = get_editor_preferences()
    raw_mappings = preferences.get("pathMappings", {})
    if not raw_mappings:
        return path

    # 1. raw_mappings {新: 旧1,旧2} を {旧: 新} に展開・フラット化する
    path_mappings = {}
    for new_path, old_paths_str in raw_mappings.items():
        if not new_path or not old_paths_str:
            continue
        # 旧サーバーが複数ある場合はカンマ区切りで展開
        old_paths = [p.strip() for p in old_paths_str.split(",") if p.strip()]
        for old_path in old_paths:
            path_mappings[old_path] = new_path

    # 2. URLかどうかの判定
    is_url = path.startswith(("http://", "https://", "obsidian://"))

    for old_path, new_path in path_mappings.items():
        if is_url:
            # URLの場合は大文字小文字を無視して前方一致比較
            if path.lower().startswith(old_path.lower()):
                return new_path + path[len(old_path):]
        else:
            # ファイルパス・UNCパスの場合
            # Windowsの「¥」を「\」に統一
            normalized_path = path.replace("¥", "\\")
            normalized_old = old_path.replace("¥", "\\")
            normalized_new = new_path.replace("¥", "\\")

            # 比較用にスラッシュに統一
            comp_path = normalized_path.replace("\\", "/")
            comp_old = normalized_old.replace("\\", "/")

            if comp_path.lower().startswith(comp_old.lower()):
                remainder = comp_path[len(comp_old):]
                base_new = normalized_new
                
                # 区切り文字スタイルを決定する（元の入力に \ が含まれていれば \）
                sep = "\\" if "\\" in normalized_path else "/"
                
                # base_newとremainderを結合する（重複区切りの排除）
                base_new_clean = base_new.replace("\\", "/")
                combined = base_new_clean.rstrip("/") + "/" + remainder.lstrip("/")
                
                result = combined.replace("/", sep)
                
                # UNCパスまたはUnix絶対パスの先頭プレフィックスが壊れないように調整
                if normalized_path.startswith("\\\\") and not result.startswith("\\\\"):
                    result = "\\" + result.lstrip("\\")
                elif normalized_path.startswith("//") and not result.startswith("//"):
                    result = "/" + result.lstrip("/")
                    
                return result

    return path


def normalize_path(path: str) -> Path:
    """
    パスを正規化
    - 絶対パス: そのまま使用（Windows UNCパス `\\\\server\\share\\folder` を含む）
    - 相対パス: ベースディレクトリからの相対パスとして扱う
    - パストラバーサル対策を実施
    """
    # 1. パス変換（NASリプレース対応など）
    # API経由、外部連携経由のすべてのアクセスに対して有効になります
    path = convert_storage_path(path)

    if not path:
        return settings.base_dir

    # Windowsの場合、/C:/... のようなパスの先頭のスラッシュを削除
    if settings.is_windows:
        if path.startswith("/") and len(path) > 2 and path[2] == ":":
            path = path[1:]
        # UNCパス対応: //server/share -> \\server\share
        elif path.startswith("//"):
             path = path.replace("/", "\\")

    # 環境変数の展開 (%USERPROFILE%, $HOME 等)
    expanded_path = os.path.expandvars(os.path.expanduser(path))
    normalized = Path(os.path.normpath(expanded_path))

    if normalized.is_absolute():
        return normalized

    try:
        # ネットワークI/Oを避けるため、相対パスも文字列ベースで正規化する。
        base_path = os.path.abspath(os.path.normpath(str(settings.base_dir)))
        candidate_path = os.path.abspath(os.path.join(base_path, str(normalized)))
        common_path = os.path.commonpath([base_path, candidate_path])
        if os.path.normcase(common_path) != os.path.normcase(base_path):
            raise HTTPException(status_code=403, detail="アクセスが拒否されました")
        return Path(candidate_path)
    except (ValueError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=f"無効なパスです: {str(e)}")


@router.get("/files", response_model=DirectoryResponse)
async def get_files(path: str = "") -> DirectoryResponse:
    """
    ファイル一覧を取得
    """
    target_path = normalize_path(path)

    def _get_files_sync(t_path: Path) -> Tuple[Path, List[FileItem]]:
        if not t_path.exists():
            raise HTTPException(status_code=404, detail="パスが見つかりません")

        # ファイルパスが指定された場合、その親フォルダを表示する
        if t_path.is_file():
            t_path = t_path.parent

        if not t_path.is_dir():
            raise HTTPException(status_code=400, detail="指定されたパスはディレクトリではありません")

        items: List[FileItem] = []
        target_root = str(t_path.resolve())

        try:
            with os.scandir(t_path) as entries:
                for entry in entries:
                    try:
                        if entry.is_symlink() and _is_recursive_symlink_target(entry.path, target_root):
                            continue

                        item_path = Path(entry.path)
                        item_absolute_path = item_path.as_posix()
                        is_dir = entry.is_dir()

                        if is_dir:
                            items.append(
                                FileItem(
                                    name=entry.name,
                                    type="directory",
                                    path=item_absolute_path,
                                )
                            )
                            continue

                        stat_result = entry.stat()
                        items.append(
                            FileItem(
                                name=entry.name,
                                type="file",
                                path=item_absolute_path,
                                size=stat_result.st_size,
                                modified=datetime.fromtimestamp(stat_result.st_mtime).isoformat(),
                            )
                        )
                    except (PermissionError, OSError):
                        continue
        except (PermissionError, OSError):
            raise HTTPException(status_code=403, detail="ディレクトリにアクセスできません")

        return t_path, items

    resolved_path, items = await run_with_timeout(_get_files_sync, target_path)

    return DirectoryResponse(
        type="directory",
        path=resolved_path.as_posix(),
        items=items
    )


# 共有フォルダを意図せず長時間走査しないための既定上限。
FOLDER_LATEST_MODIFIED_MAX_ENTRIES = 20_000


@router.post("/folder-latest-modified", response_model=FolderLatestModifiedResponse)
async def get_folder_latest_modified(request: FolderLatestModifiedRequest) -> FolderLatestModifiedResponse:
    """指定フォルダ自身と配下の全項目から、最も新しい更新日時を取得する。"""
    target_path = normalize_path(request.path)

    def _get_latest_modified_sync(path: Path) -> FolderLatestModifiedResponse:
        if not path.exists():
            raise HTTPException(status_code=404, detail="パスが見つかりません")
        if not path.is_dir():
            raise HTTPException(status_code=400, detail="フォルダを指定してください")

        try:
            latest_mtime = path.stat().st_mtime
        except (PermissionError, OSError):
            raise HTTPException(status_code=403, detail="フォルダにアクセスできません")

        scanned_entries = 0
        preferences = get_editor_preferences()
        try:
            configured_timeout = float(preferences.get("apiTimeout", 10))
        except (TypeError, ValueError):
            configured_timeout = 10.0
        try:
            max_entries = int(preferences.get("folderLatestModifiedMaxEntries", FOLDER_LATEST_MODIFIED_MAX_ENTRIES))
        except (TypeError, ValueError):
            max_entries = FOLDER_LATEST_MODIFIED_MAX_ENTRIES
        max_entries = max(1, max_entries)
        # run_with_timeoutの前に自発的に終了し、キャンセルできないワーカースレッドを残さない。
        deadline = time.monotonic() + max(1.0, configured_timeout * 0.8)
        directories = [path]
        while directories:
            current = directories.pop()
            try:
                with os.scandir(current) as entries:
                    for entry in entries:
                        if (
                            scanned_entries >= max_entries
                            or time.monotonic() >= deadline
                        ):
                            return FolderLatestModifiedResponse(
                                path=path.as_posix(),
                                modified=datetime.fromtimestamp(latest_mtime).isoformat(),
                                scanned_entries=scanned_entries,
                                truncated=True,
                            )
                        scanned_entries += 1
                        try:
                            # リンク先を辿らず、循環とネットワーク先への意図しない走査を防ぐ。
                            if entry.is_symlink():
                                continue
                            entry_stat = entry.stat(follow_symlinks=False)
                            latest_mtime = max(latest_mtime, entry_stat.st_mtime)
                            if entry.is_dir(follow_symlinks=False):
                                directories.append(Path(entry.path))
                        except (PermissionError, OSError):
                            continue
            except (PermissionError, OSError):
                continue

        return FolderLatestModifiedResponse(
            path=path.as_posix(),
            modified=datetime.fromtimestamp(latest_mtime).isoformat(),
            scanned_entries=scanned_entries,
        )

    return await run_with_timeout(_get_latest_modified_sync, target_path)


GIT_STATUS_MAX_WORKERS = 8
GIT_STATUS_COMMAND_TIMEOUT_SECONDS = 5
GIT_STATUS_MAX_CHANGED_FILES = 20


@router.post("/git-folder-statuses", response_model=GitFolderStatusesResponse)
async def get_git_folder_statuses(request: GitFolderStatusesRequest) -> GitFolderStatusesResponse:
    """指定フォルダ群を並列にGit確認し、未コミット変更の有無を返す。"""
    target_paths = [normalize_path(path) for path in request.paths]

    def _get_git_folder_statuses_sync(paths: List[Path]) -> GitFolderStatusesResponse:
        def get_changed_files(status_output: str) -> List[str]:
            """porcelain -z の出力から、変更後の相対パスだけを取り出す。"""
            records = [record for record in status_output.split("\0") if record]
            changed_files: List[str] = []
            index = 0
            while index < len(records):
                record = records[index]
                if len(record) >= 4 and record[2] == " ":
                    changed_files.append(record[3:])
                    # rename/copyは続く旧パスをスキップする。
                    if "R" in record[:2] or "C" in record[:2]:
                        index += 1
                index += 1
            return changed_files

        def check_git_status(path: Path) -> GitFolderStatusItem:
            if not path.is_dir():
                return GitFolderStatusItem(path=path.as_posix(), has_changes=False)
            try:
                result = subprocess.run(
                    ["git", "-C", str(path), "status", "--porcelain=v1", "-z", "--untracked-files=normal"],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    text=True,
                    timeout=GIT_STATUS_COMMAND_TIMEOUT_SECONDS,
                    check=False,
                )
                changed_files = get_changed_files(result.stdout) if result.returncode == 0 else []
                ahead_count = 0
                behind_count = 0
                if result.returncode == 0:
                    divergence = subprocess.run(
                        ["git", "-C", str(path), "rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
                        stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL,
                        text=True,
                        timeout=GIT_STATUS_COMMAND_TIMEOUT_SECONDS,
                        check=False,
                    )
                    if divergence.returncode == 0:
                        counts = divergence.stdout.split()
                        if len(counts) == 2:
                            behind_count, ahead_count = (int(counts[0]), int(counts[1]))
                return GitFolderStatusItem(
                    path=path.as_posix(),
                    has_changes=bool(changed_files),
                    changed_files=changed_files[:GIT_STATUS_MAX_CHANGED_FILES],
                    has_more_changes=len(changed_files) > GIT_STATUS_MAX_CHANGED_FILES,
                    ahead_count=ahead_count,
                    behind_count=behind_count,
                )
            except (OSError, subprocess.TimeoutExpired):
                return GitFolderStatusItem(path=path.as_posix(), has_changes=False)

        if not paths:
            return GitFolderStatusesResponse(items=[])

        results: Dict[str, GitFolderStatusItem] = {}
        max_workers = min(GIT_STATUS_MAX_WORKERS, len(paths))
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(check_git_status, path): path for path in paths}
            for future in as_completed(futures):
                path = futures[future]
                try:
                    results[path.as_posix()] = future.result()
                except Exception:
                    results[path.as_posix()] = GitFolderStatusItem(path=path.as_posix(), has_changes=False)

        return GitFolderStatusesResponse(items=[results[path.as_posix()] for path in paths])

    return await run_with_timeout(_get_git_folder_statuses_sync, target_paths)


def should_ignore(path: Path, ignore_patterns: List[str]) -> bool:
    """
    パスが除外パターンに一致するかチェック
    """
    name = path.name
    path_str = str(path)
    for pattern in ignore_patterns:
        pattern = pattern.strip()
        if not pattern:
            continue
        if fnmatch.fnmatch(name, pattern):
            return True
        if name == pattern:
            return True
        if pattern in path_str:
            return True
    return False


def search_files_recursive(
    base_path: Path,
    query: str,
    current_depth: int,
    max_depth: int,
    ignore_patterns: List[str],
    results: List[FileItem],
    max_results: int = 1000,
    file_type_filter: str = "all",
) -> None:
    """
    os.scandirを使って再帰的にファイルを検索

    Args:
        base_path: 検索開始ディレクトリ
        query: 検索クエリ（大文字小文字を区別しない）
        current_depth: 現在の階層
        max_depth: 最大検索階層（0=無制限）
        ignore_patterns: 除外パターンのリスト
        results: 検索結果を格納するリスト
        max_results: 最大結果数
        file_type_filter: 返却するファイルタイプ（all/file/directory）
    """
    if len(results) >= max_results or (max_depth > 0 and current_depth > max_depth):
        return

    query_lower = query.lower()
    search_root = str(base_path.resolve())
    stack: List[Tuple[Path, int]] = [(base_path, current_depth)]

    while stack and len(results) < max_results:
        current_path, depth = stack.pop()

        if max_depth > 0 and depth > max_depth:
            continue

        try:
            with os.scandir(current_path) as entries:
                child_dirs: List[Path] = []
                for entry in entries:
                    if len(results) >= max_results:
                        return

                    try:
                        entry_path = Path(entry.path)

                        if should_ignore(entry_path, ignore_patterns):
                            continue

                        if entry.is_symlink() and _is_recursive_symlink_target(entry.path, search_root):
                            continue

                        is_dir = entry.is_dir()
                        if query_lower in entry.name.lower():
                            if is_dir:
                                if file_type_filter in ("all", "directory"):
                                    results.append(
                                        FileItem(
                                            name=entry.name,
                                            type="directory",
                                            path=entry_path.as_posix(),
                                        )
                                    )
                            elif file_type_filter in ("all", "file"):
                                try:
                                    stat = entry.stat()
                                    results.append(
                                        FileItem(
                                            name=entry.name,
                                            type="file",
                                            path=entry_path.as_posix(),
                                            size=stat.st_size,
                                            modified=datetime.fromtimestamp(stat.st_mtime).isoformat(),
                                        )
                                    )
                                except (PermissionError, OSError):
                                    results.append(
                                        FileItem(
                                            name=entry.name,
                                            type="file",
                                            path=entry_path.as_posix(),
                                        )
                                    )

                        if is_dir and (max_depth == 0 or depth < max_depth):
                            child_dirs.append(entry_path)

                    except (PermissionError, OSError):
                        continue

                for child_dir in reversed(child_dirs):
                    stack.append((child_dir, depth + 1))
        except (PermissionError, OSError):
            continue


class PathInfoResponse(BaseModel):
    """パス情報のレスポンススキーマ"""

    path: str
    type: str  # "file", "directory", or "not_found"
    parent: Optional[str] = None


@router.get("/path-info", response_model=PathInfoResponse)
async def get_path_info(path: str = "") -> PathInfoResponse:
    """
    パスの種別を判定（ファイル/ディレクトリ/存在しない）
    """
    target_path = normalize_path(path)

    def _get_path_info_sync(t_path: Path) -> PathInfoResponse:
        if not t_path.exists():
            return PathInfoResponse(
                path=t_path.as_posix(),
                type="not_found",
            )

        if t_path.is_dir():
            return PathInfoResponse(
                path=t_path.as_posix(),
                type="directory",
            )

        parent_path = t_path.parent
        return PathInfoResponse(
            path=t_path.as_posix(),
            type="file",
            parent=parent_path.as_posix(),
        )

    return await run_with_timeout(_get_path_info_sync, target_path)


@router.get("/search", response_model=SearchResponse)
async def search_files(
    path: str = Query("", description="検索開始ディレクトリ"),
    query: str = Query("", description="検索クエリ（ファイル名の部分一致）"),
    depth: int = Query(0, ge=0, le=100, description="検索階層（0=無制限）"),
    ignore: str = Query("", description="除外パターン（カンマ区切り）"),
    max_results: int = Query(1000, ge=1, le=10000, description="最大結果数"),
    file_type: str = Query("all", description="ファイルタイプフィルタ（all/file/directory）"),
) -> SearchResponse:
    """
    ファイル検索（Liveモード - ディレクトリ走査）

    インデックス検索は外部サービス（file_index_service）を使用してください。

    Args:
        path: 検索開始ディレクトリ
        query: 検索クエリ（ファイル名の部分一致、大文字小文字を区別しない）
        depth: 検索階層（0=無制限、1=現在のディレクトリのみ、2=1階層下まで...）
        ignore: 除外パターン（カンマ区切り、例: "node_modules,*.pyc,.git"）
        max_results: 最大結果数（デフォルト1000、最大10000）
        file_type: ファイルタイプフィルタ（all/file/directory）

    Returns:
        SearchResponse: 検索結果
    """
    ignore_patterns = [p.strip() for p in ignore.split(",") if p.strip()]
    default_ignores = [".git", ".svn", "__pycache__", ".DS_Store"]
    ignore_patterns.extend(default_ignores)

    if not query.strip():
        return SearchResponse(
            query=query,
            path=path,
            depth=depth,
            total=0,
            items=[],
        )

    target_path = normalize_path(path)

    def _search_sync(t_path: Path) -> SearchResponse:
        if not t_path.exists():
            raise HTTPException(status_code=404, detail="パスが見つかりません")

        if not t_path.is_dir():
            raise HTTPException(status_code=400, detail="指定されたパスはディレクトリではありません")

        results: List[FileItem] = []
        search_files_recursive(
            t_path,
            query,
            1,
            depth,
            ignore_patterns,
            results,
            max_results,
            file_type,
        )

        return SearchResponse(
            query=query,
            path=t_path.as_posix(),
            depth=depth,
            total=len(results),
            items=results,
        )

    return await run_with_timeout(_search_sync, target_path)


class DeleteRequest(BaseModel):
    """削除リクエストのスキーマ"""

    path: str
    async_mode: bool = False  # 非同期モード
    debug_mode: bool = False  # デバッグモード
    force_kill_pids: Optional[List[int]] = None  # 強制終了するプロセスのPIDリスト


def _is_network_drive(path: Path) -> bool:
    """ネットワークドライブかどうかを判定"""
    path_str = str(path)
    # macOS/Linuxのネットワークドライブ判定
    if path_str.startswith('/Volumes/') and not path_str.startswith('/Volumes/Macintosh'):
        return True
    # Windowsのネットワークドライブ判定
    if path_str.startswith('\\\\') or (len(path_str) >= 2 and path_str[1] == ':' and path_str[0] in 'DEFGHIJKLMNOPQRSTUVWXYZ'):
        # ネットワークドライブの可能性が高い（完全な判定にはさらなるチェックが必要）
        return True
    return False


def _move_to_trash(path_str: str) -> None:
    """WindowsではWin32 APIを使い、それ以外はsend2trashを使用するラッパー"""
    from app.config import settings

    if settings.is_windows:
        import ctypes
        from ctypes import wintypes
        from pathlib import Path

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

        current_path = str(Path(path_str).resolve())
        double_null_path = current_path + "\0\0"

        op = SHFILEOPSTRUCTW()
        op.hwnd = None
        op.wFunc = FO_DELETE
        op.pFrom = double_null_path
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
    else:
        from send2trash import send2trash
        send2trash(path_str)


def _get_locking_processes(path_str: str) -> list[dict]:
    """Restart Manager API を使用して、ファイルをロックしているプロセスのリストを取得する(Windows専用)"""
    from app.config import settings
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

    dwSessionHandle = wintypes.DWORD()
    szSessionKey = (wintypes.WCHAR * 256)()
    res = rstrtmgr.RmStartSession(ctypes.byref(dwSessionHandle), 0, szSessionKey)
    if res != 0:
        return []
        
    locking_processes = []
    try:
        paths = (wintypes.LPCWSTR * 1)(path_str)
        res = rstrtmgr.RmRegisterResources(dwSessionHandle, 1, paths, 0, None, 0, None)
        if res == 0:
            pnProcInfoNeeded = wintypes.DWORD(0)
            pnProcInfo = wintypes.DWORD(0)
            lpdwRebootReasons = wintypes.DWORD(0)
            
            res = rstrtmgr.RmGetList(
                dwSessionHandle, 
                ctypes.byref(pnProcInfoNeeded),
                ctypes.byref(pnProcInfo), 
                None, 
                ctypes.byref(lpdwRebootReasons)
            )
            
            if res == 234: # ERROR_MORE_DATA
                pnProcInfo = pnProcInfoNeeded
                rgpi = (RM_PROCESS_INFO * pnProcInfoNeeded.value)()
                res = rstrtmgr.RmGetList(
                    dwSessionHandle, 
                    ctypes.byref(pnProcInfoNeeded),
                    ctypes.byref(pnProcInfo), 
                    rgpi, 
                    ctypes.byref(lpdwRebootReasons)
                )
                if res == 0:
                    for i in range(pnProcInfo.value):
                        locking_processes.append({
                            "pid": rgpi[i].Process.dwProcessId,
                            "name": rgpi[i].strAppName
                        })
    finally:
        rstrtmgr.RmEndSession(dwSessionHandle)
        
    return locking_processes


def _kill_processes(pids: list[int]) -> None:
    """指定されたPIDのプロセスを終了させる"""
    import os
    import signal
    from app.config import settings
    for pid in pids:
        try:
            if settings.is_windows:
                os.kill(pid, signal.SIGTERM)
            else:
                os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def _clear_windows_readonly(path: Path) -> None:
    if not settings.is_windows:
        return

    try:
        path.chmod(path.stat().st_mode | stat.S_IWRITE)
    except OSError:
        pass


def _handle_rmtree_remove_readonly(func, path_str, exc_info):
    """Windowsでreadonlyが原因のrmtree失敗を再試行する"""
    exc = exc_info[1]
    if not settings.is_windows or not isinstance(exc, PermissionError):
        raise exc

    retry_path = Path(path_str)
    _clear_windows_readonly(retry_path)
    func(path_str)


def _delete_with_retry(path: Path, is_network: bool) -> None:
    """Windowsで一時的なファイルロックが残るケースを吸収する"""
    retry_count = WINDOWS_DELETE_RETRY_COUNT if settings.is_windows else 1
    last_error: Exception | None = None

    for attempt in range(retry_count):
        try:
            _clear_windows_readonly(path)
            if is_network:
                if path.is_file() or path.is_symlink():
                    path.unlink()
                else:
                    path.rmdir()
            else:
                _move_to_trash(str(path))
            return
        except (PermissionError, OSError) as exc:
            last_error = exc
            if not settings.is_windows or attempt == retry_count - 1:
                raise
            sleep_seconds = min(
                WINDOWS_DELETE_RETRY_BASE_SECONDS * (attempt + 1),
                WINDOWS_DELETE_RETRY_MAX_SECONDS,
            )
            time.sleep(sleep_seconds)

    if last_error is not None:
        raise last_error


def _safe_delete(path: Path, debug_mode: bool = False, force_kill_pids: Optional[List[int]] = None) -> tuple[bool, str, list[dict]]:
    """
    安全にファイル/フォルダを削除する（一括削除版）

    Returns:
        (成功フラグ, メッセージ, [ロックしているプロセス情報のリスト]) のタプル
    """
    def log(msg: str):
        if debug_mode:
            print(f"[DELETE] {msg}")

    try:
        is_network = _is_network_drive(path)

        if is_network:
            # ネットワークドライブの場合は直接削除
            log(f"ネットワークドライブ検出、直接削除: {path}")
            if path.is_file() or path.is_symlink():
                _delete_with_retry(path, is_network=True)
            else:
                shutil.rmtree(
                    str(path),
                    onerror=_handle_rmtree_remove_readonly if settings.is_windows else None
                )
            return True, "削除しました（ネットワークドライブ）", []
        else:
            # ローカルドライブの場合はゴミ箱に移動
            log(f"ローカルドライブ、ゴミ箱に移動: {path}")
            if force_kill_pids:
                log(f"強制終了を実行: {force_kill_pids}")
                _kill_processes(force_kill_pids)
                time.sleep(0.5)  # プロセス終了を少し待つ
            _delete_with_retry(path, is_network=False)
            return True, "ゴミ箱に移動しました", []

    except Exception as e:
        log(f"削除エラー: {e}")
        locked_by = []
        if settings.is_windows and isinstance(e, (PermissionError, OSError)):
            locked_by = _get_locking_processes(str(path))
        return False, str(e), locked_by


def collect_all_files(path: Path) -> List[Path]:
    """
    フォルダ内のすべてのファイルとディレクトリを収集する（深い階層から）

    Args:
        path: 収集対象のパス

    Returns:
        ファイルとディレクトリのリスト（深い階層から浅い階層の順）
    """
    if path.is_file():
        return [path]

    items = []
    try:
        # rglob("*")で全アイテムを取得し、深さでソート（深い順）
        all_items = list(path.rglob("*"))
        # パスの深さ（セパレータの数）で降順ソート
        all_items.sort(key=lambda p: str(p).count(os.sep), reverse=True)
        items.extend(all_items)
        # 最後にルートディレクトリ自体を追加
        items.append(path)
    except (PermissionError, OSError):
        pass

    return items


def _safe_delete_with_progress(
    path: Path,
    task_id: Optional[str] = None,
    debug_mode: bool = False
) -> Tuple[bool, str, int, int]:
    """
    安全にファイル/フォルダを削除する（進捗対応版）

    ディレクトリの場合、内部のファイルを一つずつ削除して進捗を報告する。

    Args:
        path: 削除対象のパス
        task_id: タスクID（進捗追跡用）
        debug_mode: デバッグモード

    Returns:
        (成功フラグ, メッセージ, 成功数, 失敗数) のタプル
    """
    def log(msg: str):
        if debug_mode:
            print(f"[DELETE_PROGRESS] {msg}")

    is_network = _is_network_drive(path)

    try:
        # ファイルリストを収集
        log(f"ファイルリスト収集開始: {path}")
        items = collect_all_files(path)
        total_items = len(items)
        log(f"削除対象: {total_items}件")

        # タスクの総ファイル数を更新
        if task_id:
            task = task_manager.get_task(task_id)
            if task:
                task.total_files = total_items

        success_count = 0
        fail_count = 0

        # 各アイテムを削除（深い階層から）
        for i, item in enumerate(items):
            # キャンセルチェック
            if task_id and task_manager.is_cancelled(task_id):
                log("キャンセルが検出されました")
                return False, "キャンセルされました", success_count, fail_count

            # 進捗更新
            if task_id:
                task_manager.update_progress(
                    task_id,
                    processed_files=i,
                    current_file=item.name
                )

            try:
                if item.is_file() or item.is_symlink():
                    # ファイルまたはシンボリックリンクを削除
                    _delete_with_retry(item, is_network=is_network)
                    log(f"削除成功 ({i+1}/{total_items}): {item.name}")
                    success_count += 1
                elif item.is_dir():
                    # ディレクトリを削除（この時点で中身は空のはず）
                    try:
                        _delete_with_retry(item, is_network=is_network)
                        log(f"ディレクトリ削除成功 ({i+1}/{total_items}): {item.name}")
                        success_count += 1
                    except OSError as e:
                        # ディレクトリが空でない場合は警告を出すが続行
                        log(f"ディレクトリ削除スキップ ({i+1}/{total_items}): {item.name} - {e}")
                        # 空でないディレクトリは強制削除を試みる
                        if is_network:
                            try:
                                shutil.rmtree(
                                    str(item),
                                    onerror=_handle_rmtree_remove_readonly if settings.is_windows else None
                                )
                                success_count += 1
                            except Exception:
                                fail_count += 1
                        else:
                            fail_count += 1
            except Exception as e:
                log(f"削除エラー ({i+1}/{total_items}): {item.name} - {e}")
                fail_count += 1

        # 最終進捗更新
        if task_id:
            task_manager.update_progress(task_id, processed_files=total_items)

        if fail_count > 0:
            return False, f"一部の削除に失敗しました（成功: {success_count}, 失敗: {fail_count}）", success_count, fail_count

        message = "削除しました（ネットワークドライブ）" if is_network else "ゴミ箱に移動しました"
        return True, message, success_count, fail_count

    except Exception as e:
        log(f"削除エラー: {e}")
        return False, str(e), 0, 1


def _execute_delete_async(task_id: str, target_path: Path, debug_mode: bool):
    """削除を実行（バックグラウンドスレッド用・進捗対応）"""
    def log(msg: str):
        if debug_mode:
            print(f"[DELETE] {msg}")

    task_manager.set_running(task_id)
    task_manager.update_progress(task_id, processed_files=0, current_file=target_path.name)
    log(f"削除開始: {target_path}")

    # 進捗対応版の削除を実行
    success, message, success_count, fail_count = _safe_delete_with_progress(
        target_path,
        task_id,
        debug_mode
    )

    if success:
        log(f"削除完了: {target_path.name} (成功: {success_count}件)")
        task_manager.complete_task(task_id, result={
            "status": "completed",
            "success_count": success_count,
            "fail_count": fail_count,
            "results": [{"path": str(target_path), "status": "success", "message": message}]
        })
    else:
        log(f"削除エラー: {message}")
        task_manager.fail_task(task_id, message)


@router.delete("/delete")
async def delete_item(request: DeleteRequest):
    """
    ファイル/フォルダをゴミ箱に移動（ネットワークドライブの場合は直接削除）

    Args:
        request: 削除リクエスト（pathを含む）

    Returns:
        削除成功メッセージ
    """
    target_path = normalize_path(request.path)

    if not target_path.exists():
        raise HTTPException(status_code=404, detail="パスが見つかりません")

    # 非同期モードの場合
    if request.async_mode:
        task = task_manager.create_task(total_files=1)
        task_id = task.id

        thread = threading.Thread(
            target=_execute_delete_async,
            args=(task_id, target_path, request.debug_mode)
        )
        thread.start()

        return {"status": "async", "task_id": task_id, "message": "削除処理を開始しました"}

    # 同期モード
    success, message, locked_by = _safe_delete(target_path, request.debug_mode, request.force_kill_pids)
    if success:
        return {"status": "success", "message": message}
    else:
        if locked_by:
            from fastapi.responses import JSONResponse
            return JSONResponse(
                status_code=409, 
                content={"detail": f"削除に失敗しました: {message}", "locked_by": locked_by}
            )
        raise HTTPException(status_code=500, detail=f"削除に失敗しました: {message}")


def count_files_in_directory(path: Path, max_depth: int = 3, current_depth: int = 0) -> int:
    """
    ディレクトリ内のファイル数をカウント（指定した深さまで）

    Args:
        path: カウント対象のパス
        max_depth: 最大探索深度（デフォルト3）
        current_depth: 現在の深度（内部用）

    Returns:
        ファイル数
    """
    if not path.exists():
        return 0

    if path.is_file():
        return 1

    if not path.is_dir():
        return 0

    # 最大深度に達したら0を返す
    if current_depth >= max_depth:
        return 0

    count = 0
    try:
        for item in path.iterdir():
            try:
                if item.is_file():
                    count += 1
                elif item.is_dir() and current_depth < max_depth:
                    count += count_files_in_directory(item, max_depth, current_depth + 1)
            except (PermissionError, OSError):
                continue
    except (PermissionError, OSError):
        pass

    return count


class CountFilesRequest(BaseModel):
    """ファイル数カウントリクエストのスキーマ"""
    paths: List[str]
    max_depth: int = 3


class CountFilesResponse(BaseModel):
    """ファイル数カウントレスポンスのスキーマ"""
    total_count: int
    details: List[dict]


@router.post("/count-files", response_model=CountFilesResponse)
async def count_files(request: CountFilesRequest):
    """
    指定されたパスのファイル数をカウント
    フォルダの場合は指定した深さまで再帰的にカウント

    Args:
        request: パスのリストと最大深度

    Returns:
        合計ファイル数と詳細
    """
    def _count_sync() -> CountFilesResponse:
        total = 0
        details = []

        for path_str in request.paths:
            try:
                path = normalize_path(path_str)
                count = count_files_in_directory(path, request.max_depth)
                total += count
                details.append({
                    "path": path_str,
                    "count": count,
                    "type": "directory" if path.is_dir() else "file"
                })
            except Exception as e:
                details.append({
                    "path": path_str,
                    "count": 0,
                    "type": "error",
                    "error": str(e)
                })

        return CountFilesResponse(total_count=total, details=details)

    return await run_with_timeout(_count_sync)


@router.get("/obsidian/daily-path", response_model=ObsidianPathResponse)
async def get_obsidian_daily_path():
    """
    Obsidianの今日のフォルダパスを取得。
    フォルダが存在しない場合は作成する。
    """
    now = datetime.now()
    # 年/月/日 の形式でパスを構築
    date_path = now.strftime("%Y/%m/%d")
    target_path = settings.obsidian_base_dir / date_path
    
    # フォルダを作成（親フォルダも含めて）
    os.makedirs(target_path, exist_ok=True)
    
    return ObsidianPathResponse(path=target_path.as_posix())


class UnzipRequest(BaseModel):
    """ZIP解凍リクエストのスキーマ"""
    path: str

@router.post("/unzip")
async def unzip_file(request: UnzipRequest):
    """
    ZIPファイルを解凍する。
    同じディレクトリ内に、ZIPファイル名（拡張子なし）のフォルダを作成して解凍する。
    """
    target_path = normalize_path(request.path)

    def _unzip_sync(path: Path) -> dict:
        if not path.exists():
            raise HTTPException(status_code=404, detail="ファイルが見つかりません")

        if not path.is_file() or not zipfile.is_zipfile(path):
            raise HTTPException(status_code=400, detail="有効なZIPファイルではありません")

        extract_dir_name = path.stem
        extract_path = path.parent / extract_dir_name
        counter = 1
        while extract_path.exists():
            extract_path = path.parent / f"{extract_dir_name}_{counter}"
            counter += 1

        try:
            extract_path.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(path, 'r') as zip_ref:
                resolved_extract = extract_path.resolve()
                for member in zip_ref.namelist():
                    member_path = (extract_path / member).resolve()
                    if not member_path.is_relative_to(resolved_extract):
                        raise HTTPException(
                            status_code=400,
                            detail=f"不正なZIPファイルです（パストラバーサル検出）: {member}",
                        )
                zip_ref.extractall(extract_path)

            return {
                "status": "success",
                "message": f"{extract_path.name} に解凍しました",
                "extracted_path": extract_path.as_posix(),
            }
        except HTTPException:
            shutil.rmtree(extract_path, ignore_errors=True)
            raise
        except Exception as e:
            shutil.rmtree(extract_path, ignore_errors=True)
            raise HTTPException(status_code=500, detail=f"解凍中にエラーが発生しました: {str(e)}")

    return await run_with_timeout(_unzip_sync, target_path)


class BatchDeleteRequest(BaseModel):
    """一括削除リクエストのスキーマ"""
    paths: List[str]
    async_mode: bool = False
    debug_mode: bool = False
    force_kill_pids: Optional[List[int]] = None  # 強制終了するプロセスのPIDリスト


def _execute_batch_delete_async(
    task_id: str,
    paths: List[str],
    debug_mode: bool
):
    """バッチ削除を実行（バックグラウンドスレッド用・進捗対応・並列化）"""
    def log(msg: str):
        if debug_mode:
            print(f"[BATCH_DELETE:{task_id[:8]}] {msg}")

    task_manager.set_running(task_id)
    # 即座に準備中を表示
    task_manager.update_progress(task_id, processed_files=0, current_file="準備中...")
    log(f"削除開始: {len(paths)} パス")

    # 削除キュー: path
    del_queue = queue.Queue()
    # ディレクトリリスト（後で削除するため）
    dir_list = []
    
    total_files = 0
    scanned_files = 0
    scanner_finished = False

    # 統計
    success_count = 0
    fail_count = 0
    lock = threading.Lock()
    results = []

    def scanner_thread():
        nonlocal total_files, scanner_finished
        try:
             for path_str in paths:
                try:
                    p = normalize_path(path_str)
                    if not p.exists():
                        continue
                    
                    if p.is_file() or p.is_symlink():
                        # 単一ファイル
                        total_files += 1
                        del_queue.put(p)
                    else:
                        # ディレクトリの場合、再帰的に収集
                        # topdown=Falseで深い方から...と言いたいが、
                        # 並列削除の場合はファイルだけ先に全消しして、最後にディレクトリを消す方が安全かつ高速
                        for root, dirs, files in os.walk(p):
                            for name in files:
                                file_path = Path(root) / name
                                total_files += 1
                                del_queue.put(file_path)
                            
                            for name in dirs:
                                dir_path = Path(root) / name
                                dir_list.append(dir_path)
                        
                        # ルートディレクトリも追加
                        dir_list.append(p)
                                
                    # 定期的にタスク情報の総数を更新
                    task = task_manager.get_task(task_id)
                    if task:
                        task.total_files = total_files

                except Exception as e:
                    log(f"スキャンエラー: {path_str} - {e}")

        except Exception as e:
            log(f"スキャンクリティカルエラー: {e}")
        finally:
            scanner_finished = True
            log(f"スキャン完了: {total_files} ファイル")
            # タスク情報の総数を最終更新
            task = task_manager.get_task(task_id)
            if task:
                task.total_files = total_files

    def worker_thread():
        nonlocal success_count, fail_count, scanned_files
        while True:
            try:
                # キューから取得（タイムアウト付き）
                try:
                    target_path = del_queue.get(timeout=0.5)
                except queue.Empty:
                    if scanner_finished:
                        break
                    continue

                try:
                    # 削除実行
                    is_network = _is_network_drive(target_path)
                    item_success = False
                    error_msg = ""

                    try:
                        _delete_with_retry(target_path, is_network=is_network)
                        item_success = True
                    except Exception as e:
                        error_msg = str(e)

                    with lock:
                        if item_success:
                            success_count += 1
                            if debug_mode:
                                log(f"削除成功: {target_path.name}")
                        else:
                            fail_count += 1
                            log(f"削除失敗: {target_path.name} - {error_msg}")
                            results.append({
                                "path": str(target_path),
                                "status": "error",
                                "message": error_msg
                            })

                        scanned_files += 1
                        # 進捗更新
                        task_manager.update_progress(
                            task_id,
                            processed_files=scanned_files,
                            current_file=target_path.name
                        )

                finally:
                    del_queue.task_done()

            except Exception as e:
                log(f"ワーカースレッドエラー: {e}")

    # スキャナー開始
    t_scanner = threading.Thread(target=scanner_thread, daemon=True)
    t_scanner.start()

    # ワーカー開始
    workers = []
    for _ in range(MAX_WORKERS):
        t = threading.Thread(target=worker_thread, daemon=True)
        t.start()
        workers.append(t)

    # 全て終了するまで待機
    t_scanner.join()
    for t in workers:
        t.join()

    # 残ったディレクトリを削除（深い順にソートして削除）
    # os.walkで集めたdir_listは順不同の可能性があるため、パスの深さでソート
    dir_list.sort(key=lambda x: str(x).count(os.sep), reverse=True)
    
    log(f"ディレクトリ削除フェーズ: {len(dir_list)} 件")
    
    for d in dir_list:
        if task_manager.is_cancelled(task_id):
            break
        
        # 進捗更新
        task_manager.update_progress(task_id, processed_files=scanned_files, current_file=d.name)
        
        try:
            if d.exists():
                is_network = _is_network_drive(d)
                _delete_with_retry(d, is_network=is_network)
                log(f"ディレクトリ削除: {d.name}")
        except Exception as e:
            # 既に消えている、または中身が残っている場合
            # 中身が残っているならrmtreeを試みる（安全のため）
            try:
                if d.exists():
                    shutil.rmtree(
                        str(d),
                        onerror=_handle_rmtree_remove_readonly if settings.is_windows else None
                    )
                    log(f"ディレクトリ強制削除: {d.name}")
            except Exception as e2:
                log(f"ディレクトリ削除失敗: {d} - {e2}")

    # 完了処理
    log(f"完了: 成功={success_count}, 失敗={fail_count}")
    task_manager.complete_task(task_id, result={
        "status": "completed",
        "success_count": success_count,
        "fail_count": fail_count,
        "results": results
    })


@router.post("/delete/batch")
async def delete_items_batch(request: BatchDeleteRequest):
    """
    複数のファイル/フォルダをゴミ箱に移動

    async_mode が True の場合、バックグラウンドで処理しタスクIDを返す。
    """
    if request.debug_mode:
        print(f"[BATCH_DELETE] 開始: Paths={request.paths}, Async={request.async_mode}")

    # 非同期モードの場合
    if request.async_mode:
        task = task_manager.create_task(total_files=len(request.paths))
        task_id = task.id

        def run_batch_delete():
            _execute_batch_delete_async(
                task_id=task_id,
                paths=request.paths,
                debug_mode=request.debug_mode
            )

        thread = threading.Thread(target=run_batch_delete, daemon=True)
        thread.start()

        return {"status": "async", "task_id": task_id, "message": "削除処理を開始しました"}

    # 同期モード（従来通り）
    results = []
    success_count = 0
    fail_count = 0

    for path_str in request.paths:
        try:
            target_path = normalize_path(path_str)
        except Exception as e:
            result = {"path": path_str, "status": "error", "message": f"パスの正規化に失敗: {str(e)}"}
            fail_count += 1
            results.append(result)
            continue

        result = {"path": path_str, "status": "pending", "message": ""}

        if not target_path.exists():
            result["status"] = "error"
            result["message"] = "ファイルが見つかりません"
            fail_count += 1
            results.append(result)
            continue

        delete_success, delete_message, locked_by = _safe_delete(target_path, False, request.force_kill_pids)

        if delete_success:
            result["status"] = "success"
            result["message"] = delete_message
            success_count += 1
        else:
            result["status"] = "error"
            result["message"] = delete_message
            if locked_by:
                result["locked_by"] = locked_by
            fail_count += 1

        results.append(result)

    return {
        "status": "completed",
        "success_count": success_count,
        "fail_count": fail_count,
        "results": results
    }


class CreateFolderRequest(BaseModel):
    """フォルダ作成リクエストのスキーマ"""

    path: str
    name: str


@router.post("/create-folder")
async def create_folder(request: CreateFolderRequest):
    """
    フォルダを作成

    Args:
        request: 作成リクエスト（親パスと名前を含む）

    Returns:
        作成成功メッセージ
    """
    parent_path = normalize_path(request.path)

    if not parent_path.exists():
        raise HTTPException(status_code=404, detail="親ディレクトリが見つかりません")

    if not parent_path.is_dir():
        raise HTTPException(status_code=400, detail="指定されたパスはディレクトリではありません")

    new_folder = parent_path / request.name

    if new_folder.exists():
        raise HTTPException(status_code=400, detail="同名のファイル/フォルダが既に存在します")

    try:
        new_folder.mkdir()
        return {"status": "success", "message": f"フォルダを作成しました: {new_folder}"}
    except PermissionError:
        raise HTTPException(status_code=403, detail="作成権限がありません")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"フォルダ作成に失敗しました: {str(e)}")



class CreateFileRequest(BaseModel):
    """ファイル作成リクエストのスキーマ"""

    path: str
    name: str
    content: Optional[str] = ""


@router.post("/create-file")
async def create_file(request: CreateFileRequest):
    """
    ファイルを作成
    """
    parent_path = normalize_path(request.path)

    if not parent_path.exists():
        raise HTTPException(status_code=404, detail="親ディレクトリが見つかりません")

    if not parent_path.is_dir():
        raise HTTPException(status_code=400, detail="指定されたパスはディレクトリではありません")

    new_file = parent_path / request.name

    if new_file.exists():
        raise HTTPException(status_code=400, detail="同名のファイル/フォルダが既に存在します")

    try:
        with open(new_file, 'w', encoding='utf-8') as f:
            if request.content:
                f.write(request.content)
            else:
                pass # 空ファイルを作成
        return {"status": "success", "message": f"ファイルを作成しました: {new_file}", "path": str(new_file)}
    except PermissionError:
        raise HTTPException(status_code=403, detail="作成権限がありません")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ファイル作成に失敗しました: {str(e)}")


class UpdateFileRequest(BaseModel):
    """ファイル更新リクエストのスキーマ"""

    path: str
    content: str


@router.post("/update-file")
async def update_file(request: UpdateFileRequest):
    """
    ファイルの内容を更新
    """
    target_path = normalize_path(request.path)

    if not target_path.exists():
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")

    if target_path.is_dir():
        raise HTTPException(status_code=400, detail="指定されたパスはディレクトリです")

    try:
        with open(target_path, 'w', encoding='utf-8') as f:
            f.write(request.content)
        return {"status": "success", "message": f"ファイルを更新しました: {target_path}"}
    except PermissionError:
        raise HTTPException(status_code=403, detail="更新権限がありません")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ファイル更新に失敗しました: {str(e)}")


from fastapi import UploadFile, File, Form

@router.post("/upload")
async def upload_files(
    request: Request,
    path: str = Query(..., description="アップロード先ディレクトリ"),
    files: Optional[List[UploadFile]] = File(None, description="アップロードするファイルリスト"),
    relative_paths: Optional[List[str]] = Form(None, description="各ファイルの相対パスリスト"),
    empty_directories: Optional[List[str]] = Form(None, description="空ディレクトリリスト"),
):
    """
    ファイルおよびディレクトリをアップロード
    Windows ExplorerおよびmacOS Finderからのファイル・フォルダドラッグ＆ドロップに対応
    """
    target_dir = normalize_path(path)

    if not target_dir.exists():
        raise HTTPException(status_code=404, detail="アップロード先が見つかりません")
    
    if not target_dir.is_dir():
        # ファイルを指定した場合はその親ディレクトリにアップロード
        target_dir = target_dir.parent

    target_dir_resolved = target_dir.resolve()

    # Formデータから確実に取得（マルチパート解析のフォールバック）
    try:
        form_data = await request.form()
        if not files:
            files_from_form = form_data.getlist("files")
            if files_from_form:
                files = [f for f in files_from_form if isinstance(f, UploadFile)]
        if not relative_paths:
            rel_from_form = form_data.getlist("relative_paths")
            if rel_from_form:
                relative_paths = [str(r) for r in rel_from_form]
        if not empty_directories:
            empty_from_form = form_data.getlist("empty_directories")
            if empty_from_form:
                empty_directories = [str(e) for e in empty_from_form]
    except Exception:
        pass

    def is_safe_relative_path(rel_p: str) -> bool:
        if not rel_p or rel_p.strip() == "":
            return False
        normalized = rel_p.replace("\\", "/").strip("/")
        parts = normalized.split("/")
        if any(part in ("..", ".", "") for part in parts):
            return False
        if ":" in normalized or normalized.startswith("/"):
            return False
        return True

    uploaded_files = []
    created_directories = []
    errors = []

    # 1. 空ディレクトリの作成
    if empty_directories:
        for empty_dir in empty_directories:
            if not is_safe_relative_path(empty_dir):
                errors.append(f"不正なディレクトリパス: {empty_dir}")
                continue
            try:
                dest_dir = (target_dir / Path(empty_dir.replace("\\", "/"))).resolve()
                if not dest_dir.is_relative_to(target_dir_resolved):
                    errors.append(f"ディレクトリが範囲外です: {empty_dir}")
                    continue
                dest_dir.mkdir(parents=True, exist_ok=True)
                created_directories.append(empty_dir)
            except Exception as e:
                errors.append(f"{empty_dir}: {str(e)}")

    # 2. ファイルのアップロードと親ディレクトリ作成
    if files:
        for idx, file in enumerate(files):
            try:
                # relative_paths が提供されている場合はそれを優先
                rel_path = None
                if relative_paths and idx < len(relative_paths) and relative_paths[idx]:
                    rel_path = relative_paths[idx]
                elif file.filename:
                    rel_path = file.filename

                if not rel_path:
                    continue

                if not is_safe_relative_path(rel_path):
                    errors.append(f"不正なファイルパス: {rel_path}")
                    continue

                dest_file = target_dir / Path(rel_path.replace("\\", "/"))
                dest_parent = dest_file.parent.resolve()
                dest_parent.mkdir(parents=True, exist_ok=True)

                if not dest_parent.is_relative_to(target_dir_resolved):
                    errors.append(f"ファイルが範囲外です: {rel_path}")
                    continue

                with open(dest_file, "wb") as buffer:
                    shutil.copyfileobj(file.file, buffer)

                uploaded_files.append(rel_path)
            except Exception as e:
                errors.append(f"{file.filename}: {str(e)}")
            finally:
                file.file.close()

    total_success = len(uploaded_files) + len(created_directories)
    if errors:
        return {
            "status": "partial_success" if total_success > 0 else "error",
            "message": f"{total_success}件処理しました。エラー: {len(errors)}件",
            "uploaded": uploaded_files,
            "created_directories": created_directories,
            "errors": errors,
        }

    return {
        "status": "success",
        "message": f"{total_success}件処理しました",
        "uploaded": uploaded_files,
        "created_directories": created_directories,
    }


class RenameRequest(BaseModel):
    """リネームリクエストのスキーマ"""

    old_path: str
    new_name: str


@router.post("/rename")
async def rename_item(request: RenameRequest):
    """
    ファイル/フォルダをリネーム

    Args:
        request: リネームリクエスト（元パスと新しい名前を含む）

    Returns:
        リネーム成功メッセージ
    """
    old_path = normalize_path(request.old_path)

    if not old_path.exists():
        raise HTTPException(status_code=404, detail="対象が見つかりません")

    new_path = old_path.parent / request.new_name

    if new_path.exists():
        raise HTTPException(status_code=400, detail="同名のファイル/フォルダが既に存在します")

    try:
        old_path.rename(new_path)
        return {"status": "success", "message": f"リネームしました: {old_path} → {new_path}"}
    except PermissionError:
        raise HTTPException(status_code=403, detail="リネーム権限がありません")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"リネームに失敗しました: {str(e)}")


# ----------------------------------------------------------------
# 並列コピー・検証・安全な移動のヘルパー関数
# ----------------------------------------------------------------

# 並列処理のワーカー数（Turboモード）
# I/O待ち時間を埋めるため、CPUコア数の64倍、最大512まで許可
MAX_WORKERS = min(64, (os.cpu_count() or 4) * 8)


def fast_copy_file(src: Path, dest: Path) -> bool:
    """
    プラットフォーム固有の最適化を使用した高速ファイルコピー

    - macOS (APFS): clonefile システムコール（Copy-on-Write、瞬時）
    - Windows: CopyFileEx Win32 API（ネイティブコピー）
    - Linux: sendfile システムコール（ゼロコピー）

    エラー時は自動的にshutil.copy2にフォールバックする。

    Args:
        src: コピー元ファイルのパス
        dest: コピー先ファイルのパス

    Returns:
        コピー成功時True、失敗時はFileNotFoundErrorを発生

    Raises:
        FileNotFoundError: ソースファイルが存在しない場合
    """
    if not src.exists():
        raise FileNotFoundError(f"Source file not found: {src}")

    system = platform.system()

    try:
        if system == "Darwin":
            # macOS: clonefile を使用（APFS Copy-on-Write）
            return _fast_copy_macos(src, dest)
        elif system == "Windows":
            # Windows: CopyFileEx API を使用
            return _fast_copy_windows(src, dest)
        elif system == "Linux":
            # Linux: sendfile を使用
            return _fast_copy_linux(src, dest)
        else:
            # その他のプラットフォーム: フォールバック
            shutil.copy2(str(src), str(dest))
            return True
    except Exception as e:
        # エラー時はフォールバック
        try:
            shutil.copy2(str(src), str(dest))
            return True
        except Exception:
            raise


def _fast_copy_macos(src: Path, dest: Path) -> bool:
    """
    macOS専用: clonefileシステムコールを使用した超高速コピー

    APFSファイルシステムでは、Copy-on-Write技術により瞬時にコピーが完了する。
    実際のデータコピーは書き込み時に発生する。

    Args:
        src: コピー元ファイルのパス
        dest: コピー先ファイルのパス

    Returns:
        コピー成功時True
    """
    # macOSのclonefileシステムコールを呼び出す
    # clonefile(const char *src, const char *dst, int flags)
    libc = ctypes.CDLL("/usr/lib/libc.dylib", use_errno=True)

    # CLONE_NOFOLLOW = 0x0001  # シンボリックリンクをフォローしない
    # CLONE_NOOWNERCOPY = 0x0002  # 所有者情報をコピーしない
    flags = 0  # デフォルトフラグ

    src_bytes = str(src).encode('utf-8')
    dest_bytes = str(dest).encode('utf-8')

    # clonefileを実行
    result = libc.clonefile(src_bytes, dest_bytes, flags)

    if result == 0:
        # 成功: タイムスタンプを保持するため、元ファイルのstat情報をコピー
        src_stat = src.stat()
        os.utime(dest, (src_stat.st_atime, src_stat.st_mtime))
        return True
    else:
        # 失敗: エラーコードを確認
        errno = ctypes.get_errno()
        # ENOTSUP (45): clonefileがサポートされていない（HFS+など）
        # EXDEV (18): 異なるファイルシステム間のコピー
        if errno in (45, 18):
            # サポートされていない場合はフォールバック
            shutil.copy2(str(src), str(dest))
            return True
        else:
            raise OSError(errno, f"clonefile failed: {os.strerror(errno)}")


def _fast_copy_windows(src: Path, dest: Path) -> bool:
    """
    Windows専用: CopyFileEx Win32 APIを使用した高速コピー

    Windowsネイティブのコピー機能を使用し、大きなファイルで最適化される。

    Args:
        src: コピー元ファイルのパス
        dest: コピー先ファイルのパス

    Returns:
        コピー成功時True
    """
    # kernel32.dllをロード
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

    # CopyFileW関数のシグネチャを設定
    # BOOL CopyFileW(LPCWSTR lpExistingFileName, LPCWSTR lpNewFileName, BOOL bFailIfExists)
    kernel32.CopyFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_bool]
    kernel32.CopyFileW.restype = ctypes.c_bool

    # CopyFileWを呼び出し (既存ファイルがあれば上書き)
    result = kernel32.CopyFileW(str(src), str(dest), False)

    if not result:
        # エラー発生
        error_code = ctypes.get_last_error()
        raise OSError(f"CopyFileW failed with error code: {error_code}")

    return True


def _fast_copy_linux(src: Path, dest: Path) -> bool:
    """
    Linux専用: sendfileシステムコールを使用した高速コピー

    カーネル空間でゼロコピー転送を行い、ユーザー空間へのコピーを省略する。

    Args:
        src: コピー元ファイルのパス
        dest: コピー先ファイルのパス

    Returns:
        コピー成功時True
    """
    # os.sendfileが利用可能か確認（Linux専用機能）
    if not hasattr(os, 'sendfile'):
        # sendfileが使えない場合はフォールバック
        shutil.copy2(str(src), str(dest))
        return True

    # sendfileを使用してカーネル空間でコピー
    src_fd = os.open(str(src), os.O_RDONLY)
    try:
        src_stat = os.fstat(src_fd)
        dest_fd = os.open(str(dest), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, src_stat.st_mode)
        try:
            # sendfileでコピー
            total_size = src_stat.st_size

            # 空ファイルの場合はスキップ
            if total_size > 0:
                offset = 0
                while offset < total_size:
                    # sendfile(out_fd, in_fd, offset, count)
                    sent = os.sendfile(dest_fd, src_fd, offset, total_size - offset)
                    if sent == 0:
                        break
                    offset += sent

            # タイムスタンプを保持
            os.utime(dest, (src_stat.st_atime, src_stat.st_mtime))

        finally:
            os.close(dest_fd)
    finally:
        os.close(src_fd)

    return True


def calculate_file_checksum(file_path: Path, chunk_size: int = 65536) -> str:
    """
    ファイルのSHA256チェックサムを計算する
    
    Args:
        file_path: チェックサムを計算するファイルのパス
        chunk_size: 読み込みチャンクサイズ（デフォルト64KB）
    
    Returns:
        SHA256ハッシュの16進文字列
    """
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(chunk_size), b""):
            sha256_hash.update(chunk)
    return sha256_hash.hexdigest()


def get_directory_stats(dir_path: Path) -> Tuple[int, int]:
    """
    ディレクトリのファイル数と合計サイズを取得する
    
    Args:
        dir_path: 統計を取得するディレクトリのパス
    
    Returns:
        (ファイル数, 合計サイズ) のタプル
    """
    file_count = 0
    total_size = 0
    for item in dir_path.rglob("*"):
        if item.is_file():
            file_count += 1
            total_size += item.stat().st_size
    return file_count, total_size


def verify_copy(src: Path, dest: Path, use_checksum: bool = False) -> Tuple[bool, str]:
    """
    コピー結果を検証する
    
    Args:
        src: コピー元のパス
        dest: コピー先のパス
        use_checksum: チェックサム検証を使用するか（Falseの場合はサイズ比較のみ）
    
    Returns:
        (成功フラグ, メッセージ) のタプル
    """
    if not dest.exists():
        return False, "コピー先が存在しません"
    
    if src.is_file():
        # ファイルの場合
        src_size = src.stat().st_size
        dest_size = dest.stat().st_size
        if src_size != dest_size:
            return False, f"サイズが一致しません (元: {src_size}, 先: {dest_size})"
        
        if use_checksum:
            src_hash = calculate_file_checksum(src)
            dest_hash = calculate_file_checksum(dest)
            if src_hash != dest_hash:
                return False, "チェックサムが一致しません"
        
        return True, "検証成功"
    
    elif src.is_dir():
        # ディレクトリの場合
        src_count, src_size = get_directory_stats(src)
        dest_count, dest_size = get_directory_stats(dest)
        
        if src_count != dest_count:
            return False, f"ファイル数が一致しません (元: {src_count}, 先: {dest_count})"
        if src_size != dest_size:
            return False, f"合計サイズが一致しません (元: {src_size}, 先: {dest_size})"
        
        if use_checksum:
            # ディレクトリ内の全ファイルをチェックサム検証
            for src_file in src.rglob("*"):
                if src_file.is_file():
                    rel_path = src_file.relative_to(src)
                    dest_file = dest / rel_path
                    if not dest_file.exists():
                        return False, f"ファイルが見つかりません: {rel_path}"
                    src_hash = calculate_file_checksum(src_file)
                    dest_hash = calculate_file_checksum(dest_file)
                    if src_hash != dest_hash:
                        return False, f"チェックサムが一致しません: {rel_path}"
        
        return True, "検証成功"
    
    return False, "不明なファイルタイプ"


def copy_file_worker(args: Tuple[Path, Path]) -> Tuple[Path, bool, str]:
    """
    並列コピー用のワーカー関数（単一ファイルをコピー）
    
    Args:
        args: (コピー元パス, コピー先パス) のタプル
    
    Returns:
        (コピー元パス, 成功フラグ, メッセージ) のタプル
    """
    src, dest = args
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        fast_copy_file(src, dest)
        return (src, True, "成功")
    except Exception as e:
        return (src, False, str(e))


def parallel_copy_directory(
    src: Path,
    dest: Path,
    task_id: Optional[str] = None,
    debug_mode: bool = False
) -> Tuple[bool, str, int, int]:
    """
    ディレクトリを並列コピーする
    
    Args:
        src: コピー元ディレクトリ
        dest: コピー先ディレクトリ
        task_id: タスクID（進捗追跡とキャンセル用）
        debug_mode: デバッグモード
    
    Returns:
        (成功フラグ, メッセージ, 成功数, 失敗数) のタプル
    """
    def log(msg: str):
        if debug_mode:
            print(f"[PARALLEL_COPY] {msg}")
    
    # コピー対象のファイルリストを収集
    copy_tasks: List[Tuple[Path, Path]] = []
    for src_file in src.rglob("*"):
        if src_file.is_file():
            rel_path = src_file.relative_to(src)
            dest_file = dest / rel_path
            copy_tasks.append((src_file, dest_file))
    
    if not copy_tasks:
        # ファイルがない場合（空ディレクトリ）
        dest.mkdir(parents=True, exist_ok=True)
        # 空のサブディレクトリも作成
        for src_dir in src.rglob("*"):
            if src_dir.is_dir():
                rel_path = src_dir.relative_to(src)
                (dest / rel_path).mkdir(parents=True, exist_ok=True)
        return True, "空ディレクトリをコピーしました", 0, 0
    
    total_files = len(copy_tasks)
    log(f"コピー開始: {total_files}ファイル")
    
    # タスクの総ファイル数を更新
    if task_id:
        task = task_manager.get_task(task_id)
        if task:
            task.total_files = total_files
    
    success_count = 0
    fail_count = 0
    errors: List[str] = []
    cancelled = False
    
    # 並列コピー実行
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(copy_file_worker, task): task for task in copy_tasks}
        for future in as_completed(futures):
            # キャンセルチェック
            if task_id and task_manager.is_cancelled(task_id):
                log("キャンセルが検出されました")
                cancelled = True
                executor.shutdown(wait=False, cancel_futures=True)
                break
            
            src_file, success, msg = future.result()
            if success:
                success_count += 1
                log(f"コピー完了 ({success_count}/{total_files}): {src_file.name}")
            else:
                fail_count += 1
                errors.append(f"{src_file.name}: {msg}")
            
            # タスク進捗更新
            if task_id:
                task_manager.update_progress(
                    task_id,
                    processed_files=success_count + fail_count,
                    current_file=src_file.name
                )
    
    if cancelled:
        return False, "キャンセルされました", success_count, fail_count
    
    if fail_count > 0:
        return False, f"一部のファイルでコピー失敗: {', '.join(errors[:3])}", success_count, fail_count
    
    return True, f"{success_count}ファイルをコピーしました", success_count, fail_count


def safe_move(
    src: Path,
    dest: Path,
    verify_checksum: bool = False,
    task_id: Optional[str] = None,
    debug_mode: bool = False
) -> Tuple[bool, str]:
    """
    安全な移動を実行する（コピー → 検証 → 削除）
    
    Args:
        src: 移動元のパス
        dest: 移動先のパス
        verify_checksum: チェックサム検証を使用するか
        task_id: タスクID（非同期モード時に進捗追跡とキャンセルチェック用）
        debug_mode: デバッグモード（ログ出力用）
    
    Returns:
        (成功フラグ, メッセージ) のタプル
    """
    def log(msg: str):
        """デバッグログ出力"""
        if debug_mode:
            print(f"[SAFE_MOVE] {msg}")
    
    def check_cancelled() -> bool:
        """キャンセルチェック"""
        if task_id and task_manager.is_cancelled(task_id):
            log("キャンセルが検出されました")
            return True
        return False
    
    try:
        log(f"開始: {src} -> {dest}")
        
        # キャンセルチェック
        if check_cancelled():
            return False, "キャンセルされました"
        
        # ステップ1: コピー
        log("ステップ1: コピー開始")
        if src.is_file():
            dest.parent.mkdir(parents=True, exist_ok=True)
            fast_copy_file(src, dest)
            log(f"ファイルコピー完了: {src.name}")
        else:
            success, msg, _, fail_count = parallel_copy_directory(src, dest, task_id, debug_mode)
            if not success or fail_count > 0:
                # コピー失敗時はコピー先を削除
                if dest.exists():
                    shutil.rmtree(str(dest))
                return False, f"コピー失敗: {msg}"
        
        # キャンセルチェック
        if check_cancelled():
            # コピー先をクリーンアップ
            if dest.exists():
                if dest.is_file():
                    dest.unlink()
                else:
                    shutil.rmtree(str(dest))
            return False, "キャンセルされました"
        
        # ステップ2: 検証
        log("ステップ2: 検証開始")
        verified, verify_msg = verify_copy(src, dest, verify_checksum)
        if not verified:
            # 検証失敗時はコピー先を削除
            if dest.is_file():
                dest.unlink()
            else:
                shutil.rmtree(str(dest))
            return False, f"検証失敗: {verify_msg}"
        log("検証成功")
        
        # ステップ3: 元ファイル削除
        log("ステップ3: 元ファイル削除")
        try:
            if src.is_file():
                src.unlink()
                log(f"ファイル削除完了: {src.name}")
            else:
                shutil.rmtree(str(src))
                log(f"ディレクトリ削除完了: {src.name}")
        except Exception as del_err:
            log(f"削除エラー: {del_err}")
            return False, f"削除エラー: {str(del_err)}"
        
        log("移動完了")
        return True, "移動完了"
    
    except Exception as e:
        log(f"エラー発生: {str(e)}")
        # エラー時はコピー先を削除して元ファイルを保持
        try:
            if dest.exists():
                if dest.is_file():
                    dest.unlink()
                else:
                    shutil.rmtree(str(dest))
        except Exception:
            pass
        return False, f"移動エラー: {str(e)}"


class MoveRequest(BaseModel):
    """移動リクエストのスキーマ"""

    src_path: str
    dest_path: str


class BatchMoveRequest(BaseModel):
    """一括移動リクエストのスキーマ"""
    src_paths: List[str]
    dest_path: str
    overwrite: bool = True  # デフォルトで上書き
    verify_checksum: bool = False  # チェックサム検証を有効化
    async_mode: bool = False  # 非同期モード（プログレス追跡用）
    debug_mode: bool = False  # デバッグモード（ログ出力用）



@router.post("/move")
async def move_item(request: MoveRequest):
    """
    ファイル/フォルダを安全に移動（コピー → 検証 → 削除）

    Args:
        request: 移動リクエスト（元パスと移動先パスを含む）

    Returns:
        移動成功メッセージ
    """
    src_path = normalize_path(request.src_path)
    dest_path = normalize_path(request.dest_path)

    if not src_path.exists():
        raise HTTPException(status_code=404, detail="移動元のファイル/フォルダが見つかりません")

    # 移動先がディレクトリの場合、その中に移動する
    if dest_path.is_dir():
        final_dest = dest_path / src_path.name
    else:
        # 移動先がディレクトリでない（新規ファイル名など）場合はそのまま使用
        final_dest = dest_path

    # 移動先に同名ファイル/フォルダが存在する場合は削除（上書き）
    if final_dest.exists():
        if final_dest.is_dir():
            shutil.rmtree(str(final_dest))
        else:
            final_dest.unlink()

    # 自分自身のサブディレクトリへの移動をチェック
    try:
        if src_path.is_dir() and str(final_dest.resolve()).startswith(str(src_path.resolve())):
             raise HTTPException(status_code=400, detail="自分自身のサブディレクトリには移動できません")
    except ValueError:
        pass # パス関係のエラーは無視して続行

    # 安全な移動を実行（コピー → 検証 → 削除）
    success, message = safe_move(src_path, final_dest, verify_checksum=False)
    if success:
        return {"status": "success", "message": f"移動しました: {src_path} → {final_dest}"}
    else:
        raise HTTPException(status_code=500, detail=f"移動に失敗しました: {message}")

@router.post("/move/batch")
async def move_items_batch(request: BatchMoveRequest, background_tasks: BackgroundTasks):
    """
    複数のファイル/フォルダを安全に移動（コピー → 検証 → 削除）
    
    並列コピーを使用して高速化し、検証後に元ファイルを削除する。
    verify_checksum が True の場合、SHA256によるチェックサム検証を行う。
    async_mode が True の場合、バックグラウンドで処理しタスクIDを返す。
    """
    dest_path = normalize_path(request.dest_path)
    
    # 移動先が存在しない場合はエラー
    if not dest_path.exists():
         raise HTTPException(status_code=404, detail="移動先フォルダが見つかりません")
    
    if not dest_path.is_dir():
         raise HTTPException(status_code=400, detail="移動先はディレクトリである必要があります")

    if request.debug_mode:
        print(f"[BATCH_MOVE] 開始: Dest={dest_path}, Sources={request.src_paths}, Async={request.async_mode}")

    # 非同期モードの場合
    if request.async_mode:
        # タスクを作成
        task = task_manager.create_task(total_files=len(request.src_paths))
        task_manager.set_running(task.id)
        
        # バックグラウンドスレッドで処理
        def run_batch_move():
            _execute_batch_move(
                task_id=task.id,
                src_paths=request.src_paths,
                dest_path=dest_path,
                overwrite=request.overwrite,
                verify_checksum=request.verify_checksum,
                debug_mode=request.debug_mode
            )
        
        thread = threading.Thread(target=run_batch_move, daemon=True)
        thread.start()
        
        return {"status": "async", "task_id": task.id}
    
    # 同期モード（従来通り）
    return _execute_batch_move_sync(
        src_paths=request.src_paths,
        dest_path=dest_path,
        overwrite=request.overwrite,
        verify_checksum=request.verify_checksum,
        debug_mode=request.debug_mode
    )


def _execute_batch_move(
    task_id: str,
    src_paths: List[str],
    dest_path: Path,
    overwrite: bool,
    verify_checksum: bool,
    debug_mode: bool
):
    """
    バッチ移動をバックグラウンドで実行する（Producer-Consumerパターン）
    スキャンとコピーを並列化して開始遅延を解消
    """
    import queue
    import time
    
    def log(msg: str):
        if debug_mode:
            print(f"[BATCH_MOVE:{task_id[:8]}] {msg}")

    task_manager.set_running(task_id)
    # 即座に準備中を表示
    task_manager.update_progress(task_id, processed_files=0, current_file="準備中...")
    log(f"移動開始: {len(src_paths)} パス -> {dest_path}")

    # キュー: (action, src_item, dest_item, root_src_path)
    # action: "copy_file", "mkdir", "delete_file", "delete_dir"
    work_queue = queue.Queue(maxsize=10000)
    
    # 結果管理
    results_lock = threading.Lock()
    results = []
    stats = {"success": 0, "fail": 0, "total_files_discovered": 0}

    # パス毎のエラー情報を保持
    path_errors = {}  # {src_path_str: error_message}

    # コピー成功したルートパスを記録（削除用）
    successfully_copied_roots = []  # [Path, ...]

    # 完了フラグ
    scan_complete = threading.Event()
    
    # 初期の予定総数を仮設定（進捗バーを動かすため）
    initial_estimate = len(src_paths) * 10
    task_manager.get_task(task_id).total_files = initial_estimate

    # ---------------------------------------------------------
    # スキャナー（Producer）: ディレクトリを走査してキューに入れる
    # ---------------------------------------------------------
    def scanner_thread():
        log("スキャン開始")
        total_discovered = 0
        
        for src_str in src_paths:
            # キャンセルチェック（ループ毎）
            if task_manager.is_cancelled(task_id):
                break
                
            try:
                src_path = normalize_path(src_str)
                if not src_path.exists():
                    with results_lock:
                        path_errors[src_str] = "ファイルが見つかりません"
                        results.append({"path": src_str, "status": "error", "message": "ファイルが見つかりません"})
                        stats["fail"] += 1
                    continue
                
                # 自分自身のサブディレクトリへの移動チェック
                if src_path.is_dir():
                    try:
                        if str(dest_path.resolve()).startswith(str(src_path.resolve())):
                            with results_lock:
                                path_errors[src_str] = "自分自身のサブディレクトリには移動できません"
                                results.append({"path": src_str, "status": "error", "message": "自分自身のサブディレクトリには移動できません"})
                                stats["fail"] += 1
                            continue
                    except ValueError:
                        pass

                final_dest = dest_path / src_path.name
                
                # 同一パスチェック
                try:
                    if src_path.resolve() == final_dest.resolve():
                        with results_lock:
                            results.append({"path": src_str, "status": "success", "message": "移動元と移動先が同じです"})
                            stats["success"] += 1
                        continue
                except OSError:
                    pass

                # ファイル/ディレクトリの場合分け
                if src_path.is_file():
                    work_queue.put(("copy_file", src_path, final_dest, src_path))
                    total_discovered += 1
                    with results_lock:
                        stats["total_files_discovered"] += 1
                        # 移動（コピー+削除）なので2カウント
                        task_manager.get_task(task_id).total_files = stats["total_files_discovered"] * 2
                
                elif src_path.is_dir():
                    # まずルートディレクトリ作成タスク
                    work_queue.put(("mkdir", src_path, final_dest, src_path))
                    
                    # 再帰的にスキャン (os.scandir使用で高速化)
                    # delete用のリストは、コピー完了後に「深い順」に処理する必要があるため
                    # ここではコピー順序（浅い順）でキューに入れ、削除はコピー完了を待つか、
                    # あるいは別の戦略をとる。
                    # 「移動」はコピー成功後に削除なので、ファイル単位で「コピー→削除」はできない（ディレクトリが消せない）
                    # したがって、コピーフェーズと削除フェーズを分ける。
                    
                    # scan_treeはジェネレータ
                    for root, dirs, files in os.walk(str(src_path)):
                        if task_manager.is_cancelled(task_id):
                            break
                            
                        root_path = Path(root)
                        rel_path = root_path.relative_to(src_path)
                        current_dest_dir = final_dest / rel_path
                        
                        # ディレクトリ作成
                        for d in dirs:
                            d_src = root_path / d
                            d_dest = current_dest_dir / d
                            work_queue.put(("mkdir", d_src, d_dest, src_path))
                        
                        # ファイルコピー
                        for f in files:
                            f_src = root_path / f
                            f_dest = current_dest_dir / f
                            work_queue.put(("copy_file", f_src, f_dest, src_path))
                            
                            total_discovered += 1
                            if total_discovered % 10 == 0:
                                with results_lock:
                                    stats["total_files_discovered"] = total_discovered
                                    # 移動操作なので x2
                                    task_manager.get_task(task_id).total_files = total_discovered * 2 + 100 # バッファ

            except Exception as e:
                with results_lock:
                    path_errors[src_str] = str(e)
                    results.append({"path": src_str, "status": "error", "message": f"Scan error: {e}"})
                    stats["fail"] += 1
                continue  # エラーがあった場合は次のパスへ

            # スキャンが成功した場合、後で削除するためにルートパスを記録
            with results_lock:
                successfully_copied_roots.append(src_path)

        log(f"スキャン完了: {total_discovered} ファイル")
        with results_lock:
             stats["total_files_discovered"] = total_discovered
             task_manager.get_task(task_id).total_files = total_discovered * 2
        scan_complete.set()

    # ---------------------------------------------------------
    # ワーカー（Consumer）: キューから取り出して実行
    # ---------------------------------------------------------
    def worker_thread():
        while True:
            try:
                # タイムアウト付きで取得して完了チェック
                item = work_queue.get(timeout=0.1)
            except queue.Empty:
                if scan_complete.is_set():
                    break
                continue
                
            # キャンセルフラグで処理をスキップ（task_done()はfinallyで必ず呼ぶ）
            cancelled = task_manager.is_cancelled(task_id)

            action, src, dest, root_src = item

            try:
                # キャンセルされている場合は処理をスキップ
                if cancelled:
                    continue

                if action == "copy_file":
                    # 親ディレクトリ作成はmkdirタスクで行われるが、念のため
                    dest.parent.mkdir(parents=True, exist_ok=True)

                    # 上書きチェック
                    if dest.exists():
                        if overwrite:
                            if dest.is_dir():
                                shutil.rmtree(str(dest))
                            else:
                                dest.unlink()
                        else:
                            # スキップ（task_done()はfinallyで呼ぶ）
                            with results_lock:
                                stats["fail"] += 1
                                # エラーログ等は省略
                            continue

                    fast_copy_file(src, dest)

                    if verify_checksum:
                        if calculate_file_checksum(src) != calculate_file_checksum(dest):
                            raise Exception("Checksum mismatch")

                    with results_lock:
                        stats["success"] += 1
                        processed = stats["success"] + stats["fail"]
                        task_manager.update_progress(task_id, processed_files=processed, current_file=f"コピー: {src.name}")
                    
                    log(f"コピー成功: {src.name} -> {dest.name}")

                elif action == "mkdir":
                    dest.mkdir(parents=True, exist_ok=True)
                    log(f"ディレクトリ作成: {dest.name}")
            
            except Exception as e:
                log(f"Error {action} {src}: {e}")
                with results_lock:
                    stats["fail"] += 1
                    path_errors[str(root_src)] = str(e) # 親パスにエラーを紐付け
            
            finally:
                work_queue.task_done()

    # スレッド開始
    scanner = threading.Thread(target=scanner_thread, daemon=True)
    scanner.start()
    
    workers = []
    for _ in range(MAX_WORKERS):
        t = threading.Thread(target=worker_thread, daemon=True)
        t.start()
        workers.append(t)
        
    # コピー完了を待機
    scanner.join()
    for t in workers:
        t.join()
        
    log("コピーフェーズ完了。削除フェーズ開始")
    
    # ---------------------------------------------------------
    # 削除フェーズ（移動の場合のみ）
    # ---------------------------------------------------------
    # コピーでエラーが出ていない root_src のみを削除対象とする
    
    del_success = 0
    del_fail = 0

    # ===============================================================
    # ステップ2: 削除フェーズ（コピーが成功したルートパスのみ削除）
    # ===============================================================
    log(f"削除フェーズ開始: {len(successfully_copied_roots)} パス")

    if not successfully_copied_roots:
        log("削除可能なパスがありません")
    else:
        for root_path in successfully_copied_roots:
            # コピーエラーがあったパスはスキップ
            if str(root_path) in path_errors:
                log(f"コピーエラーがあったためスキップ: {root_path}")
                continue

            if task_manager.is_cancelled(task_id):
                log("キャンセルが検出されました")
                break

            try:
                if not root_path.exists():
                    log(f"既に削除済み: {root_path}")
                    continue

                log(f"削除中: {root_path}")
                task_manager.update_progress(task_id, processed_files=stats["success"], current_file=f"削除: {root_path.name}")

                # ディレクトリまたはファイルを削除
                if root_path.is_dir():
                    shutil.rmtree(str(root_path))
                    log(f"ディレクトリ削除完了: {root_path}")
                else:
                    root_path.unlink()
                    log(f"ファイル削除完了: {root_path}")

            except Exception as e:
                log(f"削除エラー: {root_path} - {e}")
                # 削除エラーは致命的ではないので、エラー情報を記録して続行
                with results_lock:
                    path_errors[str(root_path)] = f"削除エラー: {str(e)}"
    
    # 最終結果
    log(f"全完了: 成功={stats['success']}, 失敗={stats['fail']}")
    
    # Resultsリスト作成（ルートごとの結果）
    final_results = []
    for src_str in src_paths:
        if src_str in path_errors:
             final_results.append({"path": src_str, "status": "error", "message": path_errors[src_str]})
        else:
             final_results.append({"path": src_str, "status": "success", "message": "移動完了"})

    task_manager.complete_task(task_id, result={
        "status": "completed",
        "success_count": stats["success"],
        "fail_count": stats["fail"],
        "results": final_results
    })


def _execute_batch_move_sync(
    src_paths: List[str],
    dest_path: Path,
    overwrite: bool,
    verify_checksum: bool,
    debug_mode: bool
):
    """
    バッチ移動を同期で実行する（従来モード）
    """
    results = []
    success_count = 0
    fail_count = 0

    for src_str in src_paths:
        src_path = normalize_path(src_str)
        result = {"path": src_str, "status": "pending", "message": ""}

        if not src_path.exists():
            result["status"] = "error"
            result["message"] = "ファイルが見つかりません"
            fail_count += 1
            results.append(result)
            continue

        try:
            if src_path.is_dir() and str(dest_path.resolve()).startswith(str(src_path.resolve())):
                 result["status"] = "error"
                 result["message"] = "自分自身のサブディレクトリには移動できません"
                 fail_count += 1
                 results.append(result)
                 continue
            
            final_dest = dest_path / src_path.name

            try:
                if src_path.resolve() == final_dest.resolve():
                    result["status"] = "success"
                    result["message"] = "移動元と移動先が同じです"
                    success_count += 1
                    results.append(result)
                    continue
            except OSError:
                pass

            if final_dest.exists():
                if overwrite:
                    if final_dest.is_dir():
                        shutil.rmtree(final_dest)
                    else:
                        final_dest.unlink()
                else:
                     result["status"] = "error"
                     result["message"] = "同名のファイルが存在します"
                     fail_count += 1
                     results.append(result)
                     continue

            success, message = safe_move(src_path, final_dest, verify_checksum, None, debug_mode)
            if success:
                result["status"] = "success"
                result["message"] = "移動完了"
                success_count += 1
            else:
                result["status"] = "error"
                result["message"] = message
                fail_count += 1
            
        except Exception as e:
            result["status"] = "error"
            result["message"] = str(e)
            fail_count += 1
        
        results.append(result)

    return {
        "status": "completed", 
        "success_count": success_count, 
        "fail_count": fail_count,
        "results": results
    }


def _execute_batch_copy_async(
    task_id: str,
    src_paths: List[str],
    dest_path: Path,
    overwrite: bool,
    verify_checksum: bool,
    debug_mode: bool
):
    """
    バッチコピーを実行（Producer-Consumerパターン）
    スキャンとコピーを並列化して開始遅延を解消
    """
    import queue
    import time

    def log(msg: str):
        if debug_mode:
            print(f"[BATCH_COPY] {msg}")

    task_manager.set_running(task_id)
    # 即座に準備中を表示
    task_manager.update_progress(task_id, processed_files=0, current_file="準備中...")
    log(f"コピー開始: {len(src_paths)} パス -> {dest_path}")

    # キュー: (action, src_item, dest_item, root_src_path)
    # action: "copy_file", "mkdir"
    work_queue = queue.Queue(maxsize=10000)
    
    # 結果管理
    results_lock = threading.Lock()
    results = []
    stats = {"success": 0, "fail": 0, "total_files_discovered": 0}
    path_errors = {}
    
    # 完了フラグ
    scan_complete = threading.Event()
    
    # 初期見積もり
    task_manager.get_task(task_id).total_files = len(src_paths) * 10

    # ---------------------------------------------------------
    # スキャナー（Producer）
    # ---------------------------------------------------------
    def scanner_thread():
        log("スキャン開始")
        total_discovered = 0
        
        for src_str in src_paths:
            if task_manager.is_cancelled(task_id): break
                
            try:
                src_path = normalize_path(src_str)
                if not src_path.exists():
                    with results_lock:
                        path_errors[src_str] = "ファイルが見つかりません"
                        results.append({"path": src_str, "status": "error", "message": "ファイルが見つかりません"})
                        stats["fail"] += 1
                    continue

                # 自分自身のサブディレクトリへのコピーチェック
                if src_path.is_dir():
                    try:
                        if str(dest_path.resolve()).startswith(str(src_path.resolve())):
                            with results_lock:
                                path_errors[src_str] = "自分自身のサブディレクトリにはコピーできません"
                                results.append({"path": src_str, "status": "error", "message": "自分自身のサブディレクトリにはコピーできません"})
                                stats["fail"] += 1
                            continue
                    except ValueError:
                        pass
                
                final_dest = dest_path / src_path.name
                
                # 同一ファイルへのコピーチェック
                try:
                    if src_path.resolve() == final_dest.resolve():
                        with results_lock:
                            # エラーとするかスキップするか。Windowsだとエラーになる。
                            path_errors[src_str] = "同一ファイルへのコピーはできません"
                            results.append({"path": src_str, "status": "error", "message": "同一ファイルへのコピーはできません"})
                            stats["fail"] += 1
                        continue
                except OSError:
                    pass

                # ファイル/ディレクトリの場合分け
                if src_path.is_file():
                    work_queue.put(("copy_file", src_path, final_dest, src_path))
                    total_discovered += 1
                    with results_lock:
                        stats["total_files_discovered"] += 1
                        task_manager.get_task(task_id).total_files = stats["total_files_discovered"]
                
                elif src_path.is_dir():
                    work_queue.put(("mkdir", src_path, final_dest, src_path))
                    
                    # 再帰的にスキャン
                    for root, dirs, files in os.walk(str(src_path)):
                        if task_manager.is_cancelled(task_id): break
                            
                        root_path = Path(root)
                        rel_path = root_path.relative_to(src_path)
                        current_dest_dir = final_dest / rel_path
                        
                        for d in dirs:
                            d_src = root_path / d
                            d_dest = current_dest_dir / d
                            work_queue.put(("mkdir", d_src, d_dest, src_path))
                        
                        for f in files:
                            f_src = root_path / f
                            f_dest = current_dest_dir / f
                            work_queue.put(("copy_file", f_src, f_dest, src_path))
                            
                            total_discovered += 1
                            if total_discovered % 100 == 0:
                                with results_lock:
                                    stats["total_files_discovered"] = total_discovered
                                    task_manager.get_task(task_id).total_files = total_discovered + 100

            except Exception as e:
                with results_lock:
                    path_errors[src_str] = str(e)
                    results.append({"path": src_str, "status": "error", "message": f"Scan error: {e}"})
                    stats["fail"] += 1

        log(f"スキャン完了: {total_discovered} ファイル")
        with results_lock:
             stats["total_files_discovered"] = total_discovered
             task_manager.get_task(task_id).total_files = total_discovered
        scan_complete.set()

    # ---------------------------------------------------------
    # ワーカー（Consumer）
    # ---------------------------------------------------------
    def worker_thread():
        while True:
            try:
                item = work_queue.get(timeout=0.1)
            except queue.Empty:
                if scan_complete.is_set():
                    break
                continue
                
            # キャンセルフラグで処理をスキップ（task_done()はfinallyで必ず呼ぶ）
            cancelled = task_manager.is_cancelled(task_id)

            action, src, dest, root_src = item

            try:
                # キャンセルされている場合は処理をスキップ
                if cancelled:
                    continue

                if action == "copy_file":
                    dest.parent.mkdir(parents=True, exist_ok=True)

                    if dest.exists():
                        if overwrite:
                            if dest.is_dir():
                                shutil.rmtree(str(dest))
                            else:
                                dest.unlink()
                        else:
                            # スキップ（task_done()はfinallyで呼ぶ）
                            with results_lock:
                                stats["fail"] += 1
                            continue

                    fast_copy_file(src, dest)

                    if verify_checksum:
                        if calculate_file_checksum(src) != calculate_file_checksum(dest):
                            raise Exception("Checksum mismatch")

                    with results_lock:
                        stats["success"] += 1
                        processed = stats["success"] + stats["fail"]
                        task_manager.update_progress(task_id, processed_files=processed, current_file=f"コピー: {src.name}")
                    
                    log(f"コピー成功: {src.name} -> {dest.name}")

                elif action == "mkdir":
                    dest.mkdir(parents=True, exist_ok=True)
                    log(f"ディレクトリ作成: {dest.name}")
            
            except Exception as e:
                log(f"Error {action} {src}: {e}")
                with results_lock:
                    stats["fail"] += 1
                    path_errors[str(root_src)] = str(e)
            
            finally:
                work_queue.task_done()

    # スレッド開始
    scanner = threading.Thread(target=scanner_thread, daemon=True)
    scanner.start()
    
    workers = []
    for _ in range(MAX_WORKERS):
        t = threading.Thread(target=worker_thread, daemon=True)
        t.start()
        workers.append(t)
        
    scanner.join()
    for t in workers:
        t.join()
        
    # 最終結果
    log(f"全完了: 成功={stats['success']}, 失敗={stats['fail']}")
    
    final_results = []
    for src_str in src_paths:
        if src_str in path_errors:
             final_results.append({"path": src_str, "status": "error", "message": path_errors[src_str]})
        else:
             final_results.append({"path": src_str, "status": "success", "message": "コピー完了"})

    task_manager.complete_task(task_id, result={
        "status": "completed",
        "success_count": stats["success"],
        "fail_count": stats["fail"],
        "results": final_results
    })

class BatchCopyRequest(BaseModel):
    """一括コピーリクエストのスキーマ"""
    src_paths: List[str]
    dest_path: str
    overwrite: bool = True  # デフォルトで上書き
    verify_checksum: bool = False
    async_mode: bool = False  # 非同期モード
    debug_mode: bool = False  # デバッグモード


@router.post("/copy/batch")
async def copy_items_batch(request: BatchCopyRequest):
    dest_path = normalize_path(request.dest_path)
    
    if not dest_path.exists() or not dest_path.is_dir():
         raise HTTPException(status_code=404, detail="コピー先フォルダが見つかりません")

    # 非同期モードの場合
    if request.async_mode:
        task = task_manager.create_task(total_files=len(request.src_paths))
        task_id = task.id
        
        def run_copy():
            _execute_batch_copy_async(
                task_id, request.src_paths, dest_path, 
                request.overwrite, request.verify_checksum, request.debug_mode
            )
        
        thread = threading.Thread(target=run_copy)
        thread.start()
        
        return {"status": "async", "task_id": task_id, "message": "コピー処理を開始しました"}

    # 同期モードの場合（従来の処理）
    results = []
    success_count = 0
    fail_count = 0

    import shutil

    def get_unique_path(base_dir: Path, name: str) -> Path:
        """
        同名ファイルが存在する場合、ユニークな名前を生成する
        example.txt -> example copy.txt -> example copy 2.txt
        """
        candidate = base_dir / name
        if not candidate.exists():
            return candidate

        stem = candidate.stem
        suffix = candidate.suffix
        
        candidate = base_dir / f"{stem} copy{suffix}"
        if not candidate.exists():
            return candidate
            
        counter = 2
        while True:
             candidate = base_dir / f"{stem} copy {counter}{suffix}"
             if not candidate.exists():
                 return candidate
             counter += 1

    for src_str in request.src_paths:
        src_path = normalize_path(src_str)
        result = {"path": src_str, "status": "pending", "message": ""}

        if not src_path.exists():
            result["status"] = "error"
            result["message"] = "ファイルが見つかりません"
            fail_count += 1
            results.append(result)
            continue

        try:
            # 自分自身のサブディレクトリへのコピーチェック（ディレクトリの場合）
            if src_path.is_dir() and str(dest_path.resolve()).startswith(str(src_path.resolve())):
                 result["status"] = "error"
                 result["message"] = "自分自身のサブディレクトリにはコピーできません"
                 fail_count += 1
                 results.append(result)
                 continue
            
            # デスティネーションの決定
            final_dest = dest_path / src_path.name
            
            # 同一ファイルへのコピーをチェック
            try:
                if src_path.resolve() == final_dest.resolve():
                    result["status"] = "error"
                    result["message"] = "同一ファイルへのコピーはできません"
                    fail_count += 1
                    results.append(result)
                    continue
            except OSError:
                pass

            if final_dest.exists():
                if request.overwrite:
                    # 上書きの場合、削除してからコピー
                    if final_dest.is_dir():
                        shutil.rmtree(final_dest)
                    else:
                        final_dest.unlink()
                else:
                    # 上書きでない場合、同名チェック（自動リネーム廃止）
                    result["status"] = "error"
                    result["message"] = "同名のファイルが存在します"
                    fail_count += 1
                    results.append(result)
                    continue

            if src_path.is_dir():
                shutil.copytree(str(src_path), str(final_dest))
            else:
                fast_copy_file(src_path, final_dest)

            result["status"] = "success"
            result["message"] = f"コピーしました: {final_dest.name}"
            success_count += 1
            
        except Exception as e:
            result["status"] = "error"
            result["message"] = str(e)
            fail_count += 1
        
        results.append(result)

    return {
        "status": "completed", 
        "success_count": success_count, 
        "fail_count": fail_count,
        "results": results
    }

class OpenRequest(BaseModel):
    path: str
    prefer_embedded: bool = False


PROGRAM_CODE_EXTENSIONS = {
    ".py",
    ".pyw",
    ".sh",
    ".bash",
    ".zsh",
    ".command",
    ".bat",
    ".cmd",
    ".ps1",
}


def _is_program_code_file(path: Path) -> bool:
    """右クリックメニュー拡張対象のプログラムコードファイルか判定する。"""
    return path.is_file() and path.suffix.lower() in PROGRAM_CODE_EXTENSIONS


def _ensure_program_code_file(path: Path) -> None:
    """プログラムコードファイルでない場合はエラーを返す。"""
    if not path.exists():
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")
    if not path.is_file():
        raise HTTPException(status_code=400, detail="ファイルを指定してください")
    if not _is_program_code_file(path):
        raise HTTPException(status_code=400, detail="プログラムコードファイルのみ対応しています")


def _build_editor_open_command(path: Path) -> List[str]:
    """OSごとのテキストエディター起動コマンドを返す。"""
    system = platform.system()
    if system == "Darwin":
        return ["open", "-a", "TextEdit", str(path)]
    if system == "Windows":
        return ["notepad.exe", str(path)]
    return ["xdg-open", str(path)]


def _build_execute_command(path: Path) -> List[str]:
    """拡張子に応じた実行コマンドを返す。"""
    system = platform.system()
    suffix = path.suffix.lower()

    if suffix in {".py", ".pyw"}:
        return ["py", str(path)] if system == "Windows" else ["python3", str(path)]
    if suffix in {".sh", ".bash", ".command"}:
        return ["bash", str(path)]
    if suffix == ".zsh":
        return ["zsh", str(path)]
    if suffix in {".bat", ".cmd"}:
        if system != "Windows":
            raise HTTPException(status_code=400, detail=f"{suffix} はこのOSでは実行できません")
        return ["cmd", "/c", str(path)]
    if suffix == ".ps1":
        if system == "Windows":
            return ["powershell", "-ExecutionPolicy", "Bypass", "-File", str(path)]
        raise HTTPException(status_code=400, detail=".ps1 はこのOSでは実行できません")

    raise HTTPException(status_code=400, detail="このファイルは実行対象外です")

@router.post("/open/vscode")
async def open_in_vscode(request: OpenRequest):
    """
    指定されたパスをVS Codeで開く
    """
    path = normalize_path(request.path)
    
    if platform.system() == 'Darwin':
        vscode_path = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
        # Fallback for other locations or names if needed
        if not os.path.exists(vscode_path):
             # Try generic 'code' command
             vscode_path = 'code'
    elif platform.system() == 'Windows':
        vscode_path = os.path.join(os.environ["USERPROFILE"], r"AppData\Local\Programs\Microsoft VS Code\Code.exe")
    else:
        raise HTTPException(status_code=501, detail="サポートされていないOSです")

    # ファイル/フォルダが存在するか確認
    target_path = path if path.exists() else path.parent

    try:
        if platform.system() == 'Darwin':
             # macOS specific AppleScript for focus (optional, keeping simple subprocess first)
             subprocess.Popen([vscode_path, str(target_path)])
        else:
             subprocess.Popen([vscode_path, str(target_path)])
        return {"status": "success", "message": "VS Codeで開きました"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"VS Codeの起動に失敗しました: {str(e)}")


@router.post("/open/editor")
async def open_in_editor(request: OpenRequest):
    """
    指定されたプログラムコードファイルをテキストエディターで開く
    """
    path = normalize_path(request.path)
    _ensure_program_code_file(path)

    try:
        subprocess.Popen(_build_editor_open_command(path))
        return {"status": "success", "message": "エディターで開きました"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"エディターの起動に失敗しました: {str(e)}")


@router.post("/open/execute")
async def execute_program_code(request: OpenRequest):
    """
    指定されたプログラムコードファイルを実行する
    """
    path = normalize_path(request.path)
    _ensure_program_code_file(path)

    try:
        popen_kwargs = {"cwd": str(path.parent)}
        if platform.system() == "Windows":
            popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
        subprocess.Popen(_build_execute_command(path), **popen_kwargs)
        return {"status": "success", "message": "実行を開始しました"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"実行に失敗しました: {str(e)}")

@router.post("/open/explorer")
async def open_in_explorer(request: OpenRequest):
    """
    指定されたパスをエクスプローラー/Finderで開く
    """
    path = normalize_path(request.path)
    target_path = path if path.is_dir() else path.parent
    
    if not target_path.exists():
         raise HTTPException(status_code=404, detail="パスが見つかりません")

    try:
        if platform.system() == "Windows":
            process = subprocess.Popen(['explorer', str(target_path).replace('/', '\\')])
            _bring_explorer_to_front(process.pid, target_path)
        elif platform.system() == "Darwin":
            subprocess.Popen(["open", str(target_path)])
        else:
            subprocess.Popen(["xdg-open", str(target_path)])
        return {"status": "success", "message": "フォルダを開きました"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"フォルダを開けませんでした: {str(e)}")

@router.get("/download")
async def download_file(path: str = Query(..., description="ダウンロードするファイルのパス")):
    """
    ファイルをダウンロード
    """
    target_path = normalize_path(path)
    
    if not target_path.exists():
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")
    
    if target_path.is_dir():
         raise HTTPException(status_code=400, detail="ディレクトリはダウンロードできません（ZIP機能未実装）")

    return FileResponse(
        path=target_path,
        filename=target_path.name,
        media_type='application/octet-stream'
    )

@router.get("/view-pdf")
async def view_pdf(path: str = Query(..., description="表示するPDFファイルのパス")):
    """
    PDFファイルをブラウザ内で表示（ダウンロードではなくインライン表示）
    """
    target_path = normalize_path(path)

    if not target_path.exists():
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")

    if target_path.is_dir():
        raise HTTPException(status_code=400, detail="ディレクトリは表示できません")

    if not target_path.name.lower().endswith('.pdf'):
        raise HTTPException(status_code=400, detail="PDFファイルではありません")

    # 日本語ファイル名に対応するため、RFC 2231形式でエンコード
    encoded_filename = urllib.parse.quote(target_path.name)

    return FileResponse(
        path=target_path,
        filename=target_path.name,
        media_type='application/pdf',
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{encoded_filename}"}
    )


@router.get("/view-html")
async def view_html(path: str = Query(..., description="表示するHTMLファイルのパス")):
    """
    HTMLファイルをブラウザ内で表示（ソースコードではなくレンダリングプレビュー表示）
    """
    target_path = normalize_path(path)

    if not target_path.exists():
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")

    if target_path.is_dir():
        raise HTTPException(status_code=400, detail="ディレクトリは表示できません")

    name_lower = target_path.name.lower()
    if not (name_lower.endswith('.html') or name_lower.endswith('.htm')):
        raise HTTPException(status_code=400, detail="HTMLファイルではありません")

    # 日本語ファイル名に対応するため、RFC 2231形式でエンコード
    encoded_filename = urllib.parse.quote(target_path.name)

    return FileResponse(
        path=target_path,
        filename=target_path.name,
        media_type='text/html; charset=utf-8',
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{encoded_filename}"}
    )



@router.post("/open/default")
async def open_in_default_app(request: OpenRequest):
    """
    指定されたファイルをOSのデフォルトアプリケーションで開く
    """
    path = normalize_path(request.path)
    
    if not path.exists():
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")

    try:
        if platform.system() == "Windows":
            os.startfile(str(path))
        elif platform.system() == "Darwin":  # macOS
            subprocess.Popen(["open", str(path)])
        else:  # Linux
            subprocess.Popen(["xdg-open", str(path)])
        return {"status": "success", "message": "ファイルを開きました"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ファイルを開けませんでした: {str(e)}")


class SmartOpenResponse(BaseModel):
    """
    スマートオープンの結果
    action: 実行されたアクション
    - "opened": 外部アプリで開いた
    - "open_modal": フロントエンドでモーダルを開く（内蔵エディタ用）
    - "open_url": フロントエンドでURLを開く（PDF等）
    """
    status: str
    action: str
    message: str
    content: Optional[str] = None  # action=open_modalの場合のファイル内容
    url: Optional[str] = None  # action=open_urlの場合のURL
    editor_mode: Optional[str] = None  # "markdown" | "code"
    language: Optional[str] = None  # シンタックスハイライト用の言語ID


EMBEDDED_EDITOR_LANGUAGE_MAP = {
    ".md": "markdown",
    ".txt": "plaintext",
    ".log": "plaintext",
    ".text": "plaintext",
    ".json": "json",
    ".jsonc": "json",
    ".js": "javascript",
    ".jsx": "jsx",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".py": "python",
    ".pyw": "python",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".command": "shell",
    ".bat": "batch",
    ".cmd": "batch",
    ".ps1": "powershell",
    ".css": "css",
    ".scss": "css",
    ".html": "html",
    ".htm": "html",
    ".xml": "xml",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".toml": "toml",
    ".ini": "ini",
    ".cfg": "ini",
    ".conf": "ini",
    ".sql": "sql",
    ".csv": "plaintext",
}

EMBEDDED_EDITOR_SPECIAL_FILENAMES = {
    "dockerfile": "plaintext",
    "makefile": "plaintext",
}


def _get_embedded_editor_language(path: Path) -> Optional[str]:
    """内蔵エディタで扱うファイルの言語IDを返す。"""
    if not path.exists() or not path.is_file():
        return None

    lower_name = path.name.lower()
    if lower_name in EMBEDDED_EDITOR_SPECIAL_FILENAMES:
        return EMBEDDED_EDITOR_SPECIAL_FILENAMES[lower_name]
    if lower_name.startswith(".env"):
        return "dotenv"

    return EMBEDDED_EDITOR_LANGUAGE_MAP.get(path.suffix.lower())


def _is_excalidraw_markdown(path: Path) -> bool:
    """Excalidraw用のMarkdownファイルか判定する。"""
    lower_name = path.name.lower()
    return ".excalidraw" in lower_name and lower_name.endswith(".md")


def resolve_file_app_url(path_obj: Path) -> Optional[str]:
    """
    ファイルパスから、専用アプリで開くためのURL/URIを解決する
    - Excalidraw -> http://localhost:3001/...
    - Jupyter -> http://localhost:8888/...
    - Obsidian -> obsidian://...
    - PDF -> /api/view-pdf...
    
    該当しない場合は None を返す
    """

    start_path = str(path_obj).lower()

    # --- Excalidraw ---
    # ファイル名に .excalidraw が含まれていればExcalidrawとして扱う
    # (例: file.excalidraw.md, file.excalidraw 1.md)
    name_lower = path_obj.name.lower()
    if '.excalidraw' in name_lower:
        if (name_lower.endswith('.excalidraw') or 
            name_lower.endswith('.md') or 
            name_lower.endswith('.svg') or 
            name_lower.endswith('.png')):
            
            encoded_path = urllib.parse.quote(str(path_obj))
            return f"http://localhost:3001/?filepath={encoded_path}"

    # --- Jupyter (.ipynb) ---
    if start_path.endswith('.ipynb'):
        # Windows specific logic: Port 8082, Root %USERPROFILE%/000_work
        if platform.system() == 'Windows':
            JUPYTER_BASE_URL = "http://localhost:8082/tree"
            user_profile = os.environ.get("USERPROFILE")
            if user_profile:
                jupyter_root = Path(user_profile) / "000_work"
                try:
                    # Calculate path relative to 000_work
                    # Note: We need to resolve paths to ensure correct relative calculation
                    resolved_path = path_obj.resolve()
                    resolved_root = jupyter_root.resolve()
                    
                    if str(resolved_path).lower().startswith(str(resolved_root).lower()):
                        relative_path = resolved_path.relative_to(resolved_root)
                        url_path = urllib.parse.quote(str(relative_path).replace('\\', '/'))
                        return f"{JUPYTER_BASE_URL}/{url_path}"
                except (ValueError, OSError):
                    # File is not inside 000_work, fall back to default logic or handle error
                    pass

        # Default/Existing logic (macOS/Linux or fallback)
        JUPYTER_BASE_URL = "http://localhost:8888/lab/tree"
        try:
            relative_path = path_obj.relative_to(settings.base_dir)
            url_path = urllib.parse.quote(str(relative_path).replace('\\', '/'))
            return f"{JUPYTER_BASE_URL}/{url_path}"
        except ValueError:
            pass 

    # --- Obsidian (.md) ---
    if start_path.endswith('.md') and 'obsidian' in start_path:
        parts = str(path_obj).replace('\\', '/').split('/')
        obsidian_idx = -1
        for i, part in enumerate(parts):
            if 'obsidian' in part.lower():
                obsidian_idx = i
                break
        
        if obsidian_idx != -1:
            vault_name = parts[obsidian_idx]
            relative_file_path = '/'.join(parts[obsidian_idx+1:])
            encoded_file = urllib.parse.quote(relative_file_path)
            encoded_vault = urllib.parse.quote(vault_name)
            return f"obsidian://open?vault={encoded_vault}&file={encoded_file}"

    # --- PDF ---
    # PDFはプラットフォームに関係なくブラウザで別タブ表示する
    if start_path.endswith('.pdf'):
        encoded_path = urllib.parse.quote(str(path_obj))
        return f"/api/view-pdf?path={encoded_path}"

    return None


def _prefers_html_response(request: Request) -> bool:
    """
    ブラウザの直接ナビゲーションかどうかをAcceptヘッダから判定する。

    fetch/jsonクライアントは従来どおりJSONを維持し、ブラウザ直開きのみ
    タブを閉じるHTMLやリダイレクトを返すために使用する。
    """
    accept = request.headers.get("accept", "")
    return "text/html" in accept or "application/xhtml+xml" in accept


def _close_tab_response(
    message: str = "Opened. Closing tab...",
    delay_ms: int = 1500,
) -> HTMLResponse:
    """
    外部アプリ起動後に一時タブを自動的に閉じるHTMLを返す。
    """
    escaped_message = html.escape(message)
    safe_delay_ms = max(0, delay_ms)
    return HTMLResponse(f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Closing...</title>
        <script>
            window.onload = function() {{
                setTimeout(function() {{
                    window.open('', '_self', '');
                    window.close();
                }}, {safe_delay_ms});
            }};
        </script>
    </head>
    <body style="background-color: #f0f0f0; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
        <div style="text-align: center; color: #666;">
            <p>{escaped_message}</p>
        </div>
    </body>
    </html>
    """)


def _build_frontend_editor_redirect_url(path: Path) -> str:
    """内蔵エディタで開くためのフロントエンドURLを組み立てる。"""
    encoded_parent = urllib.parse.quote(str(path.parent))
    encoded_file = urllib.parse.quote(str(path))
    return f"/?path={encoded_parent}&open_file={encoded_file}&open_mode=web"


def _build_frontend_directory_redirect_url(path: Path) -> str:
    """フォルダ表示用のフロントエンドURLを組み立てる。"""
    encoded_path = urllib.parse.quote(str(path))
    return f"/?path={encoded_path}"


def _should_use_web_editor_for_fullpath(
    path: Path,
    markdown_mode: Optional[str],
    text_mode: Optional[str],
) -> bool:
    """fullpath APIでWebエディタに誘導すべきか判定する。"""
    if _is_excalidraw_markdown(path):
        return False

    embedded_editor_language = _get_embedded_editor_language(path)
    if embedded_editor_language == "markdown":
        if markdown_mode == "web":
            return True
        if markdown_mode == "obsidian_or_web":
            target_url = resolve_file_app_url(path)
            return not (target_url and target_url.startswith("obsidian://"))
        return False
    if embedded_editor_language:
        return text_mode == "web"
    return False


def _should_use_external_markdown_app_for_fullpath(path: Path, markdown_mode: Optional[str]) -> bool:
    """fullpath APIでMarkdownを外部アプリ起動すべきか判定する。"""
    if _is_excalidraw_markdown(path):
        return False
    if _get_embedded_editor_language(path) != "markdown":
        return False
    if markdown_mode in {"external", "obsidian", "vscode"}:
        return True
    if markdown_mode == "obsidian_or_web":
        target_url = resolve_file_app_url(path)
        return bool(target_url and target_url.startswith("obsidian://"))
    return False


def _resolve_fullpath_preference(
    request: Request,
    query_param_name: str,
) -> Optional[str]:
    """fullpath用の設定値をquery→設定ファイルの順で解決する。"""
    query_value = request.query_params.get(query_param_name)
    if query_value:
        return query_value

    preferences = get_editor_preferences()
    if query_param_name == "markdown_mode":
        return preferences["markdownOpenMode"]
    if query_param_name == "text_mode":
        return preferences["textFileOpenMode"]

    return None


async def _open_markdown_external_app_for_fullpath(path: Path) -> None:
    """MarkdownをObsidian内外で適切な外部アプリへ振り分ける。"""
    target_url = resolve_file_app_url(path)
    if target_url and target_url.startswith("obsidian://"):
        await open_smart(OpenRequest(path=str(path)))
        return

    await open_in_vscode(OpenRequest(path=str(path)))


async def _handle_fullpath_html_preferences(request: Request, path: Path) -> Optional[Response]:
    """ブラウザ直開き時の設定連動をfullpath APIに適用する。"""
    markdown_mode = _resolve_fullpath_preference(
        request,
        "markdown_mode",
    )
    text_mode = _resolve_fullpath_preference(
        request,
        "text_mode",
    )

    if _should_use_web_editor_for_fullpath(path, markdown_mode, text_mode):
        return RedirectResponse(_build_frontend_editor_redirect_url(path))

    if _should_use_external_markdown_app_for_fullpath(path, markdown_mode):
        target_url = resolve_file_app_url(path)
        await _open_markdown_external_app_for_fullpath(path)
        if target_url and target_url.startswith("obsidian://"):
            return _close_tab_response("Opened in Obsidian. Closing tab...", delay_ms=100)
        return _close_tab_response()

    if _get_embedded_editor_language(path) and text_mode == "vscode":
        await open_in_vscode(OpenRequest(path=str(path)))
        return _close_tab_response()

    return None

@router.post("/open/smart", response_model=SmartOpenResponse)
async def open_smart(request: OpenRequest):
    """
    ファイル種類に応じてスマートに開く
    """
    converted_path = convert_storage_path(request.path)

    # 変換されたパスがURLの場合は直接ブラウザや外部アプリで開く (Pathの正規化エラー回避)
    if converted_path.startswith(("http://", "https://", "obsidian://")):
        try:
            if converted_path.startswith("http"):
                webbrowser.open(converted_path)
            else:
                # カスタムURI (obsidian 等)
                if platform.system() == 'Darwin':
                    if converted_path.startswith("obsidian://"):
                        subprocess.Popen(['open', '-a', 'Obsidian', converted_path])
                        _bring_obsidian_to_front()
                    else:
                        subprocess.Popen(['open', converted_path])
                elif platform.system() == 'Windows':
                    os.startfile(converted_path)
                    if converted_path.startswith("obsidian://"):
                        _bring_obsidian_to_front()
                else:
                    subprocess.Popen(['xdg-open', converted_path])
            
            return SmartOpenResponse(
                status="success",
                action="opened",
                message="リンクを開きました"
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"起動に失敗しました: {str(e)}")

    path = normalize_path(converted_path)

    def _open_smart_sync(t_path: Path, prefer_embedded: bool) -> SmartOpenResponse:
        if not t_path.exists():
            raise HTTPException(status_code=404, detail="ファイルが見つかりません")

        if t_path.is_dir():
            raise HTTPException(status_code=400, detail="ディレクトリは開けません")

        embedded_editor_language = _get_embedded_editor_language(t_path)

        if prefer_embedded and embedded_editor_language and not _is_excalidraw_markdown(t_path):
            try:
                with open(t_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                return SmartOpenResponse(
                    status="success",
                    action="open_modal",
                    message="エディタで開きます",
                    content=content,
                    editor_mode="markdown" if embedded_editor_language == "markdown" else "code",
                    language=embedded_editor_language,
                )
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"ファイル読み込み失敗: {str(e)}")

        # 共通ロジックでURL解決
        target_url = resolve_file_app_url(t_path)

        if target_url:
            try:
                if target_url.startswith("/"):
                    return SmartOpenResponse(
                        status="success",
                        action="open_url",
                        message="ブラウザで開きます",
                        url=target_url,
                    )

                # http/https は webbrowser で開く
                if target_url.startswith("http"):
                    webbrowser.open(target_url)
                else:
                    # obsidian:// 等のカスタムURI
                    if platform.system() == 'Darwin':
                        if target_url.startswith("obsidian://"):
                            subprocess.Popen(['open', '-a', 'Obsidian', target_url])
                            _bring_obsidian_to_front()
                        else:
                            subprocess.Popen(['open', target_url])
                    elif platform.system() == 'Windows':
                        os.startfile(target_url)
                        if target_url.startswith("obsidian://"):
                            _bring_obsidian_to_front()
                    else:
                        subprocess.Popen(['xdg-open', target_url])

                return SmartOpenResponse(
                    status="success",
                    action="opened",
                    message="専用アプリケーションで開きました"
                )
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"起動に失敗しました: {str(e)}")

        # --- 内蔵エディタ対象ファイル ---
        if embedded_editor_language:
            try:
                with open(t_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                return SmartOpenResponse(
                    status="success",
                    action="open_modal",
                    message="エディタで開きます",
                    content=content,
                    editor_mode="markdown" if embedded_editor_language == "markdown" else "code",
                    language=embedded_editor_language,
                )
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"ファイル読み込み失敗: {str(e)}")

        # --- その他 → OSデフォルトアプリ ---
        try:
            if platform.system() == "Windows":
                os.startfile(str(t_path))
            elif platform.system() == "Darwin":
                subprocess.Popen(["open", str(t_path)])
            else:
                subprocess.Popen(["xdg-open", str(t_path)])
            return SmartOpenResponse(
                status="success",
                action="opened",
                message="ファイルを開きました"
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"ファイルを開けませんでした: {str(e)}")

    return await run_with_timeout(_open_smart_sync, path, request.prefer_embedded)

@router.post("/open/antigravity")
async def open_in_antigravity(request: OpenRequest):
    """
    指定されたパスをAntigravityで開く
    """
    path = normalize_path(request.path)
    
    if platform.system() == 'Darwin':
        # 起動可能なアプリケーションパッケージ（.app）の候補パス
        candidates = [
            '/Applications/Antigravity IDE.app',
            '/Applications/Antigravity.app'
        ]
        antigravity_path = None
        for candidate in candidates:
            if os.path.exists(candidate):
                antigravity_path = candidate
                break
    else:
        raise HTTPException(status_code=501, detail="AntigravityはmacOSでのみサポートされています")

    # ファイル/フォルダが存在するか確認
    target_path = path if path.exists() else path.parent

    if not antigravity_path:
        raise HTTPException(status_code=404, detail="Antigravityが見つかりません")

    try:
        subprocess.Popen(['open', '-a', antigravity_path, str(target_path)])
        return {"status": "success", "message": "Antigravityで開きました"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Antigravityの起動に失敗しました: {str(e)}")

@router.post("/open/jupyter")
async def open_in_jupyter(request: OpenRequest):
    """
    指定されたパスをJupyterで開く
    """
    path = normalize_path(request.path)
    
    # JupyterのルートBase URL (環境に合わせて調整)
    # /lab/tree 形式でJupyterLabを開く
    JUPYTER_BASE_URL = "http://localhost:8888/lab/tree"
    
    # BASE_DIRからの相対パスを取得
    try:
        relative_path = path.relative_to(settings.base_dir)
    except ValueError:
        # BASE_DIR外の場合はエラーにするか、絶対パスで試みる（Jupyterの起動構成による）
        # ここではBASE_DIR以下のみサポート
        raise HTTPException(status_code=400, detail="Jupyterのルートディレクトリ外のファイルです")

    # URLエンコード
    # Note: jupyterはパス区切りをスラッシュにする必要がある
    url_path = urllib.parse.quote(str(relative_path).replace('\\', '/'))
    target_url = f"{JUPYTER_BASE_URL}/{url_path}"

    try:
        webbrowser.open(target_url)
        return {"status": "success", "message": f"Jupyterを開きました: {target_url}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Jupyterの起動に失敗しました: {str(e)}")

@router.post("/open/excalidraw")
async def open_in_excalidraw(request: OpenRequest):
    """
    指定されたパスをExcalidraw (Port 3001) で開く
    """
    path = normalize_path(request.path)
    
    EXCALIDRAW_BASE_URL = "http://localhost:3001"
    
    # Excalidrawアプリ（ローカルホスト3001）がどうパスを受け取るかによるが、
    # 一般的には ?file=... 形式か、あるいはAPI経由
    # file_viewer の実装（claude.md記述）によると "Port 3001のExcalidrawエディタで開く"機能がある
    # ここではシンプルにローカルパスを渡すクエリパラメータ形式と仮定
    # 実装例: http://localhost:3001/?file=/absolute/path/to/file.excalidraw
    
    encoded_path = urllib.parse.quote(str(path))
    target_url = f"{EXCALIDRAW_BASE_URL}/?filepath={encoded_path}"

    try:
        webbrowser.open(target_url)
        return {"status": "success", "message": f"Excalidrawを開きました"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Excalidrawの起動に失敗しました: {str(e)}")


@router.post("/open/obsidian")
async def open_in_obsidian(request: OpenRequest):
    """
    パスから Vault 名とファイルパスを特定し、Obsidian URI で開く
    パスに「obsidian」を含むディレクトリがある必要がある
    """
    file_path = request.path
    if not file_path:
        raise HTTPException(status_code=400, detail="パスが指定されていません")
    
    try:
        # パスを正規化
        normalized_path = str(normalize_path(file_path)).replace('\\', '/')
        
        # パスの中から「obsidian」を含むディレクトリを探す
        parts = normalized_path.split('/')
        obsidian_idx = -1
        for i, part in enumerate(parts):
            if 'obsidian' in part.lower():
                obsidian_idx = i
                break
        
        if obsidian_idx == -1:
            raise HTTPException(status_code=400, detail='パスに「obsidian」を含むディレクトリが見つかりません')
        
        vault_name = parts[obsidian_idx]
        # Vault以降のパスを特定
        relative_file_path = '/'.join(parts[obsidian_idx+1:])
        
        # フォルダの場合は末尾に / を付けるとObsidianでフォルダが開く
        target_path = Path(file_path)
        if target_path.is_dir() and relative_file_path and not relative_file_path.endswith('/'):
            relative_file_path += '/'
        
        # Obsidian URI を構築
        encoded_file = urllib.parse.quote(relative_file_path)
        encoded_vault = urllib.parse.quote(vault_name)
        obsidian_uri = f"obsidian://open?vault={encoded_vault}&file={encoded_file}"
        
        if platform.system() == 'Darwin':  # macOS
            subprocess.Popen(['open', '-a', 'Obsidian', obsidian_uri])
            _bring_obsidian_to_front()
        elif platform.system() == 'Windows':
            os.startfile(obsidian_uri)
            _bring_obsidian_to_front()
        else:
            raise HTTPException(status_code=501, detail="サポートされていないOSです")
        
        return {"status": "success", "message": "Obsidianで開きました", "uri": obsidian_uri}
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Obsidianの起動に失敗しました: {str(e)}")


@router.get("/file-content")
async def get_file_content(path: str = Query(..., description="ファイルのパス")):
    """
    ファイルの内容を取得（テキストファイル用）
    """
    target_path = normalize_path(path)

    def _get_file_content_sync(t_path: Path) -> dict:
        if not t_path.exists():
            raise HTTPException(status_code=404, detail="ファイルが見つかりません")

        if t_path.is_dir():
            raise HTTPException(status_code=400, detail="ディレクトリは読み込めません")

        try:
            with open(t_path, 'r', encoding='utf-8') as f:
                content = f.read()
            return {"path": str(t_path), "content": content}
        except UnicodeDecodeError:
            raise HTTPException(status_code=400, detail="テキストファイルではありません")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"ファイルの読み込みに失敗しました: {str(e)}")

    return await run_with_timeout(_get_file_content_sync, target_path)


# ----------------------------------------------------------------
# 外部連携用API（file_viewerと互換性あり）
# ブラウザやcmdから直接呼び出し可能
# ----------------------------------------------------------------

@router.get("/fullpath")
async def fullpath(
    request: Request,
    path: str = Query(..., description="開くファイルのフルパス"),
):
    """
    フルパスでファイルを開く（file_viewer互換）
    例: http://localhost:8001/api/fullpath?path=/path/to/file.pdf
    """
    if not path:
        raise HTTPException(status_code=400, detail="パスが指定されていません")
    
    # URLデコード
    decoded_path = urllib.parse.unquote(path)
    
    # ネットワークパス（UNC）の処理
    if decoded_path.startswith('//'):
        decoded_path = decoded_path.replace('/', '\\')  # //server/share → \\server\share

    normalized_path = normalize_path(decoded_path)

    if normalized_path.exists() and normalized_path.is_dir():
        return RedirectResponse(_build_frontend_directory_redirect_url(normalized_path))

    if _prefers_html_response(request):
        preferred_response = await _handle_fullpath_html_preferences(request, normalized_path)
        if preferred_response is not None:
            return preferred_response
    
    # スマートオープンを呼び出し
    open_request = OpenRequest(path=decoded_path)
    result = await open_smart(open_request)

    if not _prefers_html_response(request):
        return result

    if result.action == "open_url":
        if not result.url:
            raise HTTPException(status_code=500, detail="開くURLを解決できませんでした")
        return RedirectResponse(result.url)

    if result.action == "open_modal":
        fallback_result = await open_path(open_request)
        if not fallback_result.get("success", False):
            raise HTTPException(
                status_code=500,
                detail=fallback_result.get("error", "ファイルを開けませんでした"),
            )

    return _close_tab_response()


@router.post("/open-path")
async def open_path(request: OpenRequest):
    """
    パスを開く（file_viewer互換）
    ファイルの場合はファイルを、フォルダの場合はフォルダを開く
    """
    path = normalize_path(request.path)

    def _open_path_sync(t_path: Path) -> dict:
        if not t_path.exists():
            return {"success": False, "error": f"パスが見つかりません: {request.path}"}

        try:
            if platform.system() == "Windows":
                if t_path.is_dir():
                    subprocess.Popen(['explorer', str(t_path).replace('/', '\\')])
                else:
                    os.startfile(str(t_path))
            elif platform.system() == "Darwin":
                subprocess.Popen(["open", str(t_path)])
            else:
                subprocess.Popen(["xdg-open", str(t_path)])
            return {"success": True, "message": f"開きました: {t_path}"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    return await run_with_timeout(_open_path_sync, path)


@router.get("/open-path")
async def open_path_get(path: str = Query(..., description="開くファイルのパス")):
    """
    パスを開く（GET版）
    単純なリンクから呼び出せるように追加
    - フォルダの場合: 本アプリのフロントエンドにリダイレクトして開く
    - ファイルの場合: サーバー側で開き、開いたタブを自動的に閉じるHTMLを返す
    """
    path_obj = normalize_path(path)
    
    if path_obj.is_dir():
        # フォルダの場合はフロントエンドを開く
        # ポート番号（5173）を固定せず、相対パスでリダイレクトすることで現在のホスト・ポートを維持する
        encoded_path = urllib.parse.quote(str(path_obj))
        return RedirectResponse(f"/?path={encoded_path}")

    
    # 共通ロジックでURL解決
    target_url = resolve_file_app_url(path_obj)
    if target_url:
        return RedirectResponse(target_url)

    # ファイルの場合は既存処理（OSデフォルトアプリで開く）
    request = OpenRequest(path=path)
    await open_path(request)
    
    # ブラウザのタブを閉じるためのHTMLを返す
    return _close_tab_response()


@router.post("/open-folder")
async def open_folder(request: OpenRequest):
    """
    フォルダを開く（file_viewer互換）
    ファイルパスが渡された場合は親フォルダを開く
    """
    path = normalize_path(request.path)
    
    # ファイルの場合は親フォルダを開く
    if path.is_file():
        path = path.parent
    
    if not path.exists():
        return {"success": False, "error": f"フォルダが見つかりません: {request.path}"}
    
    try:
        if platform.system() == "Windows":
            process = subprocess.Popen(['explorer', str(path).replace('/', '\\')])
            _bring_explorer_to_front(process.pid, path)
        elif platform.system() == "Darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
        return {"success": True, "message": f"フォルダを開きました: {path}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.post("/open/trash")
async def open_trash():
    """
    ゴミ箱を開く
    """
    try:
        if platform.system() == "Windows":
            # Windows: shell:RecycleBinFolder
            subprocess.Popen(['explorer', 'shell:RecycleBinFolder'])
        elif platform.system() == "Darwin":
            # macOS: ~/.Trash
            trash_path = os.path.expanduser("~/.Trash")
            subprocess.Popen(["open", trash_path])
        else:
            # Linux: xdg-open trash:///
            subprocess.Popen(["xdg-open", "trash:///"])
        return {"success": True, "message": "ゴミ箱を開きました"}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.get("/test-folder-path")
async def get_test_folder_path():
    """
    テストフォルダのパスを取得
    Windows: %userprofile%\\000_work\\test
    Mac: /Users/mine/000_work/test
    """
    try:
        path_str = ""
        if platform.system() == "Windows":
            path_str = os.path.expandvars(r"%userprofile%\000_work\test")
        else:
            # Mac / Linux
            # ユーザー名直書き指定
            path_str = "/Users/mine/000_work/test"
        
        return {"success": True, "path": path_str}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ========================================
# タスク管理API
# ========================================

@router.get("/tasks/{task_id}/progress")
async def get_task_progress(task_id: str):
    """
    タスクの進捗を取得する
    
    Returns:
        {
            id: タスクID
            status: "pending" | "running" | "completed" | "cancelled" | "error"
            progress: 0-100
            current_file: 現在処理中のファイル名
            total_files: 総ファイル数
            processed_files: 処理済みファイル数
            error_message: エラーメッセージ（エラー時のみ）
            result: 完了時の結果
        }
    """
    task = task_manager.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="タスクが見つかりません")
    
    response = task.to_dict()
    
    # 完了済みの場合は結果も返す
    if task.status == "completed" and task.result:
        response["result"] = task.result
    
    return response


@router.post("/tasks/{task_id}/cancel")
async def cancel_task(task_id: str):
    """
    タスクをキャンセルする
    
    実際のキャンセルは非同期で行われる。
    ワーカースレッドがフラグを検知して処理を中断する。
    """
    task = task_manager.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="タスクが見つかりません")
    
    if task.status in ("completed", "cancelled", "error"):
        return {"success": False, "message": "タスクは既に終了しています", "status": task.status}
    
    success = task_manager.cancel_task(task_id)
    if success:
        return {"success": True, "message": "キャンセルをリクエストしました"}
    else:
        return {"success": False, "message": "キャンセルに失敗しました"}
