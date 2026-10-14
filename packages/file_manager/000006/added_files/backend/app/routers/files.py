"""
ファイル一覧・検索・作成/編集系 APIルーター
- GET  /api/files: フォルダ内の一覧（ファイルを指定した場合は親フォルダ）
- GET  /api/path-info: パス種別（file / directory / not_found）
- GET  /api/search: ファイル名のライブ検索（os.scandir による再帰走査、階層・除外パターン指定）
- POST /api/folder-latest-modified: フォルダ配下の最新更新日時（走査上限・時間上限あり）
- POST /api/git-folder-statuses: 複数フォルダの Git 未コミット変更・ahead/behind を並列取得
- POST /api/count-files: ファイル数カウント（指定階層まで）
- GET  /api/obsidian/daily-path: Obsidian の今日のフォルダ（YYYY/MM/DD）を作成して返す
- POST /api/unzip: ZIP を同じ場所の新しいフォルダへ解凍（Zip Slip 対策あり）
- POST /api/create-folder, /api/create-file: 新規作成（既存の項目は上書きしない）
- POST /api/update-file: ファイル内容の更新（アトミック書き込み）
- POST /api/upload: Explorer/Finder からのアップロード（同名ファイルは別名で保存）
- POST /api/rename: リネーム（既存の項目は上書きしない）
- GET  /api/file-content: テキストファイル内容の取得
- GET  /api/test-folder-path: テスト用フォルダのパス

インデックス検索は外部サービス（file_index_service）を使用する。
"""
import fnmatch
import os
import platform
import shutil
import subprocess
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel

from app.config import get_editor_preferences, settings
from app.schemas import FileItem
from app.services.fileio import InvalidNameError, atomic_write_text, unique_child_path, validate_entry_name
from app.services.paths import (
    is_within,
    normalize_path,
    run_in_io_thread,
    run_with_timeout,
)

router = APIRouter()


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
    return is_within(resolved, search_root)


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
    q: Optional[str] = Query(None, description="検索クエリ（エイリアス）"),
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
    target_query = (query or q or "").strip()
    ignore_patterns = [p.strip() for p in ignore.split(",") if p.strip()]
    default_ignores = [".git", ".svn", "__pycache__", ".DS_Store"]
    ignore_patterns.extend(default_ignores)

    if not target_query:
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
            target_query,
            1,
            depth,
            ignore_patterns,
            results,
            max_results,
            file_type,
        )

        return SearchResponse(
            query=target_query,
            path=t_path.as_posix(),
            depth=depth,
            total=len(results),
            items=results,
        )

    return await run_with_timeout(_search_sync, target_path)


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
def get_obsidian_daily_path():
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


def _child_path(parent: Path, name: str) -> Path:
    """親フォルダ直下の新しい項目パスを返す（名前に区切り文字等があれば 400）"""
    try:
        validate_entry_name(name)
    except InvalidNameError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return parent / name


def _require_directory(path: Path, missing_detail: str = "親ディレクトリが見つかりません") -> None:
    if not path.exists():
        raise HTTPException(status_code=404, detail=missing_detail)
    if not path.is_dir():
        raise HTTPException(status_code=400, detail="指定されたパスはディレクトリではありません")


class CreateFolderRequest(BaseModel):
    """フォルダ作成リクエストのスキーマ"""

    path: str
    name: str


@router.post("/create-folder")
async def create_folder(request: CreateFolderRequest):
    """フォルダを作成する（同名の項目があれば 400）"""
    parent_path = normalize_path(request.path)

    def _create() -> dict:
        _require_directory(parent_path)
        new_folder = _child_path(parent_path, request.name)
        try:
            new_folder.mkdir()
        except FileExistsError:
            raise HTTPException(status_code=400, detail="同名のファイル/フォルダが既に存在します")
        except PermissionError:
            raise HTTPException(status_code=403, detail="作成権限がありません")
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"フォルダ作成に失敗しました: {str(e)}")
        return {"status": "success", "message": f"フォルダを作成しました: {new_folder}"}

    return await run_in_io_thread(_create)


class CreateFileRequest(BaseModel):
    """ファイル作成リクエストのスキーマ"""

    path: str
    name: str
    content: Optional[str] = ""


