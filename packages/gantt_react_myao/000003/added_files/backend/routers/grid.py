"""
グリッド編集用APIルーター
ステージングテーブル（grid_tasks, grid_links）を使った
差分確認・アップロード機能を提供する。

グリッド上の編集はまずステージングに保存され、commit で初めて本テーブルに反映される。
反映対象は「本テーブルに既に存在する行の値の変更」のみ（行の追加・削除は扱わない）。
"""
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from models import Task, Link, GridTask, GridLink
from schemas import (
    GridDiffItem,
    GridDiffResponse,
    GridCommitResponse,
    TaskUpdate,
    GridRevertRequest,
)
from services import update_sequence
from services.task_text import REQUIRED_TASK_FIELDS, calculate_duration, sanitize_task_text

router = APIRouter(prefix="/api/grid", tags=["grid"])

# --- タスクの比較対象カラム ---
TASK_COMPARE_FIELDS = [
    "text", "start_date", "end_date", "duration", "progress",
    "parent", "kind_task", "owner_id", "sortorder",
    "color", "textColor", "ToDo", "task_schedule", "folder",
    "url_adress", "mail", "memo", "hyperlink", "edit_date", "is_pinned",
]

# --- リンクの比較対象カラム ---
LINK_COMPARE_FIELDS = ["source", "target", "type"]

TASK_COPY_FIELDS = ["id", *TASK_COMPARE_FIELDS, "created_at", "updated_at"]
LINK_COPY_FIELDS = ["id", *LINK_COMPARE_FIELDS]

# リンクのNOT NULLカラム。None(null) が送られてきた場合は更新をスキップする
LINK_MANDATORY_FIELDS = {"source", "target"}


@router.post("/init")
def init_grid(db: Session = Depends(get_db)):
    """
    ステージング初期化: tasks→grid_tasks, links→grid_links にデータをコピーする。
    既存のステージングデータはクリアされる。
    """
    db.query(GridTask).delete()
    db.query(GridLink).delete()
    db.flush()

    tasks = db.query(Task).all()
    if tasks:
        db.bulk_insert_mappings(
            GridTask,
            [{field: getattr(task, field) for field in TASK_COPY_FIELDS} for task in tasks],
        )

    links = db.query(Link).all()
    if links:
        db.bulk_insert_mappings(
            GridLink,
            [{field: getattr(link, field) for field in LINK_COPY_FIELDS} for link in links],
        )

    db.commit()
    return {"status": "ok", "tasks_count": len(tasks), "links_count": len(links)}


def _end_date_from_duration(start_date: str, duration: int) -> str:
    """開始日と期間（日数、最低1日）から終了日文字列を求める。"""
    start = datetime.strptime(start_date.split(" ")[0], "%Y-%m-%d")
    end = start + timedelta(days=max(1, int(duration)))
    return end.strftime("%Y-%m-%d 00:00:00")


@router.put("/tasks/{task_id}")
def update_grid_task(task_id: int, task_data: TaskUpdate, db: Session = Depends(get_db)):
    """
    ステージング上のタスクを1件更新する。

    Ganttチャートの描画と整合するよう、日付と期間は連動させる:
    - 開始日または終了日が変わった場合: 期間を再計算する
    - 期間だけが変わった場合: 開始日 + 期間 で終了日を再計算する
    """
    grid_task = db.get(GridTask, task_id)
    if not grid_task:
        raise HTTPException(status_code=404, detail=f"GridTask {task_id} not found")

    update_dict = task_data.model_dump(exclude_unset=True)

    if update_dict.get("text") is not None:
        update_dict["text"] = sanitize_task_text(update_dict["text"])

    for key, value in update_dict.items():
        if key in REQUIRED_TASK_FIELDS and value is None:
            continue
        setattr(grid_task, key, value)

    if "start_date" in update_dict or "end_date" in update_dict:
        grid_task.duration = calculate_duration(grid_task.start_date, grid_task.end_date)
    elif "duration" in update_dict and grid_task.start_date and grid_task.duration is not None:
        try:
            grid_task.end_date = _end_date_from_duration(grid_task.start_date, grid_task.duration)
        except (ValueError, TypeError, AttributeError):
            pass  # 開始日がパースできない場合は終了日を変更しない

    db.commit()
    return {"status": "ok", "id": task_id}


@router.put("/links/{link_id}")
def update_grid_link(link_id: int, link_data: dict, db: Session = Depends(get_db)):
    """ステージング上のリンクを1件更新する。"""
    grid_link = db.get(GridLink, link_id)
    if not grid_link:
        raise HTTPException(status_code=404, detail=f"GridLink {link_id} not found")

    for key, value in link_data.items():
        if key not in LINK_COMPARE_FIELDS:
            continue
        if key in LINK_MANDATORY_FIELDS and value is None:
            continue
        setattr(grid_link, key, value)

    db.commit()
    return {"status": "ok", "id": link_id}


