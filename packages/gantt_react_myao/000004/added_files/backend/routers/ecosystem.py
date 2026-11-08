"""
エコシステム API（ハーネスの LLM や、ほかの自作アプリから使う共通の入口）。
共通の形は、ハーネス（opencode）の docs/apps.md の「エコシステム API 1」。

- GET /api/ecosystem: アプリの名乗り。版、人が開く深いリンクのひな形、使ってよい操作の一覧
- GET /api/ecosystem/tasks: タスクを、LLM が読みやすい小さな形で探す（読み取りだけ）
    入力: q（空白区切りで AND。タスク名・メモ・ToDo・フォルダに、大文字小文字を区別せず部分一致）、
          status（open: 進捗 100% 未満 / done: 100% / all。既定 open）、
          due_within_days（最終日が「基準日 + N 日」以前。期限切れも含む）、
          limit（1〜200。既定 30）、today（基準日 YYYY-MM-DD。既定は今日）
    出力: total（一致した件数）、truncated（limit で切ったか）、items（id、名前、種類、開始・終了の日付、
          最終日 last_day（保存している終了日は「最終日の翌日」なので、人が言う期限はこちら）、
          進捗 %、親の id、親のタスク名を「 > 」でつないだ path、担当、ピン留め、期限切れ、残り日数、
          ToDo の先頭 100 文字（改行は「 / 」でつないだ 1 行）、メモの有無、つながっているノートの名前 link）。期限切れ・残り日数・due_within_days は最終日で判定する。
          メモの本文は返さない（詳しくは GET /api/tasks/{id}）。
    並び: open と all は終了日の早い順、done は終了日の遅い順。
作成・更新は、既存の POST /api/tasks・PUT /api/tasks/{id} を使う（operations に載せる）。削除は載せない。
"""
from datetime import date, datetime, timedelta
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from database import get_db
from models import Task as TaskModel

router = APIRouter(prefix="/api/ecosystem", tags=["ecosystem"])

ECOSYSTEM_VERSION = 1
APP_ID = "gantt"
APP_TITLE = "ガントチャート（タスクとスケジュール）"

OPERATIONS = [
    {"id": "tasks.search", "method": "GET", "path": "/api/ecosystem/tasks", "effect": "read"},
    {"id": "tasks.get", "method": "GET", "path": "/api/tasks/{task_id}", "effect": "read"},
    {"id": "tasks.create", "method": "POST", "path": "/api/tasks", "effect": "write"},
    {"id": "tasks.update", "method": "PUT", "path": "/api/tasks/{task_id}", "effect": "write"},
]
LINKS = {"home": "/"}

KIND_LABELS = {1: "task", 2: "project", 3: "milestone"}
OWNER_LABELS = {0: "自分", 10: "待", 20: "サイン取", 30: "他"}
TODO_PREVIEW_CHARS = 100


@router.get("")
def ecosystem_manifest(request: Request) -> dict:
    """アプリの名乗り（エコシステム API 1 の共通の形）。"""
    from main import APP_VERSION  # main が router を読み込むので、循環を避けて呼び出し時に読む

    return {
        "ecosystem": ECOSYSTEM_VERSION,
        "app": APP_ID,
        "title": APP_TITLE,
        "version": APP_VERSION,
        "base_url": str(request.base_url).rstrip("/"),
        "links": LINKS,
        "operations": OPERATIONS,
    }


def _date_part(value: Optional[str]) -> str:
    """'YYYY-MM-DD HH:mm:ss' から日付だけを取り出す。"""
    return (value or "")[:10]


def _parse_date(value: Optional[str]) -> Optional[date]:
    try:
        return datetime.strptime(_date_part(value), "%Y-%m-%d").date()
    except ValueError:
        return None


def _last_day(task: TaskModel) -> Optional[date]:
    """最終日（保存している終了日の前日。開始日より前にはしない）。"""
    end = _parse_date(task.end_date)
    if end is None:
        return None
    start = _parse_date(task.start_date)
    last = end - timedelta(days=1)
    return max(last, start) if start else last


def _is_done(task: TaskModel) -> bool:
    return (task.progress or 0.0) >= 1.0


def _matches(task: TaskModel, terms: list[str]) -> bool:
    haystack = " ".join(filter(None, [task.text, task.memo, task.ToDo, task.folder])).lower()
    return all(term in haystack for term in terms)


def _path_of(task: TaskModel, by_id: dict[int, TaskModel]) -> str:
    """親のタスク名を、上から順に「 > 」でつなぐ（循環していても止まる）。"""
    names: list[str] = []
    seen = {task.id}
    parent_id = task.parent or 0
    while parent_id and parent_id in by_id and parent_id not in seen:
        seen.add(parent_id)
        parent = by_id[parent_id]
        names.append(parent.text)
        parent_id = parent.parent or 0
    return " > ".join(reversed(names))


def _link_name(hyperlink: Optional[str]) -> Optional[str]:
    """つながっているノート・URL を短く返す。ローカルのパスはファイル名だけ（Obsidian のノートは `名前【ID】.md`）。"""
    value = (hyperlink or "").strip()
    if not value:
        return None
    if value.startswith(("http://", "https://")):
        return value
    return value.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]


def _compact(task: TaskModel, by_id: dict[int, TaskModel], today: date) -> dict:
    last = _last_day(task)
    # 1 行で読めるように、改行を「 / 」でつなぐ（一覧の 1 行が崩れないように）
    todo = " / ".join(line.strip() for line in (task.ToDo or "").splitlines() if line.strip())
    if len(todo) > TODO_PREVIEW_CHARS:
        todo = todo[:TODO_PREVIEW_CHARS] + "…"
    return {
        "id": task.id,
        "text": task.text,
        "kind": KIND_LABELS.get(task.kind_task or 1, str(task.kind_task)),
        "start": _date_part(task.start_date),
        "end": _date_part(task.end_date),
        "last_day": last.isoformat() if last else None,
        "progress": round((task.progress or 0.0) * 100),
        "parent": task.parent or 0,
        "path": _path_of(task, by_id),
        "owner": OWNER_LABELS.get(task.owner_id or 0, str(task.owner_id)),
        "pinned": bool(task.is_pinned),
        "overdue": bool(last and last < today and not _is_done(task)),
        "days_left": (last - today).days if last else None,
        "todo": todo or None,
        "has_memo": bool((task.memo or "").strip()),
        "link": _link_name(task.hyperlink),
    }


@router.get("/tasks")
def search_tasks(
    q: str = "",
    status: Literal["open", "done", "all"] = "open",
    due_within_days: Optional[int] = Query(None, ge=0, le=3650),
    limit: int = Query(30, ge=1, le=200),
    today: Optional[date] = None,
    db: Session = Depends(get_db),
) -> dict:
    """タスクを小さな形で探す（読み取りだけ）。"""
    base = today or date.today()
    tasks = db.query(TaskModel).all()
    by_id = {task.id: task for task in tasks}
    terms = [term.lower() for term in q.split() if term]

    selected = []
    for task in tasks:
        if status == "open" and _is_done(task):
            continue
        if status == "done" and not _is_done(task):
            continue
        if terms and not _matches(task, terms):
            continue
        if due_within_days is not None:
            last = _last_day(task)
            if last is None or (last - base).days > due_within_days:
                continue
        selected.append(task)

    selected.sort(key=lambda t: (_date_part(t.end_date), t.id), reverse=(status == "done"))
    items = [_compact(task, by_id, base) for task in selected[:limit]]
    return {"total": len(selected), "truncated": len(selected) > limit, "items": items}
