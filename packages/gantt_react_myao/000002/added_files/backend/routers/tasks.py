"""
タスクAPIルーター。
タスクのCRUD、再帰クローン、並び替え、Obsidianノート作成・リンク再解決、更新シーケンス取得を提供する。
データを変更したら update_sequence.increment() を呼び、他のブラウザタブの自動更新を促す。
"""
import os
import re
import unicodedata
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from config import default_obsidian_home
from database import get_db
from models import Task as TaskModel, Link as LinkModel
from schemas import (
    Task,
    TaskCreate,
    TaskUpdate,
    GanttData,
    DeleteResponse,
    TaskReorderRequest,
    ResolvedTaskLink,
)
from services import update_sequence
from services.task_text import (
    DEFAULT_TASK_TEXT,
    calculate_duration,
    now_string,
    sanitize_task_text,
)

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

# ファイル名に使えない文字（Obsidianノートのファイル名では _ に置換する）
INVALID_FILENAME_CHARS_RE = re.compile(r'[\\/:*?"<>|]')
# SQLiteのバインド変数上限を超えないよう、IN句はこの件数ごとに分割する
IN_CLAUSE_CHUNK_SIZE = 500

# クローン時にコピーするカラム（id・親子関係・進捗・日時系は個別に設定する）
CLONE_COPY_FIELDS = (
    "text", "start_date", "end_date", "duration", "kind_task", "owner_id",
    "color", "textColor", "ToDo", "task_schedule", "folder", "url_adress",
    "mail", "memo", "hyperlink", "is_pinned",
)


