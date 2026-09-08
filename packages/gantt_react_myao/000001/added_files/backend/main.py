"""
FastAPIバックエンドアプリケーションのエントリポイント。
タスク、リンク、グリッド編集、休日・出張管理などのAPIルーティングと静的ファイル配信を提供する。
"""
import csv
import json
import io
import re
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime
from typing import List
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
import httpx
import os
from sqlalchemy.orm import Session

from database import init_db, SessionLocal, get_db
from models import Task as TaskModel, Link as LinkModel
from routers import tasks, links, grid
from routers.tasks import increment_gantt_update_sequence
from schemas import (
    BusinessTripCreateRequest,
    BusinessTripListResponse,
    BusinessTripRawUpdateRequest,
    HolidayCreateRequest,
    HolidayListResponse,
    HolidayRawUpdateRequest,
    ImportResponse,
    ObsidianCsvSyncSummary,
    ObsidianCsvSummaryNotFound,
    SynonymGroupsResponse,
)

HASHED_ASSET_PATTERN = re.compile(r".*-[0-9A-Za-z]{6,}\.(js|css|mjs)$")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    # Startup
    init_db()
    yield
    # Shutdown (nothing to clean up)


app = FastAPI(
    title="Gantt Chart API",
    description="API for Gantt Chart application",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS configuration - allow all origins (個人利用のため無制限)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(tasks.router)
app.include_router(links.router)
app.include_router(grid.router)


@app.get("/api/health")
def health_check():
    """Health check endpoint."""
    return {"status": "ok", "version": "1.0.0"}


def _normalize_holiday_line(line: str) -> str:
    return line.strip()


def _validate_holiday_date(date_str: str) -> str:
    normalized = (date_str or "").strip()
    if not HOLIDAY_DATE_PATTERN.fullmatch(normalized):
        raise HTTPException(status_code=400, detail="date must be in YYYY-MM-DD format")

    try:
        datetime.strptime(normalized, "%Y-%m-%d")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="date is invalid") from exc
    return normalized


def _parse_holiday_lines(raw_text: str) -> list[str]:
    holidays: list[str] = []
    seen: set[str] = set()

    for line in raw_text.splitlines():
        normalized = _normalize_holiday_line(line)
        if not normalized:
            continue
        valid_date = _validate_holiday_date(normalized)
        if valid_date not in seen:
            seen.add(valid_date)
            holidays.append(valid_date)

    holidays.sort()
    return holidays


def _load_holiday_file() -> tuple[list[str], str]:
    HOLIDAYS_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not HOLIDAYS_FILE_PATH.exists():
        HOLIDAYS_FILE_PATH.write_text("", encoding="utf-8")

    raw_text = HOLIDAYS_FILE_PATH.read_text(encoding="utf-8")
    holidays = _parse_holiday_lines(raw_text)
    normalized_text = "\n".join(holidays)

    if raw_text != normalized_text and raw_text != normalized_text + "\n":
        HOLIDAYS_FILE_PATH.write_text(
            normalized_text + ("\n" if normalized_text else ""),
            encoding="utf-8",
        )

    return holidays, normalized_text


def _write_holiday_file(holidays: list[str]) -> str:
    normalized = sorted(dict.fromkeys(holidays))
    raw_text = "\n".join(normalized)
    HOLIDAYS_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
    HOLIDAYS_FILE_PATH.write_text(raw_text + ("\n" if raw_text else ""), encoding="utf-8")
    return raw_text


BUSINESS_TRIP_TYPES = {"normal_trip", "day_trip"}
BUSINESS_TRIP_TYPE_ALIASES = {"previous_day": "day_trip"}


def _validate_business_trip_type(trip_type: str) -> str:
    normalized = (trip_type or "").strip()
    normalized = BUSINESS_TRIP_TYPE_ALIASES.get(normalized, normalized)
    if normalized not in BUSINESS_TRIP_TYPES:
        raise HTTPException(status_code=400, detail="type must be normal_trip or day_trip")
    return normalized


def _parse_business_trip_line(line: str) -> tuple[str, str]:
    normalized = line.strip()
    if "," not in normalized:
        raise HTTPException(status_code=400, detail="business trip line must be YYYY-MM-DD,type")
    date_part, type_part = normalized.split(",", 1)
    return _validate_holiday_date(date_part), _validate_business_trip_type(type_part)


