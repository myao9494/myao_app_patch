"""
パス処理とI/Oスレッド実行の共通モジュール

- convert_storage_path: リンク置換設定（pathMappings）に従い旧サーバーのパス/URLを新サーバーへ変換
- normalize_path: API入力パスを正規化する
    - 絶対パス（Windows UNC `\\\\server\\share` を含む）はそのまま使用する
    - 相対パスはベースディレクトリ基準で解決し、`..` でベース外へ出るものは 403 で拒否する
    - ネットワークI/Oを避けるため、ファイルシステムには触れず文字列だけで正規化する
- run_with_timeout: 同期処理を専用スレッドプールで実行し、設定値（apiTimeout）秒で 504 を返す
- run_in_io_thread: 同期処理を専用スレッドプールで実行する（タイムアウトなし。書き込み系で使用）
- is_within: パスが指定ディレクトリ配下かどうかを文字列前方一致ではなく要素単位で判定する
"""
from __future__ import annotations

import asyncio
import functools
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, TypeVar

from fastapi import HTTPException

from app import config
from app.config import settings

T = TypeVar("T")

# ターミナルの長時間待機処理と分離し、PTY接続が増えてもファイルAPIを応答可能に保つ。
FILE_IO_EXECUTOR = ThreadPoolExecutor(
    max_workers=max(4, min(settings.file_io_workers, 64)),
    thread_name_prefix="file-manager-io",
)


def get_api_timeout_seconds() -> float:
    """設定ファイルの apiTimeout を秒数（float）で返す。不正値は10秒。"""
    try:
        timeout_sec = float(config.get_editor_preferences().get("apiTimeout", 10))
    except (ValueError, TypeError):
        return 10.0
    return timeout_sec if timeout_sec > 0 else 10.0


async def run_with_timeout(func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """
    同期関数をスレッドプールで実行し、設定されたタイムアウト秒数で制限する。
    タイムアウト時は 504 Gateway Timeout を返す。
    （読み取り系API向け。書き込み系は途中で応答だけ切れると状態が分かりにくいため run_in_io_thread を使う）
    """
    timeout_sec = get_api_timeout_seconds()
    loop = asyncio.get_running_loop()
    try:
        return await asyncio.wait_for(
            loop.run_in_executor(FILE_IO_EXECUTOR, functools.partial(func, *args, **kwargs)),
            timeout=timeout_sec,
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail=f"処理がタイムアウトしました（設定値: {timeout_sec}秒）。ネットワークが遅い可能性があります。",
        )


async def run_in_io_thread(func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """同期関数をスレッドプールで実行する（イベントループをブロックしない）。"""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(FILE_IO_EXECUTOR, functools.partial(func, *args, **kwargs))


def is_within(path: Path | str, root: Path | str) -> bool:
    """
    path が root 自身またはその配下かを判定する。
    `/a/foo` と `/a/foobar` のような前方一致の誤判定を避けるため commonpath で比較する。
    """
    path_str = os.path.normcase(os.path.abspath(str(path)))
    root_str = os.path.normcase(os.path.abspath(str(root)))
    try:
        return os.path.commonpath([path_str, root_str]) == root_str
    except ValueError:
        # Windowsで異なるドライブ同士を比較した場合
        return False


def _expand_path_mappings(raw_mappings: dict[str, str]) -> dict[str, str]:
    """{新: "旧1,旧2"} 形式の設定を {旧: 新} に展開する。"""
    path_mappings: dict[str, str] = {}
    for new_path, old_paths_str in raw_mappings.items():
        if not new_path or not old_paths_str:
            continue
        for old_path in (p.strip() for p in str(old_paths_str).split(",")):
            if old_path:
                path_mappings[old_path] = new_path
    return path_mappings


def convert_storage_path(path: str) -> str:
    """
    ストレージパスやURLの変更に対応するための変換関数。
    normalize_path の冒頭で呼び出され、アプリ全体に適用される。

    引数:
        path: 入力パスまたはURL
    戻り値:
        変換後のパスまたはURL（該当する設定がなければそのまま）
    """
    if not path:
        return path

    raw_mappings = config.get_editor_preferences().get("pathMappings", {})
    if not raw_mappings or not isinstance(raw_mappings, dict):
        return path

    path_mappings = _expand_path_mappings(raw_mappings)
    is_url = path.startswith(("http://", "https://", "obsidian://"))

    for old_path, new_path in path_mappings.items():
        if is_url:
            # URLの場合は大文字小文字を無視して前方一致比較
            if path.lower().startswith(old_path.lower()):
                return new_path + path[len(old_path):]
            continue

        # ファイルパス・UNCパスの場合: Windowsの「¥」を「\」に統一し、比較はスラッシュで行う
        normalized_path = path.replace("¥", "\\")
        normalized_old = old_path.replace("¥", "\\")
        normalized_new = new_path.replace("¥", "\\")
        comp_path = normalized_path.replace("\\", "/")
        comp_old = normalized_old.replace("\\", "/")

        if not comp_path.lower().startswith(comp_old.lower()):
            continue

        remainder = comp_path[len(comp_old):]
        # 区切り文字スタイルは元の入力に合わせる（\ が含まれていれば \）
        sep = "\\" if "\\" in normalized_path else "/"
        combined = normalized_new.replace("\\", "/").rstrip("/") + "/" + remainder.lstrip("/")
        result = combined.replace("/", sep)

        # UNCパスの先頭プレフィックスが壊れないように調整
        if normalized_path.startswith("\\\\") and not result.startswith("\\\\"):
            result = "\\" + result.lstrip("\\")
        elif normalized_path.startswith("//") and not result.startswith("//"):
            result = "/" + result.lstrip("/")
        return result

    return path


def normalize_path(path: str) -> Path:
    """
    パスを正規化する。
    - 絶対パス: そのまま使用（Windows UNCパス `\\\\server\\share\\folder` を含む）
    - 相対パス: ベースディレクトリからの相対パスとして扱い、ベース外へ出るものは拒否する
    """
    path = convert_storage_path(path)

    if not path:
        return settings.base_dir

    if settings.is_windows:
        # /C:/... のようなパスの先頭のスラッシュを削除
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
        base_path = os.path.abspath(os.path.normpath(str(settings.base_dir)))
        candidate_path = os.path.abspath(os.path.join(base_path, str(normalized)))
        if not is_within(candidate_path, base_path):
            raise HTTPException(status_code=403, detail="アクセスが拒否されました")
        return Path(candidate_path)
    except (ValueError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=f"無効なパスです: {str(e)}")
