"""
CSVエクスポート/インポートAPI（/api/export/csv, /api/import/csv）のテスト。
"""
import io
import zipfile

import pytest

from models import Link as LinkModel
from models import Task as TaskModel

TASKS_CSV_HEADER = (
    "id,text,start_date,end_date,duration,progress,parent,kind_task,ToDo,task_schedule,"
    "folder,url_adress,mail,memo,hyperlink,color,textColor,owner_id,sortorder,edit_date,is_pinned\n"
)


def task_csv_row(task_id, text: str, **overrides) -> str:
    values = {
        "id": task_id, "text": text,
        "start_date": "2026-03-10 00:00:00", "end_date": "2026-03-11 00:00:00",
        "duration": 1, "progress": 0, "parent": 0, "kind_task": 1,
        "ToDo": "", "task_schedule": "", "folder": "", "url_adress": "", "mail": "",
        "memo": "", "hyperlink": "", "color": "", "textColor": "",
        "owner_id": 0, "sortorder": 0, "edit_date": "", "is_pinned": 0,
        **overrides,
    }
    return ",".join(str(value) for value in values.values()) + "\n"


def make_zip(files: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for name, content in files.items():
            zip_file.writestr(name, content)
    return buffer.getvalue()


def upload(client, filename: str, content: bytes):
    return client.post("/api/import/csv", files={"file": (filename, content, "application/octet-stream")})


@pytest.fixture(autouse=True)
def existing_data(db):
    common = {"duration": 1, "progress": 0.0, "parent": 0, "kind_task": 1, "owner_id": 0}
    db.add_all([
        TaskModel(id=1, text="Task 1", start_date="2026-03-01 00:00:00", end_date="2026-03-02 00:00:00",
                  sortorder=0, **common),
        TaskModel(id=2, text="Task 2", start_date="2026-03-03 00:00:00", end_date="2026-03-04 00:00:00",
                  sortorder=1, **common),
        LinkModel(id=1, source=1, target=2, type=0),
    ])
    db.commit()


def task_texts(client) -> list[str]:
    tasks = client.get("/api/tasks").json()["tasks"]
    return [task["text"] for task in sorted(tasks, key=lambda task: task["id"])]


# --- インポート ---

def test_import_tasks_csv_replaces_tasks_and_preserves_links(client):
    csv_content = TASKS_CSV_HEADER + task_csv_row(1, "Updated Task 1") + task_csv_row(3, "New Task 3")

    response = upload(client, "tasks.csv", csv_content.encode("utf-8"))

    assert response.status_code == 200
    assert response.json() == {"imported_count": 2, "skipped_count": 0, "errors": []}
    assert task_texts(client) == ["Updated Task 1", "New Task 3"]
    links = client.get("/api/links").json()
    assert [(link["id"], link["source"], link["target"]) for link in links] == [(1, 1, 2)]


def test_import_accepts_bom_and_converts_field_types(client):
    csv_content = "﻿" + TASKS_CSV_HEADER + task_csv_row(
        5, "　📁 Project", kind_task=2, progress=0.5, is_pinned=1, memo="note", duration="",
    )

    upload(client, "tasks.csv", csv_content.encode("utf-8"))

    task = client.get("/api/tasks/5").json()
    assert task["text"] == "Project"
    assert task["kind_task"] == 2
    assert task["progress"] == 0.5
    assert task["is_pinned"] is True
    assert task["memo"] == "note"
    assert task["hyperlink"] is None
    assert task["duration"] == 1


def test_import_zip_replaces_both_tasks_and_links(client):
    zip_content = make_zip({
        "gantt_tasks_20260101.csv": TASKS_CSV_HEADER + task_csv_row(1, "Updated Task 1"),
        "gantt_links_20260101.csv": "id,source,target,type\n2,2,1,0\n",
    })

    response = upload(client, "gantt_data.zip", zip_content)

    assert response.json()["imported_count"] == 2
    assert task_texts(client) == ["Updated Task 1"]
    assert client.get("/api/links").json() == [{"id": 2, "source": 2, "target": 1, "type": 0}]


def test_import_skips_unparseable_rows_and_reports_them(client):
    csv_content = (
        TASKS_CSV_HEADER
        + task_csv_row(1, "Good")
        + task_csv_row("abc", "Bad id")
        + task_csv_row(3, "Bad duration", duration="x")
    )

    response = upload(client, "tasks.csv", csv_content.encode("utf-8"))

    body = response.json()
    assert body["imported_count"] == 1
    assert body["skipped_count"] == 2
    assert body["errors"][0].startswith("Task 行 3:")
    assert body["errors"][1].startswith("Task 行 4:")
    assert task_texts(client) == ["Good"]


def test_failed_import_keeps_existing_data(client):
    """IDが重複するCSVは保存に失敗するが、既存データは消えずに残る。"""
    csv_content = TASKS_CSV_HEADER + task_csv_row(10, "Dup A") + task_csv_row(10, "Dup B")

    response = upload(client, "tasks.csv", csv_content.encode("utf-8"))

    assert response.status_code == 400
    assert "データは変更していません" in response.json()["detail"]
    assert task_texts(client) == ["Task 1", "Task 2"]
    assert len(client.get("/api/links").json()) == 1
    assert client.get("/api/tasks/update-sequence").json()["sequence"] == 0


def test_import_rejects_non_utf8_csv_without_touching_data(client):
    response = upload(client, "tasks.csv", "id,text\n1,タスク\n".encode("cp932"))

    assert response.status_code == 400
    assert task_texts(client) == ["Task 1", "Task 2"]


def test_import_rejects_non_utf8_csv_inside_zip_without_touching_data(client):
    """ZIP内のCSVも単体CSVと同様に、UTF-8でなければ文字化けしたまま取り込まず拒否する。"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zip_file:
        zip_file.writestr("gantt_tasks.csv", "id,text\n1,タスク\n".encode("cp932"))

    response = upload(client, "gantt_data.zip", buffer.getvalue())

    assert response.status_code == 400
    assert task_texts(client) == ["Task 1", "Task 2"]


def test_import_fills_blank_dates_with_current_time(client, db):
    csv_content = TASKS_CSV_HEADER + task_csv_row(5, "No dates", start_date="", end_date="")

    upload(client, "tasks.csv", csv_content.encode("utf-8"))

    task = db.get(TaskModel, 5)
    assert task.start_date and task.end_date


def test_successful_import_increments_sequence(client):
    upload(client, "tasks.csv", (TASKS_CSV_HEADER + task_csv_row(1, "A")).encode("utf-8"))

    assert client.get("/api/tasks/update-sequence").json()["sequence"] == 1


# --- エクスポート ---

def test_export_returns_zip_with_tasks_and_links_csv(client):
    response = client.get("/api/export/csv")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert "gantt_data_" in response.headers["content-disposition"]

    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = sorted(archive.namelist())
        assert [name.split("_")[1] for name in names] == ["links", "tasks"]
        tasks_csv = archive.read(names[1]).decode("utf-8")
        links_csv = archive.read(names[0]).decode("utf-8")

    assert tasks_csv.startswith("﻿" + TASKS_CSV_HEADER.strip())
    assert "1,Task 1,2026-03-01 00:00:00,2026-03-02 00:00:00" in tasks_csv
    assert links_csv.replace("\r\n", "\n") == "﻿id,source,target,type\n1,1,2,0\n"


def test_exported_zip_can_be_imported_back_unchanged(client, db):
    task = db.get(TaskModel, 1)
    task.memo = "複数行\nメモ, カンマ入り"
    task.is_pinned = 1
    db.commit()
    before = client.get("/api/tasks").json()

    exported = client.get("/api/export/csv").content
    response = upload(client, "gantt_data.zip", exported)

    assert response.json() == {"imported_count": 3, "skipped_count": 0, "errors": []}
    after = client.get("/api/tasks").json()
    ignore = {"created_at", "updated_at"}
    assert [{k: v for k, v in task.items() if k not in ignore} for task in after["tasks"]] == [
        {k: v for k, v in task.items() if k not in ignore} for task in before["tasks"]
    ]
    assert after["links"] == before["links"]


def test_export_writes_unset_values_as_blank_cells(client, db):
    db.add(TaskModel(id=9, text="Sparse", start_date="2026-03-01 00:00:00", end_date="2026-03-02 00:00:00",
                     duration=None, progress=None, parent=None, kind_task=None, owner_id=None, sortorder=None))
    db.commit()

    with zipfile.ZipFile(io.BytesIO(client.get("/api/export/csv").content)) as archive:
        tasks_name = next(name for name in archive.namelist() if "tasks" in name)
        tasks_csv = archive.read(tasks_name).decode("utf-8")

    assert "None" not in tasks_csv
