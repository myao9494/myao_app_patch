"""
タスク・リンクのCSVエクスポート/インポート処理。

- エクスポート: tasks / links を現行システム互換のCSV（BOM付きUTF-8）にする。
- インポート: CSVを先にすべてパースしてから、削除と投入を1トランザクションで行う。
  途中で失敗した場合はロールバックされ、元のデータが残る。
- API（routers/csv_io.py）と復元スクリプト（restore_from_csv.py）の両方から使う。
"""
import csv
import io
import zipfile
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from models import Task as TaskModel, Link as LinkModel
from services.task_text import now_string, strip_leading_noise

TASK_CSV_HEADERS = [
    "id", "text", "start_date", "end_date", "duration", "progress",
    "parent", "kind_task", "ToDo", "task_schedule", "folder",
    "url_adress", "mail", "memo", "hyperlink", "color", "textColor",
    "owner_id", "sortorder", "edit_date", "is_pinned"
]

LINK_CSV_HEADERS = ["id", "source", "target", "type"]

UTF8_BOM = "﻿"
PINNED_TRUE_VALUES = {"1", "true", "True"}
# CSVで空欄だった場合に None として保存する任意項目
OPTIONAL_TEXT_FIELDS = (
    "color", "textColor", "ToDo", "task_schedule", "folder",
    "url_adress", "mail", "memo", "hyperlink", "edit_date",
)


class CsvDecodeError(ValueError):
    """アップロードされたファイルをUTF-8のCSVとして読めなかった。"""


@dataclass
class ParsedRows:
    """CSV1ファイル分のパース結果。rows はモデルのコンストラクタ引数。"""
    rows: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


# --- エクスポート ---

def _cell(value) -> str:
    """CSVセル用の文字列にする。未設定(None)は空欄にし、再インポート時に既定値で読めるようにする。"""
    return "" if value is None else str(value)


def build_task_export_row(task: TaskModel) -> dict[str, str]:
    row = {header: _cell(getattr(task, header)) for header in TASK_CSV_HEADERS}
    row["is_pinned"] = "1" if task.is_pinned else "0"
    return row


def build_link_export_row(link: LinkModel) -> dict[str, str]:
    return {header: _cell(getattr(link, header)) for header in LINK_CSV_HEADERS}


def _rows_to_csv(headers: list[str], rows: list[dict[str, str]]) -> str:
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(headers)
    for row in rows:
        writer.writerow([row[header] for header in headers])
    return UTF8_BOM + output.getvalue()


def generate_export_contents(db: Session) -> tuple[str, str]:
    """(tasks.csv の内容, links.csv の内容) を返す。"""
    tasks = db.query(TaskModel).order_by(TaskModel.parent, TaskModel.sortorder).all()
    links = db.query(LinkModel).order_by(LinkModel.id).all()
    return (
        _rows_to_csv(TASK_CSV_HEADERS, [build_task_export_row(task) for task in tasks]),
        _rows_to_csv(LINK_CSV_HEADERS, [build_link_export_row(link) for link in links]),
    )


# --- インポート ---

def split_upload_content(content: bytes) -> tuple[str, str]:
    """
    アップロードされたファイルから (tasks CSV, links CSV) のテキストを取り出す。
    ZIPならファイル名に "task" / "link" を含むCSVを探し、ZIPでなければタスクCSV単体として扱う。
    該当がないものは空文字列。
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile:
        try:
            return content.decode("utf-8-sig"), ""
        except UnicodeDecodeError as exc:
            raise CsvDecodeError("CSVファイルはUTF-8で保存してください") from exc

    tasks_csv = ""
    links_csv = ""
    with archive:
        for name in archive.namelist():
            if not name.endswith(".csv"):
                continue
            is_tasks = "task" in name.lower()
            if not is_tasks and "link" not in name.lower():
                continue
            try:
                text = archive.read(name).decode("utf-8-sig")
            except UnicodeDecodeError as exc:
                raise CsvDecodeError(f"{name} はUTF-8で保存してください") from exc
            if is_tasks:
                tasks_csv = text
            else:
                links_csv = text
    return tasks_csv, links_csv


def _int_or(value: str | None, default: int) -> int:
    return int(value) if value else default


def parse_task_csv(content: str) -> ParsedRows:
    """タスクCSVをパースする。変換できない行は errors に記録してスキップする。"""
    parsed = ParsedRows()
    now = now_string()
    reader = csv.DictReader(io.StringIO(content.lstrip(UTF8_BOM)))
    for row_num, row in enumerate(reader, start=2):
        if not row.get("text") and not row.get("id"):
            continue
        try:
            task = {
                "id": int(row.get("id", 0)),
                "text": strip_leading_noise(row.get("text", "")),
                "start_date": row.get("start_date") or now,
                "end_date": row.get("end_date") or now,
                "duration": _int_or(row.get("duration"), 1),
                "progress": float(row["progress"]) if row.get("progress") else 0.0,
                "parent": _int_or(row.get("parent"), 0),
                "kind_task": _int_or(row.get("kind_task"), 1),
                "owner_id": _int_or(row.get("owner_id"), 0),
                "sortorder": _int_or(row.get("sortorder"), 0),
                "is_pinned": 1 if (row.get("is_pinned") or "").strip() in PINNED_TRUE_VALUES else 0,
                "created_at": now,
                "updated_at": now,
            }
            for field_name in OPTIONAL_TEXT_FIELDS:
                task[field_name] = row.get(field_name) or None
            parsed.rows.append(task)
        except Exception as e:
            parsed.errors.append(f"Task 行 {row_num}: {str(e)}")
    return parsed


def parse_link_csv(content: str) -> ParsedRows:
    """リンクCSVをパースする。変換できない行は errors に記録してスキップする。"""
    parsed = ParsedRows()
    reader = csv.DictReader(io.StringIO(content.lstrip(UTF8_BOM)))
    for row_num, row in enumerate(reader, start=2):
        if not row.get("source") or not row.get("target"):
            continue
        try:
            parsed.rows.append({
                "id": int(row["id"]) if row.get("id") else None,
                "source": int(row["source"]),
                "target": int(row["target"]),
                "type": _int_or(row.get("type"), 0),
            })
        except Exception as e:
            parsed.errors.append(f"Link 行 {row_num}: {str(e)}")
    return parsed


def replace_tables(
    db: Session,
    task_rows: list[dict] | None,
    link_rows: list[dict] | None,
) -> None:
    """
    tasks / links テーブルを渡された行で置き換える（None のテーブルには触れない）。
    削除と投入を1トランザクションで行い、失敗時はロールバックして例外を再送出する。
    """
    try:
        if task_rows is not None:
            db.query(TaskModel).delete()
            db.add_all(TaskModel(**row) for row in task_rows)
        if link_rows is not None:
            db.query(LinkModel).delete()
            db.add_all(LinkModel(**row) for row in link_rows)
        db.commit()
    except Exception:
        db.rollback()
        raise