def _get_task_or_404(db: Session, task_id: int) -> TaskModel:
    task = db.get(TaskModel, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


def _collect_descendant_ids(db: Session, task_id: int) -> list[int]:
    """task_id 配下の全子孫タスクIDを深さ優先順で返す（task_id 自身は含まない）。"""
    children_by_parent: dict[int, list[int]] = defaultdict(list)
    for child_id, parent_id in db.query(TaskModel.id, TaskModel.parent).all():
        children_by_parent[parent_id].append(child_id)

    descendants: list[int] = []
    visited = {task_id}
    stack = list(reversed(children_by_parent.get(task_id, [])))
    while stack:
        current = stack.pop()
        if current in visited:
            continue
        visited.add(current)
        descendants.append(current)
        stack.extend(reversed(children_by_parent.get(current, [])))
    return descendants


def _resolve_existing_path(path_value: str | None) -> str | None:
    """Return the real path if it exists, tolerating macOS Unicode normalization differences."""
    if not path_value:
        return None

    path = Path(path_value).expanduser()
    if path.exists():
        return str(path)

    parent = path.parent
    if not parent.exists():
        return None

    target_name = unicodedata.normalize('NFC', path.name)
    for candidate in parent.iterdir():
        if unicodedata.normalize('NFC', candidate.name) == target_name:
            return str(candidate)

    return None


def _normalize_path_string(path_value: str) -> str:
    return str(Path(path_value).expanduser().resolve(strict=False))


def _paths_equivalent(path_a: str, path_b: str) -> bool:
    return _normalize_path_string(path_a) == _normalize_path_string(path_b)


def _is_path_under_home(path_value: str, obsidian_home: str) -> bool:
    normalized_path = _normalize_path_string(path_value)
    normalized_home = _normalize_path_string(obsidian_home)
    return normalized_path == normalized_home or normalized_path.startswith(normalized_home + os.sep)


def _find_obsidian_note_by_task_id(obsidian_home: str, task_id: int) -> str | None:
    """Search the Obsidian vault for a note that still contains the task id marker."""
    token = f"【{task_id}】"
    home = Path(obsidian_home).expanduser()
    if not home.exists():
        return None

    for candidate in home.rglob(f"*{token}*.md"):
        if candidate.is_file():
            return str(candidate)

    return None


@router.get("", response_model=GanttData)
def get_all_tasks(db: Session = Depends(get_db)):
    """Get all tasks and links."""
    tasks = db.query(TaskModel).order_by(TaskModel.parent, TaskModel.sortorder).all()
    links = db.query(LinkModel).all()
    return GanttData(tasks=tasks, links=links)


@router.get("/update-sequence")
def get_update_sequence():
    """現在のGanttデータ更新シーケンス番号を取得する。"""
    return {"sequence": update_sequence.current()}


@router.get("/{task_id}", response_model=Task)
def get_task(task_id: int, db: Session = Depends(get_db)):
    """Get a single task by ID."""
    return _get_task_or_404(db, task_id)


@router.post("", response_model=Task)
def create_task(task: TaskCreate, db: Session = Depends(get_db)):
    """
    Create a new task.

    sortorder の解釈:
    - 負の値: 同じ親の先頭に追加（既存の兄弟を1つずつ後ろへずらす）
    - 正の値: その位置に挿入（それ以降の兄弟を1つずつ後ろへずらす）
    - 0 または未指定: 同じ親の末尾に追加
    """
    now = now_string()
    duration = task.duration or calculate_duration(task.start_date, task.end_date)
    parent_id = task.parent or 0
    siblings = db.query(TaskModel).filter(TaskModel.parent == parent_id)

    if task.sortorder is not None and task.sortorder < 0:
        siblings.update({TaskModel.sortorder: TaskModel.sortorder + 1})
        new_sortorder = 0
    elif task.sortorder is not None and task.sortorder > 0:
        siblings.filter(TaskModel.sortorder >= task.sortorder).update(
            {TaskModel.sortorder: TaskModel.sortorder + 1}
        )
        new_sortorder = task.sortorder
    else:
        max_sortorder = db.query(func.max(TaskModel.sortorder)).filter(
            TaskModel.parent == parent_id
        ).scalar()
        new_sortorder = (max_sortorder if max_sortorder is not None else -1) + 1

    db_task = TaskModel(
        **({"id": task.id} if task.id is not None else {}),
        text=sanitize_task_text(task.text),
        start_date=task.start_date,
        end_date=task.end_date,
        duration=duration,
        progress=task.progress or 0.0,
        parent=parent_id,
        kind_task=task.kind_task or 1,
        owner_id=task.owner_id or 0,
        sortorder=new_sortorder,
        color=task.color,
        textColor=task.textColor,
        ToDo=task.ToDo,
        task_schedule=task.task_schedule,
        folder=task.folder,
        url_adress=task.url_adress,
        mail=task.mail,
        memo=task.memo,
        hyperlink=task.hyperlink,
        edit_date=task.edit_date,
        is_pinned=1 if task.is_pinned else 0,
        created_at=now,
        updated_at=now,
    )
    db.add(db_task)
    db.commit()
    update_sequence.increment()
    db.refresh(db_task)
    return db_task


@router.put("/{task_id}", response_model=Task)
def update_task(task_id: int, task: TaskUpdate, db: Session = Depends(get_db)):
    """Update a task. 送られてきた項目だけを更新する。"""
    db_task = _get_task_or_404(db, task_id)

    update_data = task.model_dump(exclude_unset=True)

    if update_data.get("text") is not None:
        update_data["text"] = sanitize_task_text(update_data["text"])
    if update_data.get("is_pinned") is not None:
        update_data["is_pinned"] = 1 if update_data["is_pinned"] else 0

    # 日付が変わったら期間を再計算する
    if "start_date" in update_data or "end_date" in update_data:
        start = update_data.get("start_date", db_task.start_date)
        end = update_data.get("end_date", db_task.end_date)
        update_data["duration"] = calculate_duration(start, end)

    update_data["updated_at"] = now_string()

    # 編集日の履歴（カンマ区切り）に今日を追記する
    today = datetime.now().strftime("%Y-%m-%d")
    if db_task.edit_date:
        if today not in db_task.edit_date:
            update_data["edit_date"] = f"{db_task.edit_date},{today}"
    else:
        update_data["edit_date"] = today

    for key, value in update_data.items():
        setattr(db_task, key, value)

    db.commit()
    update_sequence.increment()
    db.refresh(db_task)
    return db_task


@router.delete("/{task_id}", response_model=DeleteResponse)
def delete_task(task_id: int, db: Session = Depends(get_db)):
    """Delete a task, all its descendants, and the links attached to any of them."""
    _get_task_or_404(db, task_id)

    deleted_children = _collect_descendant_ids(db, task_id)
    all_ids = [task_id, *deleted_children]

    for offset in range(0, len(all_ids), IN_CLAUSE_CHUNK_SIZE):
        chunk = all_ids[offset:offset + IN_CLAUSE_CHUNK_SIZE]
        db.query(LinkModel).filter(
            LinkModel.source.in_(chunk) | LinkModel.target.in_(chunk)
        ).delete(synchronize_session=False)
        db.query(TaskModel).filter(TaskModel.id.in_(chunk)).delete(synchronize_session=False)

    db.commit()
    update_sequence.increment()
    return DeleteResponse(deleted_id=task_id, deleted_children=deleted_children)


@router.post("/{task_id}/obsidian", response_model=Task)
def create_obsidian_note(task_id: int, obsidian_home: str | None = None, db: Session = Depends(get_db)):
    """
    Create an Obsidian note for the task and update its hyperlink.

    作成先: {obsidian_home}/01_data/{YYYY}/{MM}/{DD}/{タスク名}【{id}】.md
    同名ファイルが既にあれば作り直さず、そのパスをリンクする。
    """
    db_task = _get_task_or_404(db, task_id)

    if not obsidian_home:
        obsidian_home = default_obsidian_home()
    now = datetime.now()
    folder_path = os.path.join(obsidian_home, "01_data", now.strftime("%Y/%m/%d"))
    os.makedirs(folder_path, exist_ok=True)

    # macOS/Obsidian で扱いやすいよう NFC に正規化する
    text_content = db_task.text.strip() if db_task.text else DEFAULT_TASK_TEXT
    text_content = unicodedata.normalize('NFC', text_content)

    safe_title = INVALID_FILENAME_CHARS_RE.sub('_', text_content).strip()
    file_path = os.path.join(folder_path, f"{safe_title}【{task_id}】.md")

    if not os.path.exists(file_path):
        # APFSの正規化差異（NFC/NFD）で見つからないだけの既存ファイルを探す
        existing_path = _resolve_existing_path(file_path)
        if existing_path:
            file_path = existing_path
        else:
            content = f"---\ncreated: {now.strftime('%Y-%m-%d %H:%M:%S')}\ntags:\n---\n\n"
            try:
                with open(file_path, "w", encoding="utf-8", newline="\n") as f:
                    f.write(content)
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Failed to create Obsidian note file: {str(e)}")

    db_task.hyperlink = file_path
    db_task.updated_at = now_string()
    db.commit()
    db.refresh(db_task)

    return db_task


@router.post("/{task_id}/resolve-link", response_model=ResolvedTaskLink)
def resolve_task_link(task_id: int, obsidian_home: str | None = None, db: Session = Depends(get_db)):
    """Resolve a task hyperlink, re-linking Obsidian notes by task id if the file was renamed."""
    db_task = _get_task_or_404(db, task_id)
    if not db_task.hyperlink:
        raise HTTPException(status_code=404, detail="Task hyperlink not found")

    current_path = db_task.hyperlink.strip()
    resolved_path = _resolve_existing_path(current_path)
    if resolved_path:
        updated = not _paths_equivalent(resolved_path, current_path)
    else:
        # ファイルが見つからない場合は、Vault内のノートに限りタスクIDのマーカー【id】で探し直す
        if not obsidian_home or not _is_path_under_home(current_path, obsidian_home):
            raise HTTPException(status_code=404, detail="Linked file not found")

        resolved_path = _find_obsidian_note_by_task_id(obsidian_home, task_id)
        if not resolved_path:
            raise HTTPException(status_code=404, detail=f"Obsidian note not found for task id {task_id}")
        updated = True

    if updated:
        db_task.hyperlink = resolved_path
        db_task.updated_at = now_string()
        db.commit()

    return ResolvedTaskLink(task_id=task_id, hyperlink=resolved_path, updated=updated)


@router.post("/{task_id}/clone", response_model=Task)
def clone_task(task_id: int, target_id: int | None = None, db: Session = Depends(get_db)):
    """
    タスクを再帰的にクローンする（進捗は0に戻す）。
    target_id が指定された場合、そのタスクの後ろ（同じ parent, sortorder+1）に挿入する。
    指定なしの場合はコピー元タスクの直後に挿入する。
    """
    db_task = _get_task_or_404(db, task_id)

    if target_id is not None:
        anchor = db.get(TaskModel, target_id)
        if not anchor:
            raise HTTPException(status_code=404, detail="Target task not found")
    else:
        anchor = db_task
    insert_parent = anchor.parent
    insert_sortorder = anchor.sortorder + 1

    # 挿入位置以降の兄弟を1つずつ後ろへずらす
    db.query(TaskModel).filter(
        TaskModel.parent == insert_parent,
        TaskModel.sortorder >= insert_sortorder
    ).update({TaskModel.sortorder: TaskModel.sortorder + 1})

    now = now_string()

    def clone_recursive(original: TaskModel, new_parent_id: int, new_sortorder: int) -> TaskModel:
        # 先に子を取得しておく（クローン先がコピー元の配下でも、作成中の複製を辿らないようにする）
        children = (
            db.query(TaskModel)
            .filter(TaskModel.parent == original.id)
            .order_by(TaskModel.sortorder)
            .all()
        )
        new_task = TaskModel(
            **{field: getattr(original, field) for field in CLONE_COPY_FIELDS},
            progress=0.0,
            parent=new_parent_id,
            sortorder=new_sortorder,
            created_at=now,
            updated_at=now,
        )
        db.add(new_task)
        db.flush()  # 子の parent に使うIDを確定させる

        for child in children:
            clone_recursive(child, new_task.id, child.sortorder)

        return new_task

    cloned_task = clone_recursive(db_task, insert_parent, insert_sortorder)
    db.commit()
    update_sequence.increment()
    db.refresh(cloned_task)
    return cloned_task


@router.post("/reorder")
def reorder_tasks(request: TaskReorderRequest, db: Session = Depends(get_db)):
    """Reorder tasks in batch."""
    try:
        updates = {item.id: item for item in request.items}
        tasks = db.query(TaskModel).filter(TaskModel.id.in_(updates.keys())).all()

        now = now_string()
        for task in tasks:
            update = updates[task.id]
            task.sortorder = update.sortorder
            task.parent = update.parent
            task.updated_at = now

        db.commit()
        update_sequence.increment()
        return {"status": "success", "updated_count": len(tasks)}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