def _parse_business_trip_lines(raw_text: str) -> list[dict[str, str]]:
    entries_by_date: dict[str, str] = {}

    for line in raw_text.splitlines():
        if not line.strip():
            continue
        date_str, trip_type = _parse_business_trip_line(line)
        entries_by_date[date_str] = trip_type

    return [
        {"date": date_str, "type": trip_type}
        for date_str, trip_type in sorted(entries_by_date.items())
    ]


def _format_business_trip_entries(entries: list[dict[str, str]]) -> str:
    return "\n".join(f"{entry['date']},{entry['type']}" for entry in entries)


def _load_business_trip_file() -> tuple[list[dict[str, str]], str]:
    BUSINESS_TRIPS_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not BUSINESS_TRIPS_FILE_PATH.exists():
        BUSINESS_TRIPS_FILE_PATH.write_text("", encoding="utf-8")

    raw_text = BUSINESS_TRIPS_FILE_PATH.read_text(encoding="utf-8")
    entries = _parse_business_trip_lines(raw_text)
    normalized_text = _format_business_trip_entries(entries)

    if raw_text != normalized_text and raw_text != normalized_text + "\n":
        BUSINESS_TRIPS_FILE_PATH.write_text(
            normalized_text + ("\n" if normalized_text else ""),
            encoding="utf-8",
        )

    return entries, normalized_text


def _write_business_trip_file(entries: list[dict[str, str]]) -> str:
    normalized_entries = _parse_business_trip_lines(_format_business_trip_entries(entries))
    raw_text = _format_business_trip_entries(normalized_entries)
    BUSINESS_TRIPS_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
    BUSINESS_TRIPS_FILE_PATH.write_text(raw_text + ("\n" if raw_text else ""), encoding="utf-8")
    return raw_text


@app.get("/api/holidays", response_model=HolidayListResponse)
def get_holidays():
    holidays, raw_text = _load_holiday_file()
    return {
        "holidays": holidays,
        "raw_text": raw_text,
        "file_path": str(HOLIDAYS_FILE_PATH),
    }


@app.post("/api/holidays", response_model=HolidayListResponse)
def add_holiday(request: HolidayCreateRequest):
    new_date = _validate_holiday_date(request.date)
    holidays, _raw_text = _load_holiday_file()

    if new_date not in holidays:
        holidays.append(new_date)

    raw_text = _write_holiday_file(holidays)
    return {
        "holidays": sorted(dict.fromkeys(holidays)),
        "raw_text": raw_text,
        "file_path": str(HOLIDAYS_FILE_PATH),
    }


@app.delete("/api/holidays/{date}", response_model=HolidayListResponse)
def delete_holiday(date: str):
    target_date = _validate_holiday_date(date)
    holidays, _raw_text = _load_holiday_file()

    holidays = [h for h in holidays if h != target_date]
    raw_text = _write_holiday_file(holidays)
    return {
        "holidays": sorted(dict.fromkeys(holidays)),
        "raw_text": raw_text,
        "file_path": str(HOLIDAYS_FILE_PATH),
    }


@app.put("/api/holidays/raw", response_model=HolidayListResponse)
def update_holidays_raw(request: HolidayRawUpdateRequest):
    holidays = _parse_holiday_lines(request.raw_text or "")
    raw_text = _write_holiday_file(holidays)
    return {
        "holidays": holidays,
        "raw_text": raw_text,
        "file_path": str(HOLIDAYS_FILE_PATH),
    }


@app.get("/api/business-trips", response_model=BusinessTripListResponse)
def get_business_trips():
    entries, raw_text = _load_business_trip_file()
    return {
        "business_trips": entries,
        "raw_text": raw_text,
        "file_path": str(BUSINESS_TRIPS_FILE_PATH),
    }


@app.post("/api/business-trips", response_model=BusinessTripListResponse)
def add_business_trip(request: BusinessTripCreateRequest):
    new_date = _validate_holiday_date(request.date)
    new_type = _validate_business_trip_type(request.type)
    entries, _raw_text = _load_business_trip_file()

    entries_by_date = {entry["date"]: entry["type"] for entry in entries}
    entries_by_date[new_date] = new_type
    next_entries = [
        {"date": date_str, "type": trip_type}
        for date_str, trip_type in entries_by_date.items()
    ]

    raw_text = _write_business_trip_file(next_entries)
    return {
        "business_trips": _parse_business_trip_lines(raw_text),
        "raw_text": raw_text,
        "file_path": str(BUSINESS_TRIPS_FILE_PATH),
    }


