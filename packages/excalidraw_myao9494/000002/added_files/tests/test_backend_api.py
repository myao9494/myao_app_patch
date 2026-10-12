"""
バックエンド API のテスト

- /api/open-url: URL スキームの許可リスト・デコード
- /api/open-in-editor: VS Code がない場合のフォールバック
- /api/list-directory: Excalidraw Markdown の一覧
- 通常名の .md（parsed ノート）の読み書き、埋め込みノートの解決
- アップロード配信・ライブラリ保存のパストラバーサル防止
"""
import asyncio
import json

import pytest
from fastapi import HTTPException



def test_api_endpoint_exists():
    """エンドポイントが存在することを確認"""
    from backend.main import app

    # FastAPIのルートを確認
    routes = [route.path for route in app.routes]
    assert "/api/open-url" in routes, "エンドポイント /api/open-url が存在しません"
    print("✅ エンドポイント /api/open-url が存在します")


def test_url_decode():
    """URLデコードのテスト"""
    import urllib.parse

    # テストケース1: 日本語を含むURL
    original = "obsidian://open?vault=obsidian_test&file=あらrh.excalidraw"
    encoded = urllib.parse.quote_plus(original)
    decoded = urllib.parse.unquote_plus(encoded)
    assert decoded == original
    print(f"✅ URLデコードテスト成功: {original}")

    # テストケース2: スペースを含むURL
    original2 = "obsidian://open?vault=my vault&file=test file.excalidraw"
    encoded2 = urllib.parse.quote_plus(original2)
    decoded2 = urllib.parse.unquote_plus(encoded2)
    assert decoded2 == original2
    print(f"✅ URLデコードテスト成功（スペース含む）: {original2}")


def test_url_validation():
    """URL検証のテスト"""

    # 有効なURL
    valid_urls = [
        "obsidian://open?vault=test&file=test.md",
        "http://example.com",
        "https://example.com",
    ]

    for url in valid_urls:
        assert ':' in url, f"無効なURL: {url}"

    print("✅ URL検証テスト成功")

    # 無効なURL
    invalid_urls = [
        "",
        "invalid",
        "no-colon-here",
    ]

    for url in invalid_urls:
        assert ':' not in url or not url, f"不正なURLが通過: {url}"

    print("✅ 無効なURL検出テスト成功")


def test_backend_rejects_unsupported_scheme():
    """任意プロトコルをOSへ渡さないことを確認"""
    from backend.main import open_url

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(open_url("file:///path/to/file"))

    assert exc_info.value.status_code == 400


def test_open_in_editor_uses_file_manager_when_code_is_missing(monkeypatch, tmp_path):
    from backend import main

    opened = []
    monkeypatch.setattr(main.system_open, "find_vscode_executable", lambda: None)
    monkeypatch.setattr(main.system_open, "launch_with_system", lambda path: opened.append(path))

    result = main.open_in_editor(main.OpenEditorRequest(path=str(tmp_path)))

    assert result.success is True
    assert result.fallbackUsed is True
    assert opened == [str(tmp_path.resolve())]


def test_list_directory_includes_excalidraw_markdown(tmp_path):
    from backend import main

    drawing = tmp_path / "drawing.excalidraw.md"
    drawing.write_text("", encoding="utf-8")
    parsed_note = tmp_path / "りんご.md"
    parsed_note.write_text(
        "---\nexcalidraw-plugin: parsed\n---\n\n# Excalidraw Data\n\n## Drawing\n```compressed-json\n{}\n```\n",
        encoding="utf-8",
    )
    (tmp_path / "ignored.txt").write_text("", encoding="utf-8")
    (tmp_path / "ordinary.md").write_text("# Ordinary note\n", encoding="utf-8")

    result = main.list_directory(main.ListDirectoryRequest(path=str(tmp_path)))

    assert [entry.name for entry in result.entries] == ["drawing.excalidraw.md", "りんご.md"]


