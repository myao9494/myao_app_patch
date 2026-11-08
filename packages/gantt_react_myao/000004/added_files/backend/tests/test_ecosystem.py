"""
エコシステム API（ハーネスの LLM や、ほかの自作アプリから使う共通の入口）のテスト。
- GET /api/ecosystem: アプリの名乗り（共通の形。版、深いリンク、使ってよい操作）
- GET /api/ecosystem/tasks: タスクを、LLM が読みやすい小さな形で探す
  （未完了・完了・すべて、期限の近さ、キーワード、件数の上限。親のタスク名を「 > 」でつないだ path つき）
"""


def test_manifest_has_common_shape(client):
    response = client.get("/api/ecosystem")
    assert response.status_code == 200
    body = response.json()
    assert body["ecosystem"] == 1
    assert body["app"] == "gantt"
    assert body["title"]
    assert body["version"] == client.get("/api/health").json()["version"]
    assert body["base_url"] == "http://testserver"
    assert body["links"]["home"] == "/"
    operations = {op["id"]: op for op in body["operations"]}
    assert operations["tasks.search"] == {"id": "tasks.search", "method": "GET", "path": "/api/ecosystem/tasks", "effect": "read"}
    assert operations["tasks.create"]["effect"] == "write"
    assert operations["tasks.update"] == {"id": "tasks.update", "method": "PUT", "path": "/api/tasks/{task_id}", "effect": "write"}
    assert all(op["effect"] in {"read", "write", "open"} for op in body["operations"])
    assert not any(op["method"] == "DELETE" for op in body["operations"]), "削除はエコシステムに出さない"


def search(client, **params):
    response = client.get("/api/ecosystem/tasks", params={"today": "2024-01-10", **params})
    assert response.status_code == 200, response.text
    return response.json()


def test_default_is_open_tasks_sorted_by_end_date(client, create_task):
    create_task("後の期限", start_date="2024-01-01 00:00:00", end_date="2024-01-20 00:00:00")
    create_task("先の期限", start_date="2024-01-01 00:00:00", end_date="2024-01-12 00:00:00")
    create_task("完了", progress=1.0)

    body = search(client)

    assert [item["text"] for item in body["items"]] == ["先の期限", "後の期限"]
    assert body["total"] == 2
    assert body["truncated"] is False
    first = body["items"][0]
    assert first["start"] == "2024-01-01"
    assert first["end"] == "2024-01-12"  # 保存されている終了日 (最終日の翌日)
    assert first["last_day"] == "2024-01-11"  # 人が言う「期限」(最終日)
    assert first["progress"] == 0
    assert first["days_left"] == 1  # 最終日までの日数
    assert first["overdue"] is False


def test_status_done_and_all(client, create_task):
    create_task("未完了")
    create_task("完了", progress=1.0)
    assert [i["text"] for i in search(client, status="done")["items"]] == ["完了"]
    assert {i["text"] for i in search(client, status="all")["items"]} == {"未完了", "完了"}
    assert client.get("/api/ecosystem/tasks", params={"status": "nope"}).status_code == 422


def test_due_within_days_includes_overdue(client, create_task):
    create_task("期限切れ", end_date="2024-01-05 00:00:00")  # 最終日 01-04
    create_task("7日後が最終日", end_date="2024-01-18 00:00:00")  # 最終日 01-17
    create_task("8日後が最終日", end_date="2024-01-19 00:00:00")

    body = search(client, due_within_days=7)

    assert [i["text"] for i in body["items"]] == ["期限切れ", "7日後が最終日"]
    assert body["items"][0]["overdue"] is True
    assert body["items"][0]["days_left"] == -6


def test_keywords_are_and_and_search_memo_and_todo(client, create_task):
    create_task("見積の作成", memo="A社 向け")
    create_task("見積の確認", ToDo="B社に電話")
    create_task("議事録")

    assert [i["text"] for i in search(client, q="見積")["items"]] == ["見積の作成", "見積の確認"]
    assert [i["text"] for i in search(client, q="見積 a社")["items"]] == ["見積の作成"]  # 空白で AND、大文字小文字を区別しない
    assert [i["text"] for i in search(client, q="電話")["items"]] == ["見積の確認"]


def test_path_kind_owner_and_flags(client, create_task):
    project = create_task("案件A", kind_task=2)
    phase = create_task("設計", parent=project["id"])
    task = create_task("図面", parent=phase["id"], owner_id=10, is_pinned=True, memo="長いメモ", ToDo="x" * 300)

    item = next(i for i in search(client, status="all")["items"] if i["id"] == task["id"])

    assert item["path"] == "案件A > 設計"
    assert item["parent"] == phase["id"]
    assert item["kind"] == "task"
    assert item["owner"] == "待"
    assert item["pinned"] is True
    assert item["has_memo"] is True
    assert len(item["todo"]) <= 101  # 長い ToDo は短くして返す (末尾に …)
    project_item = next(i for i in search(client, status="all")["items"] if i["id"] == project["id"])
    assert project_item["kind"] == "project"
    assert project_item["path"] == ""
    assert "memo" not in item, "メモの本文は返さない (詳しくは GET /api/tasks/{id})"


def test_limit_and_truncated(client, create_task):
    for n in range(5):
        create_task(f"T{n}")
    body = search(client, limit=2)
    assert len(body["items"]) == 2
    assert body["total"] == 5
    assert body["truncated"] is True
    assert client.get("/api/ecosystem/tasks", params={"limit": 0}).status_code == 422
    assert client.get("/api/ecosystem/tasks", params={"limit": 201}).status_code == 422


def test_today_must_be_a_date(client):
    assert client.get("/api/ecosystem/tasks", params={"today": "2024/01/10"}).status_code == 422


def test_ecosystem_routes_are_not_swallowed_by_spa(tmp_path):
    from fastapi.testclient import TestClient
    from main import create_app

    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html></html>", encoding="utf-8")
    client = TestClient(create_app(frontend_dist=dist))
    assert client.get("/api/ecosystem").headers["content-type"].startswith("application/json")
    assert client.get("/api/ecosystem/tasks").headers["content-type"].startswith("application/json")


def test_last_day_is_today_is_not_overdue(client, create_task):
    create_task("今日まで", start_date="2024-01-10 00:00:00", end_date="2024-01-11 00:00:00")
    item = search(client)["items"][0]
    assert item["last_day"] == "2024-01-10"
    assert item["days_left"] == 0
    assert item["overdue"] is False


def test_todo_preview_is_one_line(client, create_task):
    create_task("電話", ToDo="9/B 予約\n\n  11/B 受取\r\n4/E 期限")
    assert search(client)["items"][0]["todo"] == "9/B 予約 / 11/B 受取 / 4/E 期限"


def test_link_shows_linked_note_name(client, create_task):
    """タスクとノートのつながり (hyperlink) を、名前だけで返す (フルパスは GET /api/tasks/{id})。"""
    create_task("つながり", hyperlink="/Users/u/vault/01_data/2026/11/07/まとめ【1】.md\n")
    create_task("URL", hyperlink="http://localhost:3001/?filepath=x")
    create_task("なし")
    items = {i["text"]: i for i in search(client)["items"]}
    assert items["つながり"]["link"] == "まとめ【1】.md"
    assert items["URL"]["link"] == "http://localhost:3001/?filepath=x"
    assert items["なし"]["link"] is None