@app.put("/api/business-trips/raw", response_model=BusinessTripListResponse)
def update_business_trips_raw(request: BusinessTripRawUpdateRequest):
    entries = _parse_business_trip_lines(request.raw_text or "")
    raw_text = _write_business_trip_file(entries)
    return {
        "business_trips": entries,
        "raw_text": raw_text,
        "file_path": str(BUSINESS_TRIPS_FILE_PATH),
    }


@app.get("/api/synonyms", response_model=SynonymGroupsResponse)
async def get_synonyms():
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(SYNONYM_API_URL)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="failed to fetch synonyms") from exc

    payload = response.json()
    groups = payload.get("groups", [])
    if not isinstance(groups, list):
        raise HTTPException(status_code=502, detail="invalid synonyms payload")

    normalized_groups: list[list[str]] = []
    for group in groups:
        if not isinstance(group, list):
            continue
        normalized_group = [
            str(word).strip()
            for word in group
            if str(word).strip()
        ]
        if normalized_group:
            normalized_groups.append(normalized_group)

    return {"groups": normalized_groups}


# Serve Frontend (SPA)
# Place this at the end to ensure API routes take precedence
frontend_dist = os.path.join(os.path.dirname(__file__), "../frontend/dist")

if os.path.isdir(frontend_dist):
    app.mount("/assets", StaticFiles(directory=os.path.join(frontend_dist, "assets")), name="assets")


TASK_CSV_HEADERS = [
    "id", "text", "start_date", "end_date", "duration", "progress",
    "parent", "kind_task", "ToDo", "task_schedule", "folder",
    "url_adress", "mail", "memo", "hyperlink", "color", "textColor",
    "owner_id", "sortorder", "edit_date", "is_pinned"
]

LINK_CSV_HEADERS = ["id", "source", "target", "type"]

TASK_DIFF_FIELDS = [field for field in TASK_CSV_HEADERS if field != "id"]
LINK_DIFF_FIELDS = [field for field in LINK_CSV_HEADERS if field != "id"]

SUMMARY_JSON_FILENAME = "gantt_diff_summary.json"
SUMMARY_MARKDOWN_FILENAME = "gantt_diff_summary.md"
TASK_CSV_FILENAME = "gantt_tasks.csv"
LINK_CSV_FILENAME = "gantt_links.csv"
HOLIDAY_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
HOLIDAYS_FILE_PATH = Path(__file__).resolve().parent / "data" / "holidays.txt"
BUSINESS_TRIPS_FILE_PATH = Path(__file__).resolve().parent / "data" / "business_trips.txt"
SYNONYM_API_URL = os.getenv("SYNONYM_API_URL", "http://127.0.0.1:8079/api/index/synonyms")


def _normalize_diff_value(value):
    if value is None:
        return ""
    return str(value).replace("\r\n", "\n").replace("\r", "\n").strip()


def _normalize_csv_content(content: str | None) -> str:
    if content is None:
        return ""
    return content.replace("\r\n", "\n").replace("\r", "\n")


def _build_task_export_row(task: TaskModel) -> dict[str, str]:
    return {
        "id": str(task.id),
        "text": task.text,
        "start_date": task.start_date,
        "end_date": task.end_date,
        "duration": str(task.duration),
        "progress": str(task.progress),
        "parent": str(task.parent),
        "kind_task": str(task.kind_task),
        "ToDo": task.ToDo or "",
        "task_schedule": task.task_schedule or "",
        "folder": task.folder or "",
        "url_adress": task.url_adress or "",
        "mail": task.mail or "",
        "memo": task.memo or "",
        "hyperlink": task.hyperlink or "",
        "color": task.color or "",
        "textColor": task.textColor or "",
        "owner_id": str(task.owner_id),
        "sortorder": str(task.sortorder),
        "edit_date": task.edit_date or "",
        "is_pinned": "1" if task.is_pinned else "0",
    }


def _build_link_export_row(link: LinkModel) -> dict[str, str]:
    return {
        "id": str(link.id),
        "source": str(link.source),
        "target": str(link.target),
        "type": str(link.type),
    }