def test_plain_markdown_parsed_note_can_load_and_save(tmp_path):
    from backend import main

    drawing = tmp_path / "りんご.md"
    original = {
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": [],
        "appState": {},
        "files": {},
    }
    drawing.write_text(
        "---\ncreated: today\nexcalidraw-plugin: parsed\n---\n\n"
        "表面のメモ\n\n# Excalidraw Data\n\n## Drawing\n"
        "```compressed-json\n"
        f"{json.dumps(original, ensure_ascii=False)}\n"
        "```\n",
        encoding="utf-8",
    )

    loaded = main.load_file(str(drawing))
    assert loaded["data"] == original

    updated = dict(original)
    updated["appState"] = {"viewBackgroundColor": "#ff0000"}
    result = (
        main.save_file(
            main.SaveFileRequest(
                filepath=str(drawing),
                data=updated,
                force_backup=True,
            )
        )
    )

    assert result["success"] is True
    saved_content = drawing.read_text(encoding="utf-8")
    assert "表面のメモ" in saved_content
    assert "excalidraw-plugin: parsed" in saved_content
    assert main.load_file(str(drawing))["data"]["appState"] == updated["appState"]
    assert not (tmp_path / "backup").exists()


def test_embedded_markdown_note_is_resolved_as_snapshot_source(tmp_path):
    from backend import main

    child = tmp_path / "りんご.md"
    child.write_text(
        "---\nexcalidraw-plugin: parsed\n---\n\n# Excalidraw Data\n"
        "\n## Drawing\n```compressed-json\n"
        '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}\n'
        "```\n",
        encoding="utf-8",
    )
    parent = tmp_path / "parent.md"
    parent.write_text(
        "---\nexcalidraw-plugin: parsed\n---\n\n# Excalidraw Data\n"
        "\n## Embedded Files\nimage-id: [[りんご]]\n\n%%\n## Drawing\n"
        "```compressed-json\n"
        '{"type":"excalidraw","version":2,"elements":[{"id":"image",'
        '"type":"image","x":0,"y":0,"width":100,"height":100,'
        '"fileId":"image-id"}],"appState":{},"files":{}}\n'
        "```\n%%\n",
        encoding="utf-8",
    )

    loaded = main.load_file(str(parent))

    assert loaded["embeddedFilePaths"]["image-id"] == str(child)


def test_virtual_markdown_snapshot_is_not_written_as_svg(tmp_path):
    from backend import main

    child = tmp_path / "りんご.md"
    child.write_text(
        "---\nexcalidraw-plugin: parsed\n---\n\n# Excalidraw Data\n"
        "\n## Drawing\n```compressed-json\n"
        '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}\n'
        "```\n",
        encoding="utf-8",
    )
    parent = tmp_path / "parent.md"
    parent.write_text(
        "---\nexcalidraw-plugin: parsed\n---\n\n# Excalidraw Data\n"
        "\n## Embedded Files\nimage-id: [[snapshot.svg]]\n\n%%\n## Drawing\n"
        "```compressed-json\n"
        '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}\n'
        "```\n%%\n",
        encoding="utf-8",
    )

    result = (
        main.save_file(
            main.SaveFileRequest(
                filepath=str(parent),
                data={
                    "type": "excalidraw",
                    "version": 2,
                    "source": "https://excalidraw.com",
                    "elements": [],
                    "appState": {},
                    "files": {
                        "image-id": {
                            "id": "image-id",
                            "mimeType": "image/svg+xml",
                            "sourcePath": str(child),
                            "isEmbeddedMarkdownSnapshot": True,
                            "dataURL": "data:image/svg+xml;base64,PHN2Zy8+",
                        }
                    },
                },
            )
        )
    )

    assert result["success"] is True
    assert not (tmp_path / "snapshot.svg").exists()
    saved_content = parent.read_text(encoding="utf-8")
    assert "image-id: [[snapshot.svg]]" in saved_content


