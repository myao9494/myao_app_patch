"""
CSVエクスポート/インポートと、Obsidian VaultへのCSV定期保存のAPIルーター。
"""
import io
import zipfile
from datetime import datetime

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from database import get_db
from schemas import (
    ImportResponse,
    ObsidianCsvSummaryNotFound,
    ObsidianCsvSyncSummary,
)
from services import csv_io, obsidian_export, update_sequence

router = APIRouter(prefix="/api", tags=["csv"])


@router.get("/export/csv")
def export_csv(db: Session = Depends(get_db)):
    """Export tasks and links as CSV files (zipped)."""
    content_tasks, content_links = csv_io.generate_export_contents(db)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
        zip_file.writestr(f"gantt_tasks_{timestamp}.csv", content_tasks.encode("utf-8"))
        zip_file.writestr(f"gantt_links_{timestamp}.csv", content_links.encode("utf-8"))

    return Response(
        content=zip_buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=gantt_data_{timestamp}.zip"},
    )


@router.post("/import/csv", response_model=ImportResponse)
async def import_csv(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """
    Import tasks and links from a ZIP file or single CSV file.

    CSVの種類ごとに置換対象を分ける（tasks.csv 単体の読み込みでは links を消さない）。
    置換は1トランザクションで行い、失敗した場合は元のデータを残して 400 を返す。
    """
    try:
        tasks_csv, links_csv = csv_io.split_upload_content(await file.read())
    except csv_io.CsvDecodeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    parsed_tasks = csv_io.parse_task_csv(tasks_csv) if tasks_csv else None
    parsed_links = csv_io.parse_link_csv(links_csv) if links_csv else None

    try:
        csv_io.replace_tables(
            db,
            parsed_tasks.rows if parsed_tasks else None,
            parsed_links.rows if parsed_links else None,
        )
    except SQLAlchemyError as exc:
        detail = getattr(exc, "orig", exc)
        raise HTTPException(
            status_code=400,
            detail=f"インポートに失敗したため、データは変更していません: {detail}",
        ) from exc

    update_sequence.increment()

    parsed = [result for result in (parsed_tasks, parsed_links) if result]
    return ImportResponse(
        imported_count=sum(len(result.rows) for result in parsed),
        skipped_count=sum(len(result.errors) for result in parsed),
        errors=[error for result in parsed for error in result.errors],
    )


def _require_obsidian_home(obsidian_home: str) -> str:
    normalized = (obsidian_home or "").strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="obsidian_home is required")
    return normalized


@router.post("/obsidian/export-sync", response_model=ObsidianCsvSyncSummary)
def sync_obsidian_csv_export(obsidian_home: str, db: Session = Depends(get_db)):
    """現在のデータを {obsidian_home}/70_gantt_csv に保存し、前回との差分サマリを返す。"""
    return obsidian_export.sync_csv_export(db, _require_obsidian_home(obsidian_home))


@router.get(
    "/obsidian/export-sync-summary",
    response_model=ObsidianCsvSyncSummary | ObsidianCsvSummaryNotFound,
)
def get_obsidian_csv_sync_summary(obsidian_home: str):
    """最後に保存した差分サマリを返す。未保存の場合は exists=false を返す。"""
    paths = obsidian_export.build_output_paths(_require_obsidian_home(obsidian_home))
    summary = obsidian_export.load_existing_summary(paths["summary_json_path"])
    if summary is None:
        return {
            "exists": False,
            "output_dir": str(paths["output_dir"]),
            "summary_json_path": str(paths["summary_json_path"]),
            "summary_markdown_path": str(paths["summary_markdown_path"]),
        }
    return summary
