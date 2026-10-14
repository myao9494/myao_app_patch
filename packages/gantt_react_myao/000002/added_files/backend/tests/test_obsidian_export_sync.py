"""
Obsidian VaultへのCSV定期保存API（/api/obsidian/export-sync, export-sync-summary）のテスト。
"""
import json
from pathlib import Path

import pytest

from models import Link as LinkModel
from models import Task as TaskModel


def make_task(task_id: int, text: str) -> TaskModel:
    return TaskModel(
        id=task_id,
        text=text,
        start_date="2026-03-21 00:00:00",
        end_date="2026-03-22 00:00:00",
        duration=1,
        progress=0,
        parent=0,
        kind_task=1,
        owner_id=0,
        sortorder=task_id,
    )


@pytest.fixture
def vault(tmp_path) -> Path:
    home = tmp_path / "vault"
    home.mkdir()
    return home


@pytest.fixture
def output_dir(vault) -> Path:
    return vault / "70_gantt_csv"


@pytest.fixture(autouse=True)
def existing_data(db):
    db.add_all([make_task(1, "Task A"), LinkModel(id=1, source=1, target=2, type=0)])
    db.commit()


@pytest.fixture
def sync(client, vault):
    def _sync() -> dict:
        response = client.post("/api/obsidian/export-sync", params={"obsidian_home": str(vault)})
        assert response.status_code == 200, response.text
        return response.json()
    return _sync


def rename_task(db, task_id: int, text: str) -> None:
    db.get(TaskModel, task_id).text = text
    db.commit()


def test_first_sync_saves_csv_files_and_summary(sync, output_dir):
    data = sync()

    assert data["status"] == "initial_save"
    assert len(data["history"]) == 1
    assert data["tasks"]["added_count"] == 1
    assert data["links"]["added_count"] == 1
    assert sorted(path.name for path in output_dir.iterdir()) == [
        "gantt_diff_summary.json",
        "gantt_diff_summary.md",
        "gantt_links.csv",
        "gantt_tasks.csv",
    ]


def test_saved_csv_keeps_generated_line_endings(sync, output_dir):
    """Windowsでも改行コードが二重変換されないよう、生成した内容をそのまま書き込む。"""
    sync()

    raw = (output_dir / "gantt_links.csv").read_bytes()
    assert raw == "﻿id,source,target,type\r\n1,1,2,0\r\n".encode("utf-8")


def test_sync_without_changes_does_not_rewrite_files(sync, output_dir):
    first = sync()
    files_before = {path.name: path.read_bytes() for path in output_dir.iterdir()}

    second = sync()

    assert second["status"] == "unchanged"
    assert second["saved_at"] == first["saved_at"]
    assert second["tasks"]["added_count"] == 0
    assert second["tasks"]["modified_count"] == 0
    assert [entry["status"] for entry in second["history"]] == ["initial_save"]
    assert {path.name: path.read_bytes() for path in output_dir.iterdir()} == files_before


def test_sync_after_change_reports_modified_rows_and_prepends_history(sync, db, client, vault):
    sync()
    rename_task(db, 1, "Task A updated")

    data = sync()

    assert data["status"] == "updated"
    assert data["tasks"]["modified_count"] == 1
    assert data["tasks"]["modified_examples"][0] == {
        "id": "1", "label": "Task A updated", "changed_fields": ["text"],
    }
    assert [entry["status"] for entry in data["history"]] == ["updated", "initial_save"]

    summary = client.get("/api/obsidian/export-sync-summary", params={"obsidian_home": str(vault)})
    assert summary.json()["exists"] is True
    assert summary.json()["status"] == "updated"


def test_sync_reports_added_and_deleted_rows(sync, db):
    sync()
    db.delete(db.get(TaskModel, 1))
    db.add(make_task(2, "Task B"))
    db.commit()

    tasks = sync()["tasks"]

    assert [example["label"] for example in tasks["added_examples"]] == ["Task B"]
    assert [example["label"] for example in tasks["deleted_examples"]] == ["Task A"]


def test_history_is_kept_in_json_and_markdown_newest_first(sync, db, output_dir):
    sync()
    rename_task(db, 1, "Task A updated")
    sync()

    summary_json = json.loads((output_dir / "gantt_diff_summary.json").read_text(encoding="utf-8"))
    assert len(summary_json["history"]) == 2
    assert summary_json["history"][0]["tasks"]["modified_count"] == 1
    assert summary_json["history"][1]["tasks"]["added_count"] == 1

    summary_markdown = (output_dir / "gantt_diff_summary.md").read_text(encoding="utf-8")
    sections = summary_markdown.split("\n\n---\n\n")
    assert len(sections) == 2
    assert summary_markdown.count("# Gantt CSV 差分サマリ") == 2
    assert "Task A updated" in sections[0]
    assert "- [1] Task A\n" in sections[1]


def test_summary_lists_every_modified_row(sync, db, output_dir):
    db.add_all([make_task(task_id, f"Task {task_id}") for task_id in range(2, 27)])
    db.commit()
    sync()
    for task in db.query(TaskModel).all():
        task.text = f"{task.text} updated"
    db.commit()

    data = sync()

    assert data["tasks"]["modified_count"] == 26
    assert len(data["tasks"]["modified_examples"]) == 26
    assert data["tasks"]["modified_examples"][-1]["label"] == "Task 26 updated"

    latest_section = (output_dir / "gantt_diff_summary.md").read_text(encoding="utf-8").split("\n\n---\n\n")[0]
    assert "- [26] Task 26 updated (text)" in latest_section


def test_summary_endpoint_reports_missing_summary(client, vault, output_dir):
    response = client.get("/api/obsidian/export-sync-summary", params={"obsidian_home": str(vault)})

    assert response.status_code == 200
    assert response.json() == {
        "exists": False,
        "output_dir": str(output_dir),
        "summary_json_path": str(output_dir / "gantt_diff_summary.json"),
        "summary_markdown_path": str(output_dir / "gantt_diff_summary.md"),
    }


@pytest.mark.parametrize("method,url", [
    ("post", "/api/obsidian/export-sync"),
    ("get", "/api/obsidian/export-sync-summary"),
])
def test_blank_obsidian_home_is_rejected(client, method, url):
    response = client.request(method, url, params={"obsidian_home": "  "})

    assert response.status_code == 400
