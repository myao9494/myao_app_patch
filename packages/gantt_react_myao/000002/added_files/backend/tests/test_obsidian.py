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
