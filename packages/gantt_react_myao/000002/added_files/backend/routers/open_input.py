"""
タスク入力画面（Lightbox）を外部から開かせるAPIルーター。

ランチャー等が POST /api/tasks/{id}/open-input を呼ぶと「開いてほしい」リクエストを1件だけ保持し、
フロントエンドが1秒間隔のポーリングで拾って Lightbox を開き、ack で消す。
状態はインメモリで、保持するのは最新の1件のみ。

/api/tasks/{task_id} より先にマッチさせる必要があるため、main.py では tasks ルーターより前に登録する。
"""
import time
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from config import gantt_frontend_url
from database import get_db
from models import Task as TaskModel
from schemas import TaskOpenInputRequest, TaskOpenInputResponse
from services import browser_window
from services.task_text import now_string

router = APIRouter(prefix="/api/tasks", tags=["open-input"])

# この秒数以内にハートビートがあれば「フロントエンドのタブが開いている」とみなす
FRONTEND_HEARTBEAT_TTL_SECONDS = 10

_latest_request: TaskOpenInputRequest | None = None
_request_sequence = 0
_last_frontend_heartbeat_at: datetime | None = None


def reset_state() -> None:
    """保持中のリクエストとハートビートを初期化する（テスト用）。"""
    global _latest_request, _request_sequence, _last_frontend_heartbeat_at
    _latest_request = None
    _request_sequence = 0
    _last_frontend_heartbeat_at = None


def has_recent_frontend_heartbeat() -> bool:
    return (
        _last_frontend_heartbeat_at is not None
        and datetime.now() - _last_frontend_heartbeat_at
        <= timedelta(seconds=FRONTEND_HEARTBEAT_TTL_SECONDS)
    )


@router.get("/open-input-request", response_model=TaskOpenInputRequest | None)
def get_open_input_request():
    """Return the latest task input-open request for the frontend poller."""
    return _latest_request


@router.post("/open-input-client-heartbeat")
def record_open_input_client_heartbeat():
    """Record that a frontend tab is alive and polling for open-input requests."""
    global _last_frontend_heartbeat_at
    _last_frontend_heartbeat_at = datetime.now()
    return {"status": "ok"}


@router.post("/open-input-request/{request_id}/ack")
def acknowledge_open_input_request(request_id: int):
    """Clear a task input-open request after the frontend handles it."""
    global _latest_request

    cleared = _latest_request is not None and _latest_request.request_id == request_id
    if cleared:
        _latest_request = None
    return {"status": "ok", "cleared": cleared, "request_id": request_id}


@router.post("/{task_id}/open-input", response_model=TaskOpenInputResponse)
def request_open_input(task_id: int, db: Session = Depends(get_db)):
    """Request the active frontend to open the input modal for a task."""
    global _latest_request, _request_sequence

    if db.get(TaskModel, task_id) is None:
        raise HTTPException(status_code=404, detail="Task not found")

    # フロントエンドは「処理済みの最大ID」より大きいIDだけを処理する。
    # バックエンドを再起動してもIDが巻き戻らないよう、現在時刻（ミリ秒）以上の値を採番する。
    _request_sequence = max(_request_sequence + 1, int(time.time() * 1000))
    _latest_request = TaskOpenInputRequest(
        request_id=_request_sequence,
        task_id=task_id,
        created_at=now_string(),
    )
    gantt_visible, visibility_error = browser_window.try_show_gantt_window(
        gantt_frontend_url(),
        has_recent_frontend_heartbeat(),
    )
    return TaskOpenInputResponse(
        status="ok",
        task_id=task_id,
        input_opened=True,
        gantt_visible=gantt_visible,
        request=_latest_request,
        visibility_error=visibility_error,
    )