def test_missing_snapshot_svg_still_returns_path_for_markdown_resolution(tmp_path):
    from backend import main

    child = tmp_path / "りんご.md"
    child.write_text(
        "---\nexcalidraw-plugin: parsed\n---\n\n# Excalidraw Data\n"
        "\n## Drawing\n```compressed-json\n"
        '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}\n'
        "```\n",
        encoding="utf-8",
    )
    parent = tmp_path / "parent.md"
    parent.write_text(
        "---\nexcalidraw-plugin: parsed\n---\n\n# Excalidraw Data\n"
        "\n## Embedded Files\nimage-id: [[snapshot.svg]]\n\n%%\n## Drawing\n"
        "```compressed-json\n"
        '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}\n'
        "```\n%%\n",
        encoding="utf-8",
    )

    loaded = main.load_file(str(parent))

    assert loaded["embeddedFilePaths"]["image-id"] == str(tmp_path / "snapshot.svg")
    assert loaded["embeddedMarkdownCandidates"] == [str(child)]


def test_empty_scene_can_replace_existing_drawing(tmp_path):
    from backend import main

    drawing = tmp_path / "drawing.excalidraw"
    drawing.write_text('{"elements": [{"id": "old"}]}', encoding="utf-8")
    request = main.SaveFileRequest(
        filepath=str(drawing),
        data=main.ExcalidrawFileData(elements=[], appState={}, files={}),
        force_backup=False,
    )

    result = main.save_file(request)

    assert result["success"] is True
    assert json.loads(drawing.read_text(encoding="utf-8"))["elements"] == []


def test_empty_excalidraw_markdown_loads_as_empty_scene(tmp_path):
    from backend import main

    drawing = tmp_path / "drawing.excalidraw.md"
    drawing.write_text("  \n", encoding="utf-8")

    result = main.load_file(str(drawing))

    assert result["data"]["elements"] == []


def test_uploaded_file_route_rejects_path_traversal():
    from backend import main

    with pytest.raises(HTTPException) as exc_info:
        main.serve_uploaded_file("upload_local/files/../../../secret.txt")

    assert exc_info.value.status_code == 403


def test_library_save_rejects_arbitrary_path():
    from backend import main

    request = main.SaveLibraryRequest(
        file_path="../outside.excalidrawlib",
        data={"type": "excalidrawlib", "libraryItems": []},
    )

    with pytest.raises(HTTPException) as exc_info:
        main.save_library(request)

    assert exc_info.value.status_code == 403


def test_obsidian_url_format():
    """Obsidian URLフォーマットのテスト"""

    # テストケース: Obsidian URLの構造
    vault_name = "obsidian_test"
    file_name = "あらrh.excalidraw"

    # URLの生成
    obsidian_url = f"obsidian://open?vault={vault_name}&file={file_name}"

    assert obsidian_url.startswith("obsidian://")
    assert "vault=" in obsidian_url
    assert "file=" in obsidian_url

    print(f"✅ Obsidian URLフォーマットテスト成功: {obsidian_url}")


def test_library_is_served_from_public_not_dist(tmp_path, monkeypatch):
    """保存したライブラリが、ビルドし直さなくても次の読み込みで返ること。"""
    from fastapi.testclient import TestClient
    from backend import main

    library = tmp_path / "public" / "excalidraw_lib" / "my_lib.excalidrawlib"
    library.parent.mkdir(parents=True)
    monkeypatch.setattr(main, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(main, "LIBRARY_PATH", library)
    client = TestClient(main.app)

    saved = client.post("/save-library", json={
        "file_path": "public/excalidraw_lib/my_lib.excalidrawlib",
        "data": {"type": "excalidrawlib", "libraryItems": [{"id": "new-item"}]},
    })
    assert saved.json()["success"] is True

    response = client.get("/excalidraw_lib/my_lib.excalidrawlib")
    assert response.status_code == 200
    assert response.json()["libraryItems"] == [{"id": "new-item"}]
    assert "no-store" in response.headers["cache-control"]