def _generate_export_contents(db: Session) -> tuple[str, str]:
    tasks = db.query(TaskModel).order_by(TaskModel.parent, TaskModel.sortorder).all()
    links = db.query(LinkModel).order_by(LinkModel.id).all()

    output_tasks = io.StringIO()
    writer_tasks = csv.writer(output_tasks)
    writer_tasks.writerow(TASK_CSV_HEADERS)
    for task in tasks:
        row = _build_task_export_row(task)
        writer_tasks.writerow([row[header] for header in TASK_CSV_HEADERS])
    content_tasks = "\ufeff" + output_tasks.getvalue()

    output_links = io.StringIO()
    writer_links = csv.writer(output_links)
    writer_links.writerow(LINK_CSV_HEADERS)
    for link in links:
        row = _build_link_export_row(link)
        writer_links.writerow([row[header] for header in LINK_CSV_HEADERS])
    content_links = "\ufeff" + output_links.getvalue()

    return content_tasks, content_links


def _parse_csv_rows(content: str, headers: list[str]) -> list[dict[str, str]]:
    clean_content = content.lstrip("\ufeff")
    reader = csv.DictReader(io.StringIO(clean_content))
    rows: list[dict[str, str]] = []
    for raw_row in reader:
        row = {header: raw_row.get(header, "") or "" for header in headers}
        if any(_normalize_diff_value(value) for value in row.values()):
            rows.append(row)
    return rows


def _summarize_rows(
    previous_rows: list[dict[str, str]],
    current_rows: list[dict[str, str]],
    compare_fields: list[str],
    label_builder,
) -> dict:
    previous_map = {str(row["id"]): row for row in previous_rows}
    current_map = {str(row["id"]): row for row in current_rows}

    added_examples = []
    deleted_examples = []
    modified_examples = []
    unchanged_count = 0

    for row_id, current_row in current_map.items():
        previous_row = previous_map.get(row_id)
        if previous_row is None:
            added_examples.append({
                "id": row_id,
                "label": label_builder(current_row),
                "changed_fields": [],
            })
            continue

        changed_fields = [
            field
            for field in compare_fields
            if _normalize_diff_value(previous_row.get(field)) != _normalize_diff_value(current_row.get(field))
        ]
        if changed_fields:
            modified_examples.append({
                "id": row_id,
                "label": label_builder(current_row),
                "changed_fields": changed_fields,
            })
        else:
            unchanged_count += 1

    for row_id, previous_row in previous_map.items():
        if row_id not in current_map:
            deleted_examples.append({
                "id": row_id,
                "label": label_builder(previous_row),
                "changed_fields": [],
            })

    return {
        "added_count": len(added_examples),
        "deleted_count": len(deleted_examples),
        "modified_count": len(modified_examples),
        "unchanged_count": unchanged_count,
        "added_examples": added_examples,
        "deleted_examples": deleted_examples,
        "modified_examples": modified_examples,
    }


def _build_summary_markdown(summary: dict) -> str:
    def build_section(title: str, section: dict) -> list[str]:
        lines = [
            f"## {title}",
            f"- 追加: {section['added_count']}",
            f"- 削除: {section['deleted_count']}",
            f"- 変更: {section['modified_count']}",
            f"- 変更なし: {section['unchanged_count']}",
        ]

        for key, label in (
            ("added_examples", "追加"),
            ("deleted_examples", "削除"),
            ("modified_examples", "変更"),
        ):
            examples = section.get(key) or []
            if not examples:
                continue
            lines.append(f"### {label}")
            for example in examples:
                changed_fields = example.get("changed_fields") or []
                suffix = f" ({', '.join(changed_fields)})" if changed_fields else ""
                lines.append(f"- [{example['id']}] {example['label']}{suffix}")
        lines.append("")
        return lines

    lines = [
        "# Gantt CSV 差分サマリ",
        f"- ステータス: {summary['status']}",
        f"- チェック時刻: {summary['checked_at']}",
        f"- 保存時刻: {summary.get('saved_at') or '-'}",
        f"- 保存先: {summary['output_dir']}",
        "",
    ]
    lines.extend(build_section("Tasks", summary["tasks"]))
    lines.extend(build_section("Links", summary["links"]))
    return "\n".join(lines).rstrip() + "\n"


