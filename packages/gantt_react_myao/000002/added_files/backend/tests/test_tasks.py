"""
タスクAPI（/api/tasks）のテスト。
作成時の並び順、更新時の自動計算、再帰削除、再帰クローン、並び替え、更新シーケンスを検証する。
"""
from datetime import datetime

from models import Link as LinkModel
from models import Task as TaskModel


def children_of(client, parent_id: int) -> list[dict]:
    tasks = client.get("/api/tasks").json()["tasks"]
    return sorted(
        (task for task in tasks if task["parent"] == parent_id),
        key=lambda task: task["sortorder"],
    )


# --- 作成 ---

def test_create_task_appends_to_end_of_siblings_by_default(create_task):
    parent = create_task("Project", kind_task=2)
    first = create_task("Task 1", parent=parent["id"])
    second = create_task("Task 2", parent=parent["id"])

    assert first["sortorder"] == 0
    assert second["sortorder"] == 1


def test_create_task_appends_after_max_sortorder_even_with_gaps(create_task):
    """sortorder に欠番があっても、末尾追加は max(sortorder)+1 を使って重複を避ける。"""
    parent = create_task("Project", kind_task=2)
    create_task("Task 1", parent=parent["id"], sortorder=5)
    create_task("Task 2", parent=parent["id"], sortorder=10)

    appended = create_task("Task 3", parent=parent["id"])

    assert appended["sortorder"] == 11


def test_create_task_with_negative_sortorder_inserts_at_top(client, create_task):
    parent = create_task("Project", kind_task=2)
    create_task("Task 1", parent=parent["id"])
    create_task("Task 2", parent=parent["id"])

    create_task("Top", parent=parent["id"], sortorder=-1)

    assert [task["text"] for task in children_of(client, parent["id"])] == ["Top", "Task 1", "Task 2"]


def test_create_task_with_positive_sortorder_inserts_at_that_position(client, create_task):
    parent = create_task("Project", kind_task=2)
    create_task("Task 1", parent=parent["id"])
    create_task("Task 2", parent=parent["id"])
    create_task("Task 3", parent=parent["id"])

    create_task("Inserted", parent=parent["id"], sortorder=1)

    siblings = children_of(client, parent["id"])
    assert [task["text"] for task in siblings] == ["Task 1", "Inserted", "Task 2", "Task 3"]
    assert [task["sortorder"] for task in siblings] == [0, 1, 2, 3]


def test_create_task_calculates_duration_from_dates(create_task):
    created = create_task(start_date="2024-01-01 00:00:00", end_date="2024-01-05 00:00:00")

    assert created["duration"] == 4


def test_create_task_strips_leading_indent_and_icons_from_text(create_task):
    created = create_task("　　📁 プロジェクト名 ")

    assert created["text"] == "プロジェクト名"


def test_create_task_keeps_other_leading_emoji_in_text(create_task):
    created = create_task("📊 レポート")

    assert created["text"] == "📊 レポート"


def test_create_task_with_blank_text_gets_default_name(create_task):
    created = create_task("   ")

    assert created["text"] == "新規タスク"


def test_create_task_accepts_explicit_id(create_task):
    created = create_task("学校", id=154, kind_task=2)

    assert created["id"] == 154


def test_create_task_accepts_memo(create_task, db):
    created = create_task("AI テストタスク", memo="API から渡したメモ", progress=0.1)

    assert created["memo"] == "API から渡したメモ"
    assert db.get(TaskModel, created["id"]).memo == "API から渡したメモ"


# --- 取得・更新 ---

def test_get_missing_task_returns_404(client):
    assert client.get("/api/tasks/999999").status_code == 404


def test_update_task_only_changes_sent_fields(client, create_task):
    created = create_task("Original", memo="keep me")

    response = client.put(f"/api/tasks/{created['id']}", json={"text": "Renamed"})

    assert response.status_code == 200
    updated = response.json()
    assert updated["text"] == "Renamed"
    assert updated["memo"] == "keep me"


