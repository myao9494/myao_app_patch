"""
Obsidianノート作成・リンク再解決API（/api/tasks/{id}/obsidian, /resolve-link）のテスト。
Vault は pytest の一時ディレクトリを使う。
"""
import os
import unicodedata
from datetime import datetime
from pathlib import Path

import pytest

from models import Task as TaskModel

TASK_ID = 99


@pytest.fixture
def vault(tmp_path) -> Path:
    home = tmp_path / "vault"
    home.mkdir()
    return home


@pytest.fixture(autouse=True)
def task(db):
    db.add(TaskModel(
        id=TASK_ID,
        text="テストタスク/名前 ",
        start_date="2026-03-14 00:00:00",
        end_date="2026-03-15 00:00:00",
    ))
    db.commit()


def create_note(client, vault: Path) -> dict:
    response = client.post(f"/api/tasks/{TASK_ID}/obsidian", params={"obsidian_home": str(vault)})
    assert response.status_code == 200, response.text
    return response.json()


def same_path(path_a: str, path_b: str | Path) -> bool:
    return os.path.normpath(path_a) == os.path.normpath(str(path_b))


def test_create_note_writes_frontmatter_file_and_links_raw_path(client, vault):
    data = create_note(client, vault)

    today_folder = vault / "01_data" / datetime.now().strftime("%Y/%m/%d")
    expected_path = today_folder / f"テストタスク_名前【{TASK_ID}】.md"
    assert data["id"] == TASK_ID
    assert same_path(data["hyperlink"], expected_path)
    assert "obsidian://" not in data["hyperlink"]

    content = expected_path.read_text(encoding="utf-8")
    assert content.startswith("---\ncreated: ")
    assert content.endswith("\ntags:\n---\n\n")


def test_create_note_falls_back_to_obsidian_home_env(client, vault, monkeypatch):
    monkeypatch.setenv("OBSIDIAN_HOME", str(vault))

    response = client.post(f"/api/tasks/{TASK_ID}/obsidian")

    assert response.status_code == 200
    assert response.json()["hyperlink"].startswith(str(vault))


def test_create_note_twice_keeps_existing_file_contents(client, vault):
    first = create_note(client, vault)
    Path(first["hyperlink"]).write_text("user notes", encoding="utf-8")

    second = create_note(client, vault)

    assert second["hyperlink"] == first["hyperlink"]
    assert Path(second["hyperlink"]).read_text(encoding="utf-8") == "user notes"


def test_create_note_reuses_file_stored_with_different_unicode_normalization(client, vault):
    """APFS等でファイル名がNFDで保存されていても、同じノートとして扱い二重作成しない。"""
    today_folder = vault / "01_data" / datetime.now().strftime("%Y/%m/%d")
    today_folder.mkdir(parents=True)
    nfd_name = unicodedata.normalize("NFD", f"テストタスク_名前【{TASK_ID}】.md")
    (today_folder / nfd_name).write_text("existing", encoding="utf-8")

    data = create_note(client, vault)

    assert len(list(today_folder.iterdir())) == 1
    assert Path(data["hyperlink"]).read_text(encoding="utf-8") == "existing"


def test_create_note_for_missing_task_returns_404(client, vault):
    response = client.post("/api/tasks/12345/obsidian", params={"obsidian_home": str(vault)})

    assert response.status_code == 404


def test_resolve_link_returns_current_path_when_file_exists(client, vault):
    created_path = create_note(client, vault)["hyperlink"]

    response = client.post(f"/api/tasks/{TASK_ID}/resolve-link", params={"obsidian_home": str(vault)})

    data = response.json()
    assert same_path(data["hyperlink"], created_path)
    assert data["updated"] is False


def test_resolve_link_relinks_by_task_id_when_note_was_renamed_or_moved(client, vault, db):
    original_path = Path(create_note(client, vault)["hyperlink"])
    moved_dir = vault / "archive"
    moved_dir.mkdir()
    renamed_path = moved_dir / f"タイトル変更後【{TASK_ID}】.md"
    original_path.rename(renamed_path)

    response = client.post(f"/api/tasks/{TASK_ID}/resolve-link", params={"obsidian_home": str(vault)})

    data = response.json()
    assert data["task_id"] == TASK_ID
    assert data["updated"] is True
    assert same_path(data["hyperlink"], renamed_path)
    assert same_path(db.get(TaskModel, TASK_ID).hyperlink, renamed_path)


def test_resolve_link_returns_404_when_note_is_gone(client, vault):
    Path(create_note(client, vault)["hyperlink"]).unlink()

    response = client.post(f"/api/tasks/{TASK_ID}/resolve-link", params={"obsidian_home": str(vault)})

    assert response.status_code == 404