@router.post("/create-file")
async def create_file(request: CreateFileRequest):
    """ファイルを作成する（既存ファイルは上書きせず 400）"""
    parent_path = normalize_path(request.path)

    def _create() -> dict:
        _require_directory(parent_path)
        new_file = _child_path(parent_path, request.name)
        try:
            # "x" モード: 既に存在する場合は FileExistsError（上書きしない）
            with open(new_file, "x", encoding="utf-8") as f:
                if request.content:
                    f.write(request.content)
        except FileExistsError:
            raise HTTPException(status_code=400, detail="同名のファイル/フォルダが既に存在します")
        except PermissionError:
            raise HTTPException(status_code=403, detail="作成権限がありません")
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"ファイル作成に失敗しました: {str(e)}")
        return {"status": "success", "message": f"ファイルを作成しました: {new_file}", "path": str(new_file)}

    return await run_in_io_thread(_create)


class UpdateFileRequest(BaseModel):
    """ファイル更新リクエストのスキーマ"""

    path: str
    content: str


@router.post("/update-file")
async def update_file(request: UpdateFileRequest):
    """
    ファイルの内容を更新する。
    一時ファイルへ書いてから置き換えるため、途中で失敗しても元の内容は失われない。
    """
    target_path = normalize_path(request.path)

    def _update() -> dict:
        if not target_path.exists():
            raise HTTPException(status_code=404, detail="ファイルが見つかりません")
        if target_path.is_dir():
            raise HTTPException(status_code=400, detail="指定されたパスはディレクトリです")
        try:
            atomic_write_text(target_path, request.content)
        except PermissionError:
            raise HTTPException(status_code=403, detail="更新権限がありません")
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"ファイル更新に失敗しました: {str(e)}")
        return {"status": "success", "message": f"ファイルを更新しました: {target_path}"}

    return await run_in_io_thread(_update)


def _is_safe_relative_path(rel_path: str) -> bool:
    """アップロードの相対パスが安全か（`..`・絶対パス・ドライブ指定を拒否）"""
    if not rel_path or not rel_path.strip():
        return False
    normalized = rel_path.replace("\\", "/").strip("/")
    if any(part in ("..", ".", "") for part in normalized.split("/")):
        return False
    return ":" not in normalized and not rel_path.startswith(("/", "\\"))


def _save_upload_without_overwrite(source, dest_file: Path) -> Path:
    """既存ファイルを上書きせずに保存し、実際の保存先を返す（同名なら「name (1).ext」）"""
    candidate = dest_file
    while True:
        try:
            with open(candidate, "xb") as buffer:
                shutil.copyfileobj(source, buffer)
            return candidate
        except FileExistsError:
            candidate = unique_child_path(dest_file.parent, dest_file.name)


