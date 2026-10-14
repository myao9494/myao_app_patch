"""
フォルダ履歴管理ルーター
- GET /api/history: 履歴を取得（旧形式の文字列リストも新形式に変換して返す）
- POST /api/history: 履歴を保存（アトミック書き込みで、保存中の異常終了でも履歴ファイルを壊さない）
- 保存先: backend/folder_history.json（起動時のカレントディレクトリに依存しない。git管理外）
"""
import json
import time
from pathlib import Path
from typing import List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.fileio import atomic_write_text
from app.services.paths import run_in_io_thread

router = APIRouter()

HISTORY_FILE = Path(__file__).resolve().parent.parent.parent / "folder_history.json"


class HistoryItem(BaseModel):
    path: str
    count: int = 1
    timestamp: float = 0


class HistoryPayload(BaseModel):
    history: List[HistoryItem]


def _load_history() -> List[HistoryItem]:
    if not HISTORY_FILE.exists():
        return []
    try:
        data = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"Error reading history file: {e}")
        return []

    if not isinstance(data, list):
        return []

    items: List[HistoryItem] = []
    current_time = time.time()
    for entry in data:
        try:
            if isinstance(entry, str):
                # 旧形式（文字列のリスト）は count=1 の新形式に変換する
                items.append(HistoryItem(path=entry, count=1, timestamp=current_time))
            elif isinstance(entry, dict):
                items.append(HistoryItem(**entry))
        except (TypeError, ValueError):
            continue  # 壊れた1件があっても残りの履歴は返す
    return items


@router.get("/history", response_model=List[HistoryItem])
async def get_history():
    """フォルダ履歴を取得する"""
    return await run_in_io_thread(_load_history)


@router.post("/history")
async def save_history(payload: HistoryPayload):
    """フォルダ履歴を保存する"""
    save_data = [item.model_dump() for item in payload.history]
    try:
        await run_in_io_thread(
            atomic_write_text, HISTORY_FILE, json.dumps(save_data, ensure_ascii=False, indent=2)
        )
    except OSError as e:
        print(f"Error saving history file: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save history: {str(e)}")
    return {"status": "success"}
