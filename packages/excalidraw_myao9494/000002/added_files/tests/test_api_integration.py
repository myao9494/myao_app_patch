"""
API 統合テスト: tests/obsidian_test の実際の Obsidian ノートを使った往復テスト

サーバーを起動せず、FastAPI の TestClient でアプリを直接呼び出す。
フィクスチャは一時フォルダにコピーしてから使う（リポジトリ内のファイルは変更しない）。
"""
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import app

FIXTURE_VAULT = Path(__file__).parent / "obsidian_test"
client = TestClient(app)

DRAWING_NOTES = sorted(
    path.relative_to(FIXTURE_VAULT)
    for path in FIXTURE_VAULT.rglob("*.md")
    if "excalidraw-plugin: parsed" in path.read_text(encoding="utf-8")
)


@pytest.fixture
def vault(tmp_path):
    copy = tmp_path / "vault"
    shutil.copytree(FIXTURE_VAULT, copy)
    return copy


def load(path: Path):
    return client.get("/api/load-file", params={"filepath": str(path)})


def save(path: Path, data: dict, force_backup: bool = False):
    return client.post(
        "/api/save-file",
        json={"filepath": str(path), "data": data, "force_backup": force_backup},
    )


def test_fixture_notes_exist():
    assert len(DRAWING_NOTES) >= 5


@pytest.mark.parametrize("note", DRAWING_NOTES, ids=str)
def test_real_obsidian_notes_load(vault, note):
    response = load(vault / note)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["data"]["type"] == "excalidraw"
    assert isinstance(body["data"]["elements"], list)
    assert body["modified"] > 0
    assert body["resolvedPath"] == str(vault / note)


@pytest.mark.parametrize("note", DRAWING_NOTES, ids=str)
def test_real_obsidian_notes_round_trip(vault, note):
    """読み込んだ内容をそのまま保存しても、図面と Markdown の構造が保たれる。"""
    path = vault / note
    original_markdown = path.read_text(encoding="utf-8")
    loaded = load(path).json()["data"]

    assert save(path, loaded).status_code == 200

    saved_markdown = path.read_text(encoding="utf-8")
    reloaded = load(path).json()["data"]
    assert [element["id"] for element in reloaded["elements"]] == [
        element["id"] for element in loaded["elements"]
    ]
    assert "excalidraw-plugin: parsed" in saved_markdown
    assert "```compressed-json" in saved_markdown
    # Front Matter（最初の --- ブロック）は変更しない
    front_matter = original_markdown.split("---")[1]
    assert saved_markdown.split("---")[1] == front_matter
    # Obsidian 形式ではバックアップを作らない
    assert not (path.parent / "backup").exists()


def test_text_elements_section_is_updated(vault):
    path = vault / "test_api.excalidraw.md"
    data = load(path).json()["data"]
    data["elements"].append({
        "id": "newtext01",
        "type": "text",
        "x": 0, "y": 0, "width": 50, "height": 20,
        "text": "追加したテキスト",
        "isDeleted": False,
    })

    assert save(path, data).status_code == 200

    content = path.read_text(encoding="utf-8")
    text_section = content.split("## Text Elements", 1)[1].split("%%", 1)[0]
    assert "追加したテキスト ^newtext01" in text_section


def test_new_image_is_written_as_external_file(vault):
    path = vault / "test_api.excalidraw.md"
    data = load(path).json()["data"]
    png_base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
    data["files"]["img00001"] = {
        "id": "img00001",
        "mimeType": "image/png",
        "dataURL": f"data:image/png;base64,{png_base64}",
    }

    assert save(path, data).status_code == 200

    assert (vault / "img00001.png").exists()
    content = path.read_text(encoding="utf-8")
    assert "img00001: [[img00001.png]]" in content
    reloaded = load(path).json()["data"]
    assert reloaded["files"]["img00001"]["dataURL"].startswith("data:image/png;base64,")
