"""
Obsidian Vault へのCSV定期保存（{obsidian_home}/70_gantt_csv/）。

現在のタスク・リンクをCSVに書き出し、前回保存分との差分サマリを
JSON（履歴つき）と Markdown（新しい順に追記）で残す。差分がなければファイルは書き換えない。
"""
import csv
import io
import json
from datetime import datetime
from pathlib import Path
from typing import Callable

from sqlalchemy.orm import Session

from config import OBSIDIAN_CSV_DIRNAME
from services.csv_io import (
    LINK_CSV_HEADERS,
    TASK_CSV_HEADERS,
    UTF8_BOM,
    generate_export_contents,
)

SUMMARY_JSON_FILENAME = "gantt_diff_summary.json"
SUMMARY_MARKDOWN_FILENAME = "gantt_diff_summary.md"
TASK_CSV_FILENAME = "gantt_tasks.csv"
LINK_CSV_FILENAME = "gantt_links.csv"

TASK_DIFF_FIELDS = [field for field in TASK_CSV_HEADERS if field != "id"]
LINK_DIFF_FIELDS = [field for field in LINK_CSV_HEADERS if field != "id"]

MARKDOWN_ENTRY_SEPARATOR = "\n\n---\n\n"
# 差分サマリの履歴として残す最大件数（これより古いものから捨てる）
MAX_HISTORY_ENTRIES = 200

# サマリ1回分（履歴の1要素）として保存するキー
SUMMARY_ENTRY_KEYS = (
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


def build_output_paths(obsidian_home: str) -> dict[str, Path]:
    output_dir = Path(obsidian_home).expanduser() / OBSIDIAN_CSV_DIRNAME
    return {
        "output_dir": output_dir,
        "task_csv_path": output_dir / TASK_CSV_FILENAME,
        "link_csv_path": output_dir / LINK_CSV_FILENAME,
        "summary_json_path": output_dir / SUMMARY_JSON_FILENAME,
        "summary_markdown_path": output_dir / SUMMARY_MARKDOWN_FILENAME,
    }


def load_existing_summary(summary_path: Path) -> dict | None:
    if not summary_path.exists():
        return None
    try:
        return json.loads(summary_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _normalize_newlines(content: str | None) -> str:
    if content is None:
        return ""
    return content.replace("\r\n", "\n").replace("\r", "\n")


def _normalize_diff_value(value) -> str:
    if value is None:
        return ""
    return _normalize_newlines(str(value)).strip()


def _parse_csv_rows(content: str, headers: list[str]) -> list[dict[str, str]]:
    reader = csv.DictReader(io.StringIO(content.lstrip(UTF8_BOM)))
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
    label_builder: Callable[[dict[str, str]], str],
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
    if any(key not in summary for key in SUMMARY_ENTRY_KEYS):
        return None
    return {key: summary[key] for key in SUMMARY_ENTRY_KEYS}


def _load_summary_history(summary: dict | None) -> list[dict]:
    if not summary:
        return []

    history = summary.get("history")
    if isinstance(history, list):
        entries = [entry for entry in (_extract_summary_entry(item) for item in history) if entry]
        if entries:
            return entries

    # history を持たない旧形式のサマリは、それ自体を1件の履歴として扱う
    legacy_entry = _extract_summary_entry(summary)
    return [legacy_entry] if legacy_entry else []


def _write_text_without_newline_translation(path: Path, content: str) -> None:
    """Windowsでの改行コード自動変換（CRLF化）を防いで書き込む。"""
    with path.open("w", encoding="utf-8", newline="") as f:
        f.write(content)


def _prepend_markdown_entry(path: Path, entry: str) -> None:
    # 既存の改行コードを変えないよう、読み書きとも改行変換をしない
    existing = ""
    if path.exists():
        with path.open("r", encoding="utf-8", newline="") as f:
            existing = f.read()
    if existing.strip():
        _write_text_without_newline_translation(
            path, f"{entry.rstrip()}{MARKDOWN_ENTRY_SEPARATOR}{existing}"
        )
    else:
        _write_text_without_newline_translation(path, entry)


def sync_csv_export(db: Session, obsidian_home: str) -> dict:
    """現在のデータをVaultへ保存し、前回保存分との差分サマリを返す。"""
    paths = build_output_paths(obsidian_home)
    output_dir = paths["output_dir"]
    output_dir.mkdir(parents=True, exist_ok=True)

    current_tasks_content, current_links_content = generate_export_contents(db)

    previous_tasks_content = (
        paths["task_csv_path"].read_text(encoding="utf-8")
        if paths["task_csv_path"].exists() else None
    )
    previous_links_content = (
        paths["link_csv_path"].read_text(encoding="utf-8")
        if paths["link_csv_path"].exists() else None
    )
    existing_summary = load_existing_summary(paths["summary_json_path"])

    has_previous_snapshot = previous_tasks_content is not None and previous_links_content is not None
    has_diff = (
        not has_previous_snapshot
        or _normalize_newlines(previous_tasks_content) != _normalize_newlines(current_tasks_content)
        or _normalize_newlines(previous_links_content) != _normalize_newlines(current_links_content)
    )

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
            _parse_csv_rows(previous_tasks_content or "", TASK_CSV_HEADERS),
            _parse_csv_rows(current_tasks_content, TASK_CSV_HEADERS),
            TASK_DIFF_FIELDS,
            lambda row: row.get("text", "") or f"Task {row.get('id', '')}",
        ),
        "links": _summarize_rows(
            _parse_csv_rows(previous_links_content or "", LINK_CSV_HEADERS),
            _parse_csv_rows(current_links_content, LINK_CSV_HEADERS),
            LINK_DIFF_FIELDS,
            lambda row: f"{row.get('source', '')} -> {row.get('target', '')} (type={row.get('type', '')})",
        ),
    }
    existing_history = _load_summary_history(existing_summary)
    summary["history"] = existing_history

    if has_diff:
        summary["history"] = [_extract_summary_entry(summary), *existing_history][:MAX_HISTORY_ENTRIES]
        _write_text_without_newline_translation(paths["task_csv_path"], current_tasks_content)
        _write_text_without_newline_translation(paths["link_csv_path"], current_links_content)
        paths["summary_json_path"].write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        _prepend_markdown_entry(paths["summary_markdown_path"], _build_summary_markdown_entry(summary))

    return summary