def test_update_task_recalculates_duration_when_dates_change(client, create_task):
    created = create_task(start_date="2024-01-01 00:00:00", end_date="2024-01-02 00:00:00")

    response = client.put(
        f"/api/tasks/{created['id']}",
        json={"end_date": "2024-01-11 00:00:00", "duration": 1},
    )

    assert response.json()["duration"] == 10


def test_update_task_appends_today_to_edit_date_history_once(client, create_task):
    created = create_task(edit_date="2020-1-1")
    today = datetime.now().strftime("%Y-%m-%d")

    client.put(f"/api/tasks/{created['id']}", json={"memo": "first"})
    response = client.put(f"/api/tasks/{created['id']}", json={"memo": "second"})

    assert response.json()["edit_date"] == f"2020-1-1,{today}"


def test_update_missing_task_returns_404(client):
    assert client.put("/api/tasks/999999", json={"text": "x"}).status_code == 404


def test_task_can_be_pinned_and_persisted(client, create_task):
    created = create_task("Pinned Task", is_pinned=True)
    assert created["is_pinned"] is True

    update_res = client.put(f"/api/tasks/{created['id']}", json={"is_pinned": False})
    assert update_res.json()["is_pinned"] is False

    assert client.get(f"/api/tasks/{created['id']}").json()["is_pinned"] is False


# --- 削除 ---

def test_delete_task_removes_descendants_and_their_links(client, create_task, db):
    project = create_task("Project", kind_task=2)
    child = create_task("Child", parent=project["id"])
    grandchild = create_task("Grandchild", parent=child["id"])
    survivor = create_task("Survivor")
    db.add_all([
        LinkModel(source=grandchild["id"], target=survivor["id"], type=0),
        LinkModel(source=survivor["id"], target=child["id"], type=0),
        LinkModel(source=survivor["id"], target=survivor["id"], type=0),
    ])
    db.commit()

    response = client.delete(f"/api/tasks/{project['id']}")

    assert response.status_code == 200
    assert response.json() == {
        "deleted_id": project["id"],
        "deleted_children": [child["id"], grandchild["id"]],
    }
    data = client.get("/api/tasks").json()
    assert [task["id"] for task in data["tasks"]] == [survivor["id"]]
    assert [(link["source"], link["target"]) for link in data["links"]] == [
        (survivor["id"], survivor["id"])
    ]


def test_delete_missing_task_returns_404(client):
    assert client.delete("/api/tasks/999999").status_code == 404


# --- クローン ---

def test_clone_inserts_copy_right_after_source_and_shifts_following_siblings(client, create_task):
    project = create_task("Project 1", kind_task=2)
    t1 = create_task("Task 1", parent=project["id"])
    t2 = create_task("Task 2", parent=project["id"])
    t3 = create_task("Task 3", parent=project["id"])

    cloned = client.post(f"/api/tasks/{t1['id']}/clone").json()

    assert cloned["sortorder"] == 1
    siblings = children_of(client, project["id"])
    assert [task["id"] for task in siblings] == [t1["id"], cloned["id"], t2["id"], t3["id"]]
    assert [task["sortorder"] for task in siblings] == [0, 1, 2, 3]


def test_clone_with_target_id_inserts_after_target(client, create_task):
    project = create_task("Project 1", kind_task=2)
    t1 = create_task("Task 1", parent=project["id"])
    t2 = create_task("Task 2", parent=project["id"])
    t3 = create_task("Task 3", parent=project["id"])

    cloned = client.post(f"/api/tasks/{t1['id']}/clone", params={"target_id": t2["id"]}).json()

    assert [task["id"] for task in children_of(client, project["id"])] == [
        t1["id"], t2["id"], cloned["id"], t3["id"],
    ]