def test_resolve_link_does_not_search_vault_for_links_outside_it(client, vault, db, tmp_path):
    (vault / f"別のノート【{TASK_ID}】.md").write_text("", encoding="utf-8")
    task = db.get(TaskModel, TASK_ID)
    task.hyperlink = str(tmp_path / "elsewhere" / "missing.pdf")
    db.commit()

    response = client.post(f"/api/tasks/{TASK_ID}/resolve-link", params={"obsidian_home": str(vault)})

    assert response.status_code == 404
    assert response.json()["detail"] == "Linked file not found"


def test_resolve_link_without_hyperlink_returns_404(client, vault):
    response = client.post(f"/api/tasks/{TASK_ID}/resolve-link", params={"obsidian_home": str(vault)})

    assert response.status_code == 404
    assert response.json()["detail"] == "Task hyperlink not found"


# ---- 外部（AI など）向け: パスを返す API ----


def test_note_api_returns_path_and_created_flag(client, vault):
    first = client.post(f"/api/tasks/{TASK_ID}/note", params={"obsidian_home": str(vault)})
    assert first.status_code == 200, first.text
    body = first.json()
    expected = vault / "01_data" / datetime.now().strftime("%Y/%m/%d") / f"テストタスク_名前【{TASK_ID}】.md"
    assert body["task_id"] == TASK_ID
    assert same_path(body["note_path"], expected)
    assert body["created"] is True
    assert expected.is_file()

    Path(body["note_path"]).write_text("AI が書いた内容", encoding="utf-8")
    second = client.post(f"/api/tasks/{TASK_ID}/note", params={"obsidian_home": str(vault)}).json()
    assert second["note_path"] == body["note_path"]
    assert second["created"] is False
    assert Path(second["note_path"]).read_text(encoding="utf-8") == "AI が書いた内容"


def test_note_api_links_task_hyperlink(client, vault, db):
    note_path = client.post(f"/api/tasks/{TASK_ID}/note", params={"obsidian_home": str(vault)}).json()["note_path"]

    db.expire_all()
    assert db.get(TaskModel, TASK_ID).hyperlink == note_path


def test_note_api_missing_task_returns_404(client, vault):
    response = client.post("/api/tasks/12345/note", params={"obsidian_home": str(vault)})

    assert response.status_code == 404


def test_note_api_uses_obsidian_home_env(client, vault, monkeypatch):
    monkeypatch.setenv("OBSIDIAN_HOME", str(vault))

    body = client.post(f"/api/tasks/{TASK_ID}/note").json()

    assert body["note_path"].startswith(str(vault))


def test_note_api_rejects_missing_vault_without_creating_it(client, tmp_path):
    missing = tmp_path / "no-such-vault"

    response = client.post(f"/api/tasks/{TASK_ID}/note", params={"obsidian_home": str(missing)})

    assert response.status_code == 400
    assert not missing.exists()


def test_note_creation_bumps_update_sequence_so_other_tabs_refresh(client, vault):
    before = client.get("/api/tasks/update-sequence").json()["sequence"]

    client.post(f"/api/tasks/{TASK_ID}/note", params={"obsidian_home": str(vault)})
    after_note_api = client.get("/api/tasks/update-sequence").json()["sequence"]
    client.post(f"/api/tasks/{TASK_ID}/obsidian", params={"obsidian_home": str(vault)})
    after_screen_api = client.get("/api/tasks/update-sequence").json()["sequence"]

    assert after_note_api != before
    assert after_screen_api != after_note_api


def test_with_note_creates_task_and_note_in_one_call(client, vault, db):
    response = client.post(
        "/api/tasks/with-note",
        params={"obsidian_home": str(vault)},
        json={"text": "メール: 見積依頼", "start_date": "2026-11-10 00:00:00", "end_date": "2026-11-11 00:00:00"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    new_id = body["task_id"]
    assert new_id != TASK_ID
    assert body["task"]["id"] == new_id
    assert body["task"]["text"] == "メール: 見積依頼"
    assert body["created"] is True
    assert body["task"]["hyperlink"] == body["note_path"]
    note = Path(body["note_path"])
    assert note.name == f"メール_ 見積依頼【{new_id}】.md"
    assert note.read_text(encoding="utf-8").startswith("---\ncreated: ")
    assert client.get(f"/api/tasks/{new_id}").json()["hyperlink"] == body["note_path"]


def test_with_note_does_not_create_task_when_vault_is_missing(client, tmp_path):
    before = len(client.get("/api/tasks").json()["tasks"])

    response = client.post(
        "/api/tasks/with-note",
        params={"obsidian_home": str(tmp_path / "no-such-vault")},
        json={"text": "作られないタスク", "start_date": "2026-11-10 00:00:00", "end_date": "2026-11-11 00:00:00"},
    )

    assert response.status_code == 400
    assert len(client.get("/api/tasks").json()["tasks"]) == before
