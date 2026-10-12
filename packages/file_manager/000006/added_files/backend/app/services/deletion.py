"""
削除処理（同期・非同期共通の実装）

安全のための原則（ファイルが勝手に消えないこと）:
- ローカルの項目は「ゴミ箱へ移動」のみ。フォルダは中身ごと1回で移動するため、
  ゴミ箱から階層を保ったまま元に戻せる。
- ゴミ箱への移動に失敗した場合はエラーを返すだけで、完全削除へは絶対にフォールバックしない。
  Windowsでロックされている場合はロック中のプロセス一覧（locked_by）を返す。
- 完全削除するのは、ゴミ箱が使えない本当のネットワークドライブ上で
  利用者が削除を指示した項目だけ（is_network_path で判定）。
- force_kill_pids は利用者がダイアログで同意したプロセスのみ終了してから削除する。

結果は項目単位で返す:
    {"status": "completed", "success_count", "fail_count",
     "results": [{"path", "status": "success"|"error", "message", "locked_by"?}]}
"""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Optional

from app.config import settings
from app.services import trash
from app.services.paths import normalize_path
from app.task_manager import task_manager

TRASHED_MESSAGE = "ゴミ箱に移動しました"
NETWORK_DELETED_MESSAGE = "削除しました（ネットワークドライブのためゴミ箱には入りません）"


def delete_one(
    path: Path,
    force_kill_pids: Optional[list[int]] = None,
    task_id: Optional[str] = None,
    debug_mode: bool = False,
) -> dict:
    """1項目を削除し、{"status", "message", "locked_by"?} を返す（例外は送出しない）。"""
    def log(msg: str) -> None:
        if debug_mode:
            print(f"[DELETE] {msg}")

    if not os.path.lexists(path):
        return {"status": "error", "message": "ファイルが見つかりません"}

    try:
        if trash.is_network_path(path):
            log(f"ネットワークドライブ上の項目を削除: {path}")
            trash.delete_permanently(
                path,
                on_progress=(lambda name: task_manager.set_current_file(task_id, name)) if task_id else None,
                is_cancelled=(lambda: task_manager.is_cancelled(task_id)) if task_id else None,
            )
            return {"status": "success", "message": NETWORK_DELETED_MESSAGE}

        if force_kill_pids:
            log(f"同意済みプロセスを終了: {force_kill_pids}")
            trash.kill_processes(force_kill_pids)
            time.sleep(0.5)  # プロセス終了を少し待つ

        log(f"ゴミ箱へ移動: {path}")
        trash.trash_with_retry(path)
        return {"status": "success", "message": TRASHED_MESSAGE}
    except InterruptedError as e:
        return {"status": "error", "message": str(e)}
    except Exception as e:
        log(f"削除エラー: {e}")
        result: dict = {"status": "error", "message": str(e) or e.__class__.__name__}
        if settings.is_windows and isinstance(e, OSError):
            locked_by = trash.get_locking_processes(str(path))
            if locked_by:
                result["locked_by"] = locked_by
        return result


def delete_items(
    paths: list[str],
    force_kill_pids: Optional[list[int]] = None,
    task_id: Optional[str] = None,
    debug_mode: bool = False,
) -> dict:
    """複数項目を順に削除し、項目ごとの結果を返す。"""
    results: list[dict] = []
    if task_id:
        task_manager.set_total(task_id, len(paths))

    for index, path_str in enumerate(paths):
        if task_id and task_manager.is_cancelled(task_id):
            results.append({"path": path_str, "status": "error", "message": "キャンセルされました"})
            continue
        try:
            target = normalize_path(path_str)
        except Exception as e:
            results.append({"path": path_str, "status": "error", "message": f"パスの正規化に失敗: {e}"})
            continue
        if task_id:
            task_manager.update_progress(task_id, processed_files=index, current_file=target.name)
        outcome = delete_one(target, force_kill_pids, task_id, debug_mode)
        results.append({"path": path_str, **outcome})

    if task_id:
        task_manager.set_total(task_id, len(paths))
        task_manager.update_progress(task_id, processed_files=len(paths), current_file="")

    return {
        "status": "completed",
        "success_count": sum(1 for r in results if r["status"] == "success"),
        "fail_count": sum(1 for r in results if r["status"] == "error"),
        "results": results,
    }


def run_delete_task(task_id: str, paths: list[str], debug_mode: bool) -> None:
    """バックグラウンドスレッドで delete_items を実行し、結果をタスクへ保存する。"""
    task_manager.set_running(task_id)
    try:
        task_manager.complete_task(task_id, result=delete_items(paths, None, task_id, debug_mode))
    except Exception as e:  # 想定外の例外でもタスクを「実行中」のまま放置しない
        task_manager.fail_task(task_id, str(e))


def start_delete_task(paths: list[str], debug_mode: bool) -> str:
    """非同期の削除を開始してタスクIDを返す。"""
    task = task_manager.create_task(total_files=len(paths))
    threading.Thread(
        target=run_delete_task,
        args=(task.id, paths, debug_mode),
        daemon=True,
        name=f"delete-{task.id[:8]}",
    ).start()
    return task.id