def test_clone_copies_descendants_without_copy_suffix_and_resets_progress(client, create_task):
    project = create_task("Parent Project", kind_task=2, progress=0.5)
    child = create_task("Child Task", parent=project["id"], progress=1)
    grandchild = create_task("Grandchild Task", parent=child["id"])

    cloned_project = client.post(f"/api/tasks/{project['id']}/clone").json()

    assert cloned_project["text"] == "Parent Project"
    assert cloned_project["id"] != project["id"]
    assert cloned_project["progress"] == 0

    cloned_children = children_of(client, cloned_project["id"])
    assert [task["text"] for task in cloned_children] == ["Child Task"]
    assert cloned_children[0]["id"] != child["id"]
    assert cloned_children[0]["progress"] == 0

    cloned_grandchildren = children_of(client, cloned_children[0]["id"])
    assert [task["text"] for task in cloned_grandchildren] == ["Grandchild Task"]
    assert cloned_grandchildren[0]["id"] != grandchild["id"]


def test_clone_into_own_subtree_copies_original_children_only(client, create_task):
    """コピー元の配下に貼り付けても、作成中の複製を再帰的にコピーし続けない。"""
    project = create_task("Project", kind_task=2)
    child = create_task("Child", parent=project["id"])

    response = client.post(f"/api/tasks/{project['id']}/clone", params={"target_id": child["id"]})

    assert response.status_code == 200
    cloned_project = response.json()
    assert cloned_project["parent"] == project["id"]
    assert [task["text"] for task in children_of(client, cloned_project["id"])] == ["Child"]
    assert len(client.get("/api/tasks").json()["tasks"]) == 4


def test_clone_with_missing_target_returns_404_and_changes_nothing(client, create_task):
    task = create_task("Task")

    response = client.post(f"/api/tasks/{task['id']}/clone", params={"target_id": 999999})

    assert response.status_code == 404
    assert len(client.get("/api/tasks").json()["tasks"]) == 1


# --- 並び替え ---

def test_reorder_updates_sortorder_and_parent(client, create_task):
    project_a = create_task("A", kind_task=2)
    project_b = create_task("B", kind_task=2)
    t1 = create_task("Task 1", parent=project_a["id"])
    t2 = create_task("Task 2", parent=project_a["id"])

    response = client.post("/api/tasks/reorder", json={"items": [
        {"id": t2["id"], "sortorder": 0, "parent": project_b["id"]},
        {"id": t1["id"], "sortorder": 1, "parent": project_b["id"]},
    ]})

    assert response.json() == {"status": "success", "updated_count": 2}
    assert children_of(client, project_a["id"]) == []
    assert [task["id"] for task in children_of(client, project_b["id"])] == [t2["id"], t1["id"]]


# --- 更新シーケンス ---

def test_update_sequence_starts_as_integer(client):
    response = client.get("/api/tasks/update-sequence")

    assert response.status_code == 200
    assert response.json() == {"sequence": 0}


def test_each_task_modification_increments_sequence(client, create_task):
    def sequence() -> int:
        return client.get("/api/tasks/update-sequence").json()["sequence"]

    created = create_task("Sequence Test Task")
    after_create = sequence()
    assert after_create > 0

    client.put(f"/api/tasks/{created['id']}", json={"text": "Updated"})
    after_update = sequence()
    assert after_update > after_create

    client.post(f"/api/tasks/{created['id']}/clone")
    after_clone = sequence()
    assert after_clone > after_update

    client.post("/api/tasks/reorder", json={"items": [{"id": created["id"], "sortorder": 3, "parent": 0}]})
    after_reorder = sequence()
    assert after_reorder > after_clone

    client.delete(f"/api/tasks/{created['id']}")
    assert sequence() > after_reorder


def test_reading_tasks_does_not_increment_sequence(client, create_task):
    create_task()
    before = client.get("/api/tasks/update-sequence").json()["sequence"]

    client.get("/api/tasks")

    assert client.get("/api/tasks/update-sequence").json()["sequence"] == before
