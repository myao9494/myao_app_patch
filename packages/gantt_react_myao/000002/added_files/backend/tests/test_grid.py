"""
グリッド編集API（/api/grid）のテスト。
ステージング（grid_tasks / grid_links）への編集、差分取得、元に戻す、本テーブルへの反映を検証する。
"""
import pytest

import database
from models import Link as LinkModel
from models import Task as TaskModel

TASK_ID = 4
LINK_ID = 7


@pytest.fixture(autouse=True)
def staged_grid(client, db):
    """本テーブルにタスク1件・リンク1件を用意し、ステージングを初期化する。"""
    db.add_all([
        TaskModel(
            id=TASK_ID,
            text="Original Task",
            start_date="2024-03-01 00:00:00",
            end_date="2024-03-02 00:00:00",
            duration=1,
            progress=0.0,
            parent=0,
            kind_task=1,
            owner_id=0,
            sortorder=0,
        ),
        LinkModel(id=LINK_ID, source=1, target=2, type=0),
    ])
    db.commit()
    assert client.post("/api/grid/init").json() == {"status": "ok", "tasks_count": 1, "links_count": 1}


def diffs(client) -> list[dict]:
    return client.get("/api/grid/diff").json()["diffs"]


def diff_fields(client) -> dict[str, tuple]:
    return {diff["field"]: (diff["original"], diff["current"]) for diff in diffs(client)}


def test_no_diff_right_after_init(client):
    assert diffs(client) == []


def test_editing_staging_does_not_change_main_table(client):
    client.put(f"/api/grid/tasks/{TASK_ID}", json={"text": "Edited"})

    assert client.get(f"/api/tasks/{TASK_ID}").json()["text"] == "Original Task"
    assert diffs(client) == [{
        "id": TASK_ID, "table": "tasks", "field": "text",
        "original": "Original Task", "current": "Edited",
    }]


def test_null_values_for_required_columns_are_ignored(client):
    """グリッドで必須セルを空にしても（null が送られても）エラーにせず、元の値を保つ。"""
    response = client.put(f"/api/grid/tasks/{TASK_ID}", json={
        "text": None,
        "start_date": None,
        "end_date": None,
        "duration": None,
        "memo": None,
    })

    assert response.status_code == 200
    assert "text" not in diff_fields(client)
    assert "start_date" not in diff_fields(client)
    assert "end_date" not in diff_fields(client)


def test_staged_text_is_sanitized(client):
    client.put(f"/api/grid/tasks/{TASK_ID}", json={"text": "　📄 Edited"})

    assert diff_fields(client)["text"] == ("Original Task", "Edited")


def test_changing_end_date_recalculates_duration(client):
    client.put(f"/api/grid/tasks/{TASK_ID}", json={"end_date": "2024-03-06 00:00:00"})

    fields = diff_fields(client)
    assert fields["end_date"] == ("2024-03-02 00:00:00", "2024-03-06 00:00:00")
    assert fields["duration"] == ("1", "5")


def test_changing_start_date_recalculates_duration(client):
    client.put(f"/api/grid/tasks/{TASK_ID}", json={"start_date": "2024-02-28"})

    assert diff_fields(client)["duration"] == ("1", "3")


def test_changing_only_duration_recalculates_end_date(client):
    client.put(f"/api/grid/tasks/{TASK_ID}", json={"duration": 10})

    fields = diff_fields(client)
    assert fields["duration"] == ("1", "10")
    assert fields["end_date"] == ("2024-03-02 00:00:00", "2024-03-11 00:00:00")


def test_updating_missing_staged_rows_returns_404(client):
    assert client.put("/api/grid/tasks/999", json={"text": "x"}).status_code == 404
    assert client.put("/api/grid/links/999", json={"source": 1}).status_code == 404


def test_link_edit_is_staged_and_ignores_unknown_keys(client):
    response = client.put(f"/api/grid/links/{LINK_ID}", json={"target": 5, "id": 99, "metadata": "x"})

    assert response.status_code == 200
    assert diffs(client) == [{
        "id": LINK_ID, "table": "links", "field": "target", "original": "2", "current": "5",
    }]


def test_revert_restores_single_field(client):
    client.put(f"/api/grid/tasks/{TASK_ID}", json={"text": "Edited", "memo": "note"})

    response = client.post("/api/grid/revert", json={"table": "tasks", "id": TASK_ID, "field": "text"})

    assert response.status_code == 200
    assert diff_fields(client) == {"memo": (None, "note")}


def test_revert_rejects_invalid_requests(client):
    assert client.post(
        "/api/grid/revert", json={"table": "unknown", "id": TASK_ID, "field": "text"}
    ).status_code == 400
    assert client.post(
        "/api/grid/revert", json={"table": "tasks", "id": TASK_ID, "field": "metadata"}
    ).status_code == 400
    assert client.post(
        "/api/grid/revert", json={"table": "tasks", "id": 999, "field": "text"}
    ).status_code == 404


def test_commit_applies_staged_changes_and_bumps_sequence(client):
    client.put(f"/api/grid/tasks/{TASK_ID}", json={"text": "Edited", "progress": 0.5})
    client.put(f"/api/grid/links/{LINK_ID}", json={"type": 2})

    response = client.post("/api/grid/commit")

    assert response.json() == {"updated_tasks": 1, "updated_links": 1, "errors": []}
    task = client.get(f"/api/tasks/{TASK_ID}").json()
    assert (task["text"], task["progress"]) == ("Edited", 0.5)
    assert client.get("/api/links").json()[0]["type"] == 2
    assert diffs(client) == []
    assert client.get("/api/tasks/update-sequence").json()["sequence"] == 1


def test_commit_without_diff_does_not_write_or_bump_sequence(client, monkeypatch):
    session_class = database.SessionLocal.class_
    original_commit = session_class.commit
    commit_calls = []

    def counting_commit(self):
        commit_calls.append(1)
        return original_commit(self)

    monkeypatch.setattr(session_class, "commit", counting_commit)

    response = client.post("/api/grid/commit")

    assert response.json() == {"updated_tasks": 0, "updated_links": 0, "errors": []}
    assert commit_calls == []
    assert client.get("/api/tasks/update-sequence").json()["sequence"] == 0


def test_init_discards_previous_staged_edits(client):
    client.put(f"/api/grid/tasks/{TASK_ID}", json={"text": "Edited"})

    client.post("/api/grid/init")

    assert diffs(client) == []
