"""
Obsidian Vault のファイル名索引（画像埋め込みの高速解決）のテスト
- 2回目以降は Vault を再走査しない
- `[` などを含むファイル名もそのまま検索できる（globとして解釈しない）
- 新しく追加されたファイル・削除されたファイルに追従する
- プレビュー未生成時の代替SVGでファイル名をエスケープする
"""
import pytest

from app.services import obsidian


@pytest.fixture(autouse=True)
def fresh_index(monkeypatch):
    obsidian.clear_vault_indexes()
    monkeypatch.setattr(obsidian, "VAULT_INDEX_MIN_REBUILD_SECONDS", 0.0)
    yield
    obsidian.clear_vault_indexes()


@pytest.fixture
def vault(tmp_path):
    (tmp_path / ".obsidian").mkdir()
    (tmp_path / "notes" / "assets").mkdir(parents=True)
    (tmp_path / "notes" / "assets" / "Pasted image [1].png").write_bytes(b"png")
    return tmp_path


def test_finds_names_with_glob_characters(vault):
    found = obsidian.find_file_in_vault(vault, "Pasted image [1].png")

    assert found == vault / "notes" / "assets" / "Pasted image [1].png"


def test_does_not_rescan_vault_for_cached_names(vault, monkeypatch):
    walks = []
    original_walk = obsidian.os.walk
    monkeypatch.setattr(obsidian.os, "walk", lambda *a, **k: walks.append(a) or original_walk(*a, **k))

    obsidian.find_file_in_vault(vault, "Pasted image [1].png")
    obsidian.find_file_in_vault(vault, "Pasted image [1].png")

    assert len(walks) == 1


def test_picks_up_new_and_removed_files(vault):
    assert obsidian.find_file_in_vault(vault, "new.png") is None

    (vault / "new.png").write_bytes(b"png")
    assert obsidian.find_file_in_vault(vault, "new.png") == vault / "new.png"

    (vault / "new.png").unlink()
    assert obsidian.find_file_in_vault(vault, "new.png") is None


def test_prefers_file_closest_to_vault_root(vault):
    (vault / "dup.png").write_bytes(b"root")
    (vault / "notes" / "dup.png").write_bytes(b"deep")

    assert obsidian.find_file_in_vault(vault, "dup.png") == vault / "dup.png"


def test_view_image_resolves_name_only_embed(client, vault):
    response = client.get(
        "/api/view-image", params={"path": "Pasted image [1].png", "baseDir": str(vault / "notes")}
    )

    assert response.status_code == 200
    assert response.content == b"png"


def test_placeholder_svg_escapes_file_name(client, tmp_path):
    drawing = tmp_path / "<script>alert(1)<script>.excalidraw.md"
    drawing.write_text("{}", encoding="utf-8")

    response = client.get("/api/view-image", params={"path": str(drawing)})

    assert response.status_code == 200
    assert "<script>" not in response.text
    assert "&lt;script&gt;" in response.text