@router.post("/upload")
async def upload_files(
    request: Request,
    path: str = Query(..., description="アップロード先ディレクトリ"),
    files: Optional[List[UploadFile]] = File(None, description="アップロードするファイルリスト"),
    relative_paths: Optional[List[str]] = Form(None, description="各ファイルの相対パスリスト"),
    empty_directories: Optional[List[str]] = Form(None, description="空ディレクトリリスト"),
):
    """
    ファイルおよびディレクトリをアップロードする
    - Windows Explorer / macOS Finder からのファイル・フォルダのドラッグ&ドロップに対応
    - 既存ファイルは上書きせず「name (1).ext」の別名で保存する（renamed に記録）
    - `..` を含むパスやアップロード先の外へ出るパスは拒否する
    """
    target_dir = normalize_path(path)

    # Formデータから確実に取得（マルチパート解析のフォールバック）
    try:
        form_data = await request.form()
        if not files:
            files = [f for f in form_data.getlist("files") if isinstance(f, UploadFile)] or None
        if not relative_paths:
            relative_paths = [str(r) for r in form_data.getlist("relative_paths")] or None
        if not empty_directories:
            empty_directories = [str(e) for e in form_data.getlist("empty_directories")] or None
    except Exception:
        pass

    def _upload() -> dict:
        base_dir = target_dir
        if not base_dir.exists():
            raise HTTPException(status_code=404, detail="アップロード先が見つかりません")
        if not base_dir.is_dir():
            # ファイルを指定した場合はその親ディレクトリにアップロード
            base_dir = base_dir.parent
        base_resolved = base_dir.resolve()

        uploaded: list[str] = []
        created_directories: list[str] = []
        renamed: list[dict[str, str]] = []
        errors: list[str] = []

        for empty_dir in empty_directories or []:
            if not _is_safe_relative_path(empty_dir):
                errors.append(f"不正なディレクトリパス: {empty_dir}")
                continue
            try:
                dest_dir = (base_dir / Path(empty_dir.replace("\\", "/"))).resolve()
                if not is_within(dest_dir, base_resolved):
                    errors.append(f"ディレクトリが範囲外です: {empty_dir}")
                    continue
                dest_dir.mkdir(parents=True, exist_ok=True)
                created_directories.append(empty_dir)
            except Exception as e:
                errors.append(f"{empty_dir}: {str(e)}")

        for idx, upload in enumerate(files or []):
            try:
                rel_path = None
                if relative_paths and idx < len(relative_paths) and relative_paths[idx]:
                    rel_path = relative_paths[idx]
                elif upload.filename:
                    rel_path = upload.filename
                if not rel_path:
                    continue
                if not _is_safe_relative_path(rel_path):
                    errors.append(f"不正なファイルパス: {rel_path}")
                    continue

                normalized_rel = rel_path.replace("\\", "/").strip("/")
                dest_file = base_dir / Path(normalized_rel)
                dest_parent = dest_file.parent.resolve()
                if not is_within(dest_parent, base_resolved):
                    errors.append(f"ファイルが範囲外です: {rel_path}")
                    continue
                dest_parent.mkdir(parents=True, exist_ok=True)

                saved = _save_upload_without_overwrite(upload.file, dest_parent / dest_file.name)
                saved_rel = saved.relative_to(dest_parent).as_posix()
                saved_rel = "/".join([*normalized_rel.split("/")[:-1], saved_rel])
                uploaded.append(saved_rel)
                if saved_rel != normalized_rel:
                    renamed.append({"from": normalized_rel, "to": saved_rel})
            except Exception as e:
                errors.append(f"{upload.filename}: {str(e)}")
            finally:
                upload.file.close()

        total_success = len(uploaded) + len(created_directories)
        message = f"{total_success}件処理しました"
        if renamed:
            message += f"（同名ファイル{len(renamed)}件は別名で保存しました）"
        response: dict = {
            "status": "success",
            "message": message,
            "uploaded": uploaded,
            "created_directories": created_directories,
            "renamed": renamed,
        }
        if errors:
            response.update(
                status="partial_success" if total_success > 0 else "error",
                message=f"{message}。エラー: {len(errors)}件",
                errors=errors,
            )
        return response

    return await run_in_io_thread(_upload)


class RenameRequest(BaseModel):
    """リネームリクエストのスキーマ"""

    old_path: str
    new_name: str


@router.post("/rename")
async def rename_item(request: RenameRequest):
    """
    ファイル/フォルダをリネームする
    - 同じフォルダ内での名前変更のみ（区切り文字を含む名前は 400）
    - 既存の項目は上書きしない（大文字小文字だけの変更は許可）
    """
    old_path = normalize_path(request.old_path)

    def _rename() -> dict:
        if not os.path.lexists(old_path):
            raise HTTPException(status_code=404, detail="対象が見つかりません")
        new_path = _child_path(old_path.parent, request.new_name)
        if os.path.lexists(new_path):
            try:
                case_only_change = os.path.samefile(old_path, new_path) and old_path.name != new_path.name
            except OSError:
                case_only_change = False
            if not case_only_change:
                raise HTTPException(status_code=400, detail="同名のファイル/フォルダが既に存在します")
        try:
            old_path.rename(new_path)
        except PermissionError:
            raise HTTPException(status_code=403, detail="リネーム権限がありません")
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"リネームに失敗しました: {str(e)}")
        return {"status": "success", "message": f"リネームしました: {old_path} → {new_path}"}

    return await run_in_io_thread(_rename)


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


@router.get("/test-folder-path")
def get_test_folder_path():
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