def _build_summary_markdown_entry(summary: dict) -> str:
    body = _build_summary_markdown(summary).strip()
    return f"## {summary['checked_at']} ({summary['status']})\n\n{body}\n"


def _extract_summary_entry(summary: dict) -> dict | None:
    if not summary or not summary.get("exists"):
        return None

    required_keys = (
        "exists",
        "status",
        "checked_at",
        "saved_at",
        "output_dir",
        "task_csv_path",
        "link_csv_path",
        "summary_json_path",
        "summary_markdown_path",
        "tasks",
        "links",
    )
    if any(key not in summary for key in required_keys):
        return None

    return {key: summary[key] for key in required_keys}


def _load_summary_history(summary: dict | None) -> list[dict]:
    if not summary:
        return []

    history = summary.get("history")
    if isinstance(history, list):
        entries = [entry for entry in (_extract_summary_entry(item) for item in history) if entry]
        if entries:
            return entries

    legacy_entry = _extract_summary_entry(summary)
    return [legacy_entry] if legacy_entry else []


def _load_existing_summary(summary_path: Path) -> dict | None:
    if not summary_path.exists():
        return None
    try:
        return json.loads(summary_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _write_text_without_newline_translation(path: Path, content: str) -> None:
    with path.open("w", encoding="utf-8", newline="") as f:
        f.write(content)


def _build_output_paths(obsidian_home: str) -> dict[str, Path]:
    output_dir = Path(obsidian_home).expanduser() / "70_gantt_csv"
    return {
        "output_dir": output_dir,
        "task_csv_path": output_dir / TASK_CSV_FILENAME,
        "link_csv_path": output_dir / LINK_CSV_FILENAME,
        "summary_json_path": output_dir / SUMMARY_JSON_FILENAME,
        "summary_markdown_path": output_dir / SUMMARY_MARKDOWN_FILENAME,
    }



@app.get("/api/export/csv")
def export_csv():
    """Export tasks and links as CSV files (zipped)."""
    db = SessionLocal()
    try:
        content_tasks, content_links = _generate_export_contents(db)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        
        # Create ZIP buffer
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
            zip_file.writestr(f"gantt_tasks_{timestamp}.csv", content_tasks.encode("utf-8"))
            zip_file.writestr(f"gantt_links_{timestamp}.csv", content_links.encode("utf-8"))

        filename = f"gantt_data_{timestamp}.zip"

        return StreamingResponse(
            iter([zip_buffer.getvalue()]),
            media_type="application/zip",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )
    finally:
        db.close()


@app.post("/api/obsidian/export-sync", response_model=ObsidianCsvSyncSummary)
def sync_obsidian_csv_export(
    obsidian_home: str,
    db: Session = Depends(get_db),
):
    obsidian_home = (obsidian_home or "").strip()
    if not obsidian_home:
        raise HTTPException(status_code=400, detail="obsidian_home is required")

    paths = _build_output_paths(obsidian_home)
    output_dir = paths["output_dir"]
    output_dir.mkdir(parents=True, exist_ok=True)

    current_tasks_content, current_links_content = _generate_export_contents(db)

    previous_tasks_content = (
        paths["task_csv_path"].read_text(encoding="utf-8")
        if paths["task_csv_path"].exists() else None
    )
    previous_links_content = (
        paths["link_csv_path"].read_text(encoding="utf-8")
        if paths["link_csv_path"].exists() else None
    )
    existing_summary = _load_existing_summary(paths["summary_json_path"])

    has_previous_snapshot = previous_tasks_content is not None and previous_links_content is not None
    has_diff = (
        not has_previous_snapshot
        or _normalize_csv_content(previous_tasks_content) != _normalize_csv_content(current_tasks_content)
        or _normalize_csv_content(previous_links_content) != _normalize_csv_content(current_links_content)
    )

    previous_task_rows = _parse_csv_rows(previous_tasks_content or "", TASK_CSV_HEADERS)
    current_task_rows = _parse_csv_rows(current_tasks_content, TASK_CSV_HEADERS)
    previous_link_rows = _parse_csv_rows(previous_links_content or "", LINK_CSV_HEADERS)
    current_link_rows = _parse_csv_rows(current_links_content, LINK_CSV_HEADERS)

    checked_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if not has_previous_snapshot:
        status = "initial_save"
        saved_at = checked_at
    elif has_diff:
        status = "updated"
        saved_at = checked_at
    else:
        status = "unchanged"
        saved_at = existing_summary.get("saved_at") if existing_summary else None

    summary = {
        "exists": True,
        "status": status,
        "checked_at": checked_at,
        "saved_at": saved_at,
        "output_dir": str(output_dir),
        "task_csv_path": str(paths["task_csv_path"]),
        "link_csv_path": str(paths["link_csv_path"]),
        "summary_json_path": str(paths["summary_json_path"]),
        "summary_markdown_path": str(paths["summary_markdown_path"]),
        "tasks": _summarize_rows(
            previous_task_rows,
            current_task_rows,
            TASK_DIFF_FIELDS,
            lambda row: row.get("text", "") or f"Task {row.get('id', '')}",
        ),
        "links": _summarize_rows(
            previous_link_rows,
            current_link_rows,
            LINK_DIFF_FIELDS,
            lambda row: f"{row.get('source', '')} -> {row.get('target', '')} (type={row.get('type', '')})",
        ),
    }
    existing_history = _load_summary_history(existing_summary)
    summary["history"] = existing_history

    if has_diff:
        summary["history"] = [_extract_summary_entry(summary), *existing_history]
        _write_text_without_newline_translation(paths["task_csv_path"], current_tasks_content)
        _write_text_without_newline_translation(paths["link_csv_path"], current_links_content)
        paths["summary_json_path"].write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        markdown_entry = _build_summary_markdown_entry(summary)
        if paths["summary_markdown_path"].exists():
            existing_markdown = paths["summary_markdown_path"].read_text(encoding="utf-8")
            separator = "\n\n---\n\n" if existing_markdown.strip() else ""
            paths["summary_markdown_path"].write_text(
                f"{markdown_entry.rstrip()}{separator}{existing_markdown}" if existing_markdown.strip() else markdown_entry,
                encoding="utf-8",
            )
        else:
            paths["summary_markdown_path"].write_text(markdown_entry, encoding="utf-8")

    return summary


@app.get("/api/obsidian/export-sync-summary", response_model=ObsidianCsvSyncSummary | ObsidianCsvSummaryNotFound)
def get_obsidian_csv_sync_summary(obsidian_home: str):
    obsidian_home = (obsidian_home or "").strip()
    if not obsidian_home:
        raise HTTPException(status_code=400, detail="obsidian_home is required")

    paths = _build_output_paths(obsidian_home)
    summary = _load_existing_summary(paths["summary_json_path"])
    if summary is None:
        return {
            "exists": False,
            "output_dir": str(paths["output_dir"]),
            "summary_json_path": str(paths["summary_json_path"]),
            "summary_markdown_path": str(paths["summary_markdown_path"]),
        }
    return summary


@app.post("/api/import/csv", response_model=ImportResponse)
async def import_csv(file: UploadFile = File(...)):
    """Import tasks and links from a ZIP file or single CSV file."""
    db = SessionLocal()
    try:
        content = await file.read()
        
        tasks_csv_content = ""
        links_csv_content = ""

        # Try to parse as ZIP
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as z:
                for name in z.namelist():
                    if "task" in name.lower() and name.endswith(".csv"):
                        tasks_csv_content = z.read(name).decode("utf-8-sig", errors="replace")
                    elif "link" in name.lower() and name.endswith(".csv"):
                        links_csv_content = z.read(name).decode("utf-8-sig", errors="replace")
        except zipfile.BadZipFile:
            # It's a single CSV file, assume it's tasks
            try:
                tasks_csv_content = content.decode("utf-8-sig")
            except UnicodeDecodeError:
                tasks_csv_content = content.decode("utf-8")

        imported_count = 0
        skipped_count = 0
        errors: List[str] = []

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # CSVの種類ごとに置換対象を分ける。
        # tasks.csv 単体の読み込みで links を消さないようにする。
        if tasks_csv_content:
            db.query(TaskModel).delete()
            db.commit()
        if links_csv_content:
            db.query(LinkModel).delete()
            db.commit()

        # Parse Tasks
        if tasks_csv_content:
            reader = csv.DictReader(io.StringIO(tasks_csv_content))
            for row_num, row in enumerate(reader, start=2):
                if not row.get("text") and not row.get("id"):
                    continue
                try:
                    # テキスト先頭の不要なインデントやアイコンを除去
                    raw_text = row.get("text", "")
                    cleaned_text = re.sub(r'^[\s\u3000📁📄📅🔍📝📌]+', '', raw_text)

                    task = TaskModel(
                        id=int(row.get("id", 0)),
                        text=cleaned_text,
                        start_date=row.get("start_date", now),
                        end_date=row.get("end_date", now),
                        duration=int(row.get("duration", 1)) if row.get("duration") else 1,
                        progress=float(row.get("progress", 0)) if row.get("progress") else 0.0,
                        parent=int(row.get("parent", 0)) if row.get("parent") else 0,
                        kind_task=int(row.get("kind_task", 1)) if row.get("kind_task") else 1,
                        owner_id=int(row.get("owner_id", 0)) if row.get("owner_id") else 0,
                        sortorder=int(row.get("sortorder", 0)) if row.get("sortorder") else 0,
                        color=row.get("color") or None,
                        textColor=row.get("textColor") or None,
                        ToDo=row.get("ToDo") or None,
                        task_schedule=row.get("task_schedule") or None,
                        folder=row.get("folder") or None,
                        url_adress=row.get("url_adress") or None,
                        mail=row.get("mail") or None,
                        memo=row.get("memo") or None,
                        hyperlink=row.get("hyperlink") or None,
                        edit_date=row.get("edit_date") or None,
                        is_pinned=1 if row.get("is_pinned", "").strip() in {"1", "true", "True"} else 0,
                        created_at=now,
                        updated_at=now,
                    )
                    db.add(task)
                    imported_count += 1
                except Exception as e:
                    errors.append(f"Task 行 {row_num}: {str(e)}")
                    skipped_count += 1

        # Parse Links
        if links_csv_content:
            reader = csv.DictReader(io.StringIO(links_csv_content))
            for row_num, row in enumerate(reader, start=2):
                if not row.get("source") or not row.get("target"):
                    continue
                try:
                    link = LinkModel(
                        id=int(row.get("id", 0)) if row.get("id") else None,
                        source=int(row.get("source", 0)),
                        target=int(row.get("target", 0)),
                        type=int(row.get("type", 0)) if row.get("type") else 0,
                    )
                    db.add(link)
                    imported_count += 1
                except Exception as e:
                    errors.append(f"Link 行 {row_num}: {str(e)}")
                    skipped_count += 1

        db.commit()
        increment_gantt_update_sequence()

        return ImportResponse(
            imported_count=imported_count,
            skipped_count=skipped_count,
            errors=errors,
        )
    finally:
        db.close()

if os.path.isdir(frontend_dist):
    def build_static_cache_headers(path: Path) -> dict[str, str]:
        """配信ファイル種別ごとに適切なキャッシュヘッダーを返す。"""
        if path.name in {"index.html", "sw.js", "manifest.webmanifest", "manifest.json"}:
            return {"Cache-Control": "no-cache, no-store, must-revalidate"}

        if HASHED_ASSET_PATTERN.fullmatch(path.name):
            return {"Cache-Control": "public, max-age=31536000, immutable"}

        return {"Cache-Control": "public, max-age=3600"}

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        # Check if file exists in dist (e.g. vite.svg, favicon.ico)
        file_path = os.path.join(frontend_dist, full_path)
        if os.path.isfile(file_path):
            headers = build_static_cache_headers(Path(file_path))
            # Service WorkerとmanifestのMIMEタイプを正しく設定（PWA対応）
            if full_path.endswith('.webmanifest'):
                return FileResponse(file_path, media_type='application/manifest+json', headers=headers)
            if full_path.endswith('sw.js') or full_path.startswith('workbox-'):
                return FileResponse(file_path, media_type='application/javascript',
                                    headers={**headers, 'Service-Worker-Allowed': '/'})
            return FileResponse(file_path, headers=headers)
        # Fallback to index.html for SPA routing
        index_path = Path(frontend_dist) / "index.html"
        return FileResponse(index_path, headers=build_static_cache_headers(index_path))

@app.get("/")
async def serve_root():
    if os.path.isdir(frontend_dist):
        index_path = Path(frontend_dist) / "index.html"
        return FileResponse(index_path, headers=build_static_cache_headers(index_path))
    return {"message": "Gantt Chart API (Frontend not found)"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
