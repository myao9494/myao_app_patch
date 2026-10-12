"""
読み込み・保存・更新検知まわりの回帰テスト

- Vault内の .excalidraw を保存しても JSON のまま壊れないこと
- .excalidraw.md への移行要否をバックエンドが一元的に判定すること
- 読み込み結果の modified が実ファイルの更新日時と一致すること
  （0 を返すとフロントエンドが「外部更新あり」と誤検知し、最初の編集が巻き戻る）
"""
import json

import pytest
from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)

SCENE = {
    "type": "excalidraw",
    "version": 2,
    "source": "https://excalidraw.com",
    "elements": [],
    "appState": {},
    "files": {},
}


def write_scene(path, scene=SCENE):
    path.write_text(json.dumps(scene), encoding="utf-8")


def load(path):
    return client.get("/api/load-file", params={"filepath": str(path)})


def save(path, data, force_backup=False):
    return client.post(
        "/api/save-file",
        json={"filepath": str(path), "data": data, "force_backup": force_backup},
    )


@pytest.fixture
def vault(tmp_path):
    root = tmp_path / "MyVault"
    (root / ".obsidian").mkdir(parents=True)
    return root


def test_saving_excalidraw_inside_vault_keeps_plain_json(vault):
    drawing = vault / "note.excalidraw"
    write_scene(drawing)

    updated = {**SCENE, "appState": {"viewBackgroundColor": "#ff0000"}}
    assert save(drawing, updated).status_code == 200

    # Markdownが混入せず、JSONとして読み戻せること
    saved = json.loads(drawing.read_text(encoding="utf-8"))
    assert saved["appState"]["viewBackgroundColor"] == "#ff0000"
    response = load(drawing)
    assert response.status_code == 200
    assert response.json()["data"]["appState"]["viewBackgroundColor"] == "#ff0000"


def test_excalidraw_inside_vault_is_marked_for_markdown_migration(vault):
    drawing = vault / "note.excalidraw"
    write_scene(drawing)

    assert load(drawing).json()["shouldMigrateToMarkdown"] is True


def test_excalidraw_with_obsidian_in_path_is_marked_for_migration(tmp_path):
    # 既存互換: パスに 'obsidian' を含む .excalidraw も移行対象
    folder = tmp_path / "my_obsidian_notes"
    folder.mkdir()
    drawing = folder / "note.excalidraw"
    write_scene(drawing)

    assert load(drawing).json()["shouldMigrateToMarkdown"] is True


def test_plain_excalidraw_is_not_migrated(tmp_path):
    drawing = tmp_path / "note.excalidraw"
    write_scene(drawing)

    assert load(drawing).json()["shouldMigrateToMarkdown"] is False


def test_already_migrated_markdown_is_loaded_instead(vault):
    drawing = vault / "note.excalidraw"
    write_scene(drawing)
    migrated = vault / "note.excalidraw.md"
    assert save(migrated, SCENE).status_code == 200

    body = load(drawing).json()
    assert body["resolvedPath"] == str(migrated)
    assert body["shouldMigrateToMarkdown"] is False


@pytest.mark.parametrize("name", ["note.excalidraw", "note.excalidraw.md"])
def test_load_returns_actual_modified_time(tmp_path, name):
    drawing = tmp_path / name
    if name.endswith(".md"):
        assert save(drawing, SCENE).status_code == 200
    else:
        write_scene(drawing)

    loaded = load(drawing).json()
    info = client.get("/api/file-info", params={"filepath": str(drawing)}).json()

    assert loaded["modified"] > 0
    assert loaded["modified"] == pytest.approx(drawing.stat().st_mtime)
    assert info["modified"] == pytest.approx(loaded["modified"])


def test_save_returns_modified_time_matching_file_info(tmp_path):
    drawing = tmp_path / "note.excalidraw"
    write_scene(drawing)

    saved = save(drawing, SCENE).json()
    info = client.get("/api/file-info", params={"filepath": str(drawing)}).json()

    assert saved["modified"] == pytest.approx(info["modified"])
