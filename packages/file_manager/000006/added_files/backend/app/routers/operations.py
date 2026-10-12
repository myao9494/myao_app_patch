"""
削除・移動・コピーとタスク進捗 APIルーター（処理本体は app/services/）
- DELETE /api/delete, POST /api/delete/batch: ゴミ箱へ移動（完全削除へフォールバックしない）
- POST /api/move: 1件移動（Undo/Redo用、同名の項目があれば 409）
- POST /api/move/batch, /api/copy/batch: 一括移動/コピー（同名衝突時は overwrite=True のときだけ置き換え）
- GET  /api/tasks/{id}/progress, POST /api/tasks/{id}/cancel: 非同期タスクの進捗取得とキャンセル
"""
import os
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.services.deletion import delete_items, delete_one, start_delete_task
from app.services.paths import (
    normalize_path,
    run_in_io_thread,
)
from app.services.transfer import (
    CONFLICT_MESSAGE,
    TransferError,
    TransferMode,
    start_transfer_task,
    transfer_items,
    transfer_one,
)
from app.task_manager import task_manager

router = APIRouter()


class DeleteRequest(BaseModel):
    """削除リクエストのスキーマ"""

    path: str
    async_mode: bool = False  # 非同期モード（進捗モーダル用）
    debug_mode: bool = False  # デバッグモード
    force_kill_pids: Optional[List[int]] = None  # 利用者が終了に同意したプロセスのPIDリスト


@router.delete("/delete")
async def delete_item(request: DeleteRequest):
    """
    ファイル/フォルダをゴミ箱に移動する（本当のネットワークドライブ上のみ完全削除）。
    ゴミ箱への移動に失敗しても完全削除へフォールバックしない。
    ロックが原因の場合は 409 と locked_by（プロセス一覧）を返す。
    """
    target_path = normalize_path(request.path)

    if not await run_in_io_thread(os.path.lexists, target_path):
        raise HTTPException(status_code=404, detail="パスが見つかりません")

    if request.async_mode:
        task_id = start_delete_task([request.path], request.debug_mode)
        return {"status": "async", "task_id": task_id, "message": "削除処理を開始しました"}

    outcome = await run_in_io_thread(
        delete_one, target_path, request.force_kill_pids, None, request.debug_mode
    )
    if outcome["status"] == "success":
        return {"status": "success", "message": outcome["message"]}
    if outcome.get("locked_by"):
        return JSONResponse(
            status_code=409,
            content={"detail": f"削除に失敗しました: {outcome['message']}", "locked_by": outcome["locked_by"]},
        )
    raise HTTPException(status_code=500, detail=f"削除に失敗しました: {outcome['message']}")


class BatchDeleteRequest(BaseModel):
    """一括削除リクエストのスキーマ"""
    paths: List[str]
    async_mode: bool = False
    debug_mode: bool = False
    force_kill_pids: Optional[List[int]] = None  # 利用者が終了に同意したプロセスのPIDリスト


@router.post("/delete/batch")
async def delete_items_batch(request: BatchDeleteRequest):
    """
    複数のファイル/フォルダをゴミ箱に移動する（項目ごとの結果を返す）。
    async_mode が True の場合、バックグラウンドで処理しタスクIDを返す。
    """
    if request.async_mode:
        task_id = start_delete_task(request.paths, request.debug_mode)
        return {"status": "async", "task_id": task_id, "message": "削除処理を開始しました"}

    return await run_in_io_thread(
        delete_items, request.paths, request.force_kill_pids, None, request.debug_mode
    )


# ----------------------------------------------------------------
# 移動・コピー（実装は app/services/transfer.py）
# ----------------------------------------------------------------
class MoveRequest(BaseModel):
    """単一移動リクエストのスキーマ（Undo/Redoで使用）"""

    src_path: str
    dest_path: str  # 既存フォルダならその中へ、存在しないパスならその名前で移動


class BatchTransferRequest(BaseModel):
    """一括移動/コピーリクエストのスキーマ"""
    src_paths: List[str]
    dest_path: str
    overwrite: bool = False  # 同名項目の上書き（利用者が確認した場合のみ True）
    verify_checksum: bool = False  # SHA256によるコピー検証
    async_mode: bool = False  # 非同期モード（進捗モーダル用）
    debug_mode: bool = False  # デバッグモード（ログ出力用）


BatchMoveRequest = BatchTransferRequest


BatchCopyRequest = BatchTransferRequest


def _transfer_error_status(message: str) -> int:
    if CONFLICT_MESSAGE in message:
        return 409
    if "見つかりません" in message:
        return 404
    if "サブディレクトリ" in message or "同一ファイル" in message:
        return 400
    return 500


@router.post("/move")
async def move_item(request: MoveRequest):
    """
    ファイル/フォルダを1件移動する（Undo/Redo用）。
    同名の項目がある場合は上書きせず 409 を返す。
    """
    src_path = normalize_path(request.src_path)
    dest_path = normalize_path(request.dest_path)

    def _move() -> dict:
        final_dest = dest_path / src_path.name if dest_path.is_dir() else dest_path
        try:
            status, message = transfer_one(src_path, final_dest, "move")
        except TransferError as e:
            raise HTTPException(status_code=_transfer_error_status(str(e)), detail=f"移動に失敗しました: {e}")
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"移動に失敗しました: {e}")
        if status == "skipped":
            return {"status": "success", "message": message}
        return {"status": "success", "message": f"移動しました: {src_path} → {final_dest}"}

    return await run_in_io_thread(_move)


async def _start_batch_transfer(request: BatchTransferRequest, mode: TransferMode):
    dest_path = normalize_path(request.dest_path)
    label = "移動" if mode == "move" else "コピー"

    def _check_dest() -> None:
        if not dest_path.exists():
            raise HTTPException(status_code=404, detail=f"{label}先フォルダが見つかりません")
        if not dest_path.is_dir():
            raise HTTPException(status_code=400, detail=f"{label}先はディレクトリである必要があります")

    await run_in_io_thread(_check_dest)
    if request.debug_mode:
        print(f"[BATCH_{mode.upper()}] Dest={dest_path}, Sources={request.src_paths}, Async={request.async_mode}")

    if request.async_mode:
        task_id = start_transfer_task(
            request.src_paths, dest_path, mode, request.overwrite, request.verify_checksum, request.debug_mode
        )
        return {"status": "async", "task_id": task_id, "message": f"{label}処理を開始しました"}

    return await run_in_io_thread(
        transfer_items, request.src_paths, dest_path, mode,
        request.overwrite, request.verify_checksum, None, request.debug_mode,
    )


@router.post("/move/batch")
async def move_items_batch(request: BatchMoveRequest):
    """
    複数のファイル/フォルダを移動する（同一ボリュームはリネーム、それ以外はコピー→検証→削除）。
    同名の項目は overwrite=True のときだけ置き換える（置き換えた既存項目はゴミ箱へ）。
    """
    return await _start_batch_transfer(request, "move")


@router.post("/copy/batch")
async def copy_items_batch(request: BatchCopyRequest):
    """複数のファイル/フォルダをコピーする（同名の項目は overwrite=True のときだけ置き換える）"""
    return await _start_batch_transfer(request, "copy")


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