def _safe_str(val) -> Optional[str]:
    """値を比較用文字列に変換する。Noneはそのまま返す。"""
    if val is None:
        return None
    return str(val)


def _collect_diffs(table: str, originals: dict, staged: dict, fields: list[str]) -> List[GridDiffItem]:
    """本テーブルとステージングをフィールド単位で比較し、値が異なる箇所を返す。"""
    diffs: List[GridDiffItem] = []
    for item_id, staged_item in staged.items():
        original_item = originals.get(item_id)
        for field in fields:
            original_value = _safe_str(getattr(original_item, field, None)) if original_item else None
            current_value = _safe_str(getattr(staged_item, field, None))
            if original_value != current_value:
                diffs.append(GridDiffItem(
                    id=item_id, table=table, field=field,
                    original=original_value, current=current_value,
                ))
    return diffs


@router.get("/diff", response_model=GridDiffResponse)
def get_grid_diff(db: Session = Depends(get_db)):
    """
    本テーブル（tasks, links）とステージング（grid_tasks, grid_links）の差分を返す。
    フィールド単位で比較し、値が異なる箇所のみを返す。
    """
    task_diffs = _collect_diffs(
        "tasks",
        {t.id: t for t in db.query(Task).all()},
        {t.id: t for t in db.query(GridTask).all()},
        TASK_COMPARE_FIELDS,
    )
    link_diffs = _collect_diffs(
        "links",
        {l.id: l for l in db.query(Link).all()},
        {l.id: l for l in db.query(GridLink).all()},
        LINK_COMPARE_FIELDS,
    )
    return GridDiffResponse(diffs=[*task_diffs, *link_diffs])


def _apply_staged_changes(originals: dict, staged_items: list, fields: list[str]) -> int:
    """ステージングの値を本テーブルの行へ書き戻し、変更のあった行数を返す。"""
    updated_count = 0
    for staged_item in staged_items:
        original_item = originals.get(staged_item.id)
        if not original_item:
            continue  # 本テーブルに存在しないIDは無視

        has_change = False
        for field in fields:
            if _safe_str(getattr(original_item, field, None)) != _safe_str(getattr(staged_item, field, None)):
                has_change = True
                setattr(original_item, field, getattr(staged_item, field))
        if has_change:
            updated_count += 1
    return updated_count


@router.post("/commit", response_model=GridCommitResponse)
def commit_grid(db: Session = Depends(get_db)):
    """
    ステージングの変更を本テーブルに反映する（一括アップロード）。
    差分のある行のみを本テーブルに書き戻す。差分がなければ何もしない。
    """
    grid_tasks = db.query(GridTask).all()
    for grid_task in grid_tasks:
        # 本テーブルへ反映する直前にも、タスク名先頭のインデントやアイコンを念のため除去する
        if grid_task.text is not None:
            grid_task.text = sanitize_task_text(grid_task.text)

    updated_tasks = _apply_staged_changes(
        {t.id: t for t in db.query(Task).all()}, grid_tasks, TASK_COMPARE_FIELDS,
    )
    updated_links = _apply_staged_changes(
        {l.id: l for l in db.query(Link).all()}, db.query(GridLink).all(), LINK_COMPARE_FIELDS,
    )

    if updated_tasks or updated_links:
        db.commit()
        update_sequence.increment()

    return GridCommitResponse(updated_tasks=updated_tasks, updated_links=updated_links, errors=[])


@router.post("/revert")
def revert_grid_diff(req: GridRevertRequest, db: Session = Depends(get_db)):
    """指定された差分を元（本テーブルの値）に戻す。"""
    if req.table == "tasks":
        original_model, staged_model, fields, label = Task, GridTask, TASK_COMPARE_FIELDS, "Task"
    elif req.table == "links":
        original_model, staged_model, fields, label = Link, GridLink, LINK_COMPARE_FIELDS, "Link"
    else:
        raise HTTPException(status_code=400, detail="Invalid table")

    original_item = db.get(original_model, req.id)
    staged_item = db.get(staged_model, req.id)
    if not original_item or not staged_item:
        raise HTTPException(status_code=404, detail=f"{label} not found")
    if req.field not in fields:
        raise HTTPException(status_code=400, detail="Invalid field")

    setattr(staged_item, req.field, getattr(original_item, req.field))
    db.commit()
    return {"status": "ok"}
