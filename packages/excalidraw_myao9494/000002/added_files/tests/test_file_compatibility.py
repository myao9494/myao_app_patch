"""変更前に作成されたExcalidrawファイルとの読み書き互換性テスト。"""

import asyncio
import json
from datetime import datetime

from lzstring import LZString
import pytest

import backend.main as backend_main
from backend.main import (
    SaveFileRequest,
    atomic_write_text,
    convert_to_utf16_surrogates,
    create_backup,
    embed_json_into_markdown,
    extract_json_from_markdown,
    load_file,
    save_file,
)


def _scene(elements=None, files=None):
    return {
        "type": "excalidraw",
        "version": 1,
        "source": "https://excalidraw.com",
        "companyMetadata": {"format": "legacy-internal", "keep": True},
        "elements": elements or [],
        "appState": {
            "viewBackgroundColor": "#fafafa",
            "gridSize": 20,
            "legacyAppStateValue": "preserve-me",
        },
        "files": files or {},
    }


def _rectangle():
    return {
        "id": "legacy-rectangle",
        "type": "rectangle",
        "x": 10,
        "y": 20,
        "width": 120,
        "height": 80,
        "angle": 0,
        "strokeColor": "#1e1e1e",
        "backgroundColor": "transparent",
        "fillStyle": "hachure",
        "strokeWidth": 1,
        "strokeStyle": "solid",
        "roughness": 1,
        "opacity": 100,
        "groupIds": [],
        "frameId": None,
        "roundness": None,
        "seed": 1,
        "version": 1,
        "versionNonce": 2,
        "isDeleted": False,
        "boundElements": None,
        "updated": 1,
        "link": "uploads/files/legacy document.pdf",
        "locked": False,
        "customData": {"companyLegacyKey": "keep-this"},
    }


def test_pre_v2_minimal_excalidraw_still_loads(tmp_path):
    """旧版の最小構成（appState/filesなし）を拒否しない。"""
    path = tmp_path / "pre-v2.excalidraw"
    legacy_data = {"type": "excalidraw", "version": 1, "elements": [_rectangle()]}
    path.write_text(json.dumps(legacy_data), encoding="utf-8")

    loaded = asyncio.run(load_file(str(path)))

    assert loaded["data"] == legacy_data
    assert loaded["resolvedPath"] == str(path)


def test_pre_v2_minimal_data_can_pass_save_request_defaults(tmp_path):
    """旧最小構成を保存APIへ渡しても必須項目不足にならず、未知項目を維持する。"""
    path = tmp_path / "pre-v2-save.excalidraw"
    legacy_data = {
        "type": "excalidraw",
        "version": 1,
        "elements": [_rectangle()],
        "companyMetadata": {"owner": "legacy-team"},
    }

    request = SaveFileRequest.model_validate(
        {"filepath": str(path), "data": legacy_data, "force_backup": False}
    )
    asyncio.run(save_file(request))

    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["version"] == 1
    assert saved["elements"] == legacy_data["elements"]
    assert saved["companyMetadata"] == {"owner": "legacy-team"}
    assert saved["appState"] == {}
    assert saved["files"] == {}


def test_legacy_excalidraw_round_trip_preserves_elements_links_and_custom_data(tmp_path):
    """通常JSONの既存要素、相対リンク、未知の要素データを保存後も維持する。"""
    path = tmp_path / "legacy.excalidraw"
    original = _scene([_rectangle()])
    path.write_text(json.dumps(original, ensure_ascii=False), encoding="utf-8")

    loaded = asyncio.run(load_file(str(path)))["data"]
    request = SaveFileRequest(filepath=str(path), data=loaded, force_backup=True)
    asyncio.run(save_file(request))

    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved == original
    assert saved["elements"][0]["link"] == "uploads/files/legacy document.pdf"
    assert saved["elements"][0]["customData"] == {"companyLegacyKey": "keep-this"}

    backups = list((tmp_path / "backup").glob("legacy_backup_*.excalidraw"))
    assert len(backups) == 1
    assert json.loads(backups[0].read_text(encoding="utf-8")) == original


def test_legacy_excalidraw_round_trip_through_request_model(tmp_path):
    """APIのPydantic境界を通しても旧version 1データを欠落させない。"""
    path = tmp_path / "legacy-http.excalidraw"
    original = _scene([_rectangle()])
    path.write_text(json.dumps(original, ensure_ascii=False), encoding="utf-8")

    loaded = asyncio.run(load_file(str(path)))
    assert loaded["data"] == original

    request_json = json.dumps(
        {"filepath": str(path), "data": loaded["data"], "force_backup": True},
        ensure_ascii=False,
    )
    request = SaveFileRequest.model_validate_json(request_json)
    save_response = asyncio.run(save_file(request))
    assert save_response["success"] is True

    assert json.loads(path.read_text(encoding="utf-8")) == original


def test_old_uncompressed_markdown_is_upgraded_without_touching_other_json(tmp_path):
    """旧jsonフェンスだけを正式形式へ変換し、メモ中のJSON例は壊さない。"""
    path = tmp_path / "legacy.excalidraw.md"
    old_scene = _scene([_rectangle()])
    custom_json_example = '{"this":"is a note, not drawing data"}'
    path.write_text(
        """---
tags: [excalidraw, company]
excalidraw-plugin: parsed
company-field: keep-this
---

## Company Notes
```json
{custom_json}
```

# Excalidraw Data

## Text Elements

## Drawing
```json
{drawing_json}
```

## Additional Notes
Do not remove this paragraph.
""".format(
            custom_json=custom_json_example,
            drawing_json=json.dumps(old_scene, ensure_ascii=False),
        ),
        encoding="utf-8",
    )

    loaded = asyncio.run(load_file(str(path)))["data"]
    assert loaded == old_scene

    request = SaveFileRequest(filepath=str(path), data=loaded, force_backup=True)
    asyncio.run(save_file(request))

    updated_markdown = path.read_text(encoding="utf-8")
    assert f"```json\n{custom_json_example}\n```" in updated_markdown
    assert "## Drawing\n```compressed-json" in updated_markdown
    assert "company-field: keep-this" in updated_markdown
    assert "Do not remove this paragraph." in updated_markdown
    assert not list((tmp_path / "backup").glob("legacy.excalidraw_backup_*"))

    reloaded = asyncio.run(load_file(str(path)))["data"]
    assert reloaded == old_scene


def test_existing_obsidian_embedded_image_round_trip(tmp_path):
    """旧Embedded Filesリンクを維持し、画像dataURLを読み戻せる。"""
    path = tmp_path / "with-image.excalidraw.md"
    assets_dir = tmp_path / "assets"
    assets_dir.mkdir()
    image_path = assets_dir / "legacy.png"
    image_path.write_bytes(b"legacy-image-bytes")

    files = {
        "legacy-image-id": {
            "id": "legacy-image-id",
            "mimeType": "image/png",
            "created": 1,
        }
    }
    scene = _scene([_rectangle()], files)
    json_str = json.dumps(scene, ensure_ascii=False)
    compressed = LZString().compressToBase64(convert_to_utf16_surrogates(json_str))
    path.write_text(
        f"""---
tags: [excalidraw]
excalidraw-plugin: parsed
---

# Excalidraw Data

## Text Elements

## Embedded Files
legacy-image-id: [[assets/legacy.png]]

%%
## Drawing
```compressed-json
{compressed}
```
%%
""",
        encoding="utf-8",
    )

    loaded = asyncio.run(load_file(str(path)))["data"]
    assert loaded["files"]["legacy-image-id"]["dataURL"].startswith("data:image/png;base64,")

    request = SaveFileRequest(filepath=str(path), data=loaded, force_backup=False)
    asyncio.run(save_file(request))

    updated_markdown = path.read_text(encoding="utf-8")
    assert "legacy-image-id: [[assets/legacy.png]]" in updated_markdown
    assert image_path.read_bytes() == b"legacy-image-bytes"
    assert not list((tmp_path / "backup").glob("with-image.excalidraw_backup_*"))

    reloaded = asyncio.run(load_file(str(path)))["data"]
    assert reloaded["elements"] == scene["elements"]
    assert reloaded["files"]["legacy-image-id"]["dataURL"].startswith("data:image/png;base64,")


def test_missing_drawing_block_does_not_replace_json_in_later_notes():
    """壊れたDrawingセクションの後にあるJSONメモを図面データと誤認しない。"""
    scene = _scene([_rectangle()])
    note_json = '{"companyNote":"do not replace"}'
    original = f"""# Excalidraw Data

## Text Elements

## Drawing
Drawing data is temporarily missing.

## Company Notes
```json
{note_json}
```
"""

    updated = embed_json_into_markdown(original, json.dumps(scene, ensure_ascii=False))

    assert f"```json\n{note_json}\n```" in updated
    assert updated.count("```compressed-json") == 1
    assert json.loads(extract_json_from_markdown(updated)) == scene


def test_new_embedded_files_section_is_inserted_after_all_text_elements():
    """画像追加時にText Elements本文をEmbedded Files配下へ追い出さない。"""
    text_element = {
        "id": "legacy-text",
        "type": "text",
        "text": "Preserve generated text",
        "isDeleted": False,
    }
    scene = _scene([text_element], {"image-id": {"id": "image-id"}})
    compressed = LZString().compressToBase64(
        convert_to_utf16_surrogates(json.dumps(scene, ensure_ascii=False))
    )
    original = f"""# Excalidraw Data

## Text Elements
Old generated text ^old-id

%%
## Drawing
```compressed-json
{compressed}
```
%%
"""

    updated = embed_json_into_markdown(
        original,
        json.dumps(scene, ensure_ascii=False),
        {"image-id": "assets/legacy.png"},
    )

    text_index = updated.index("Preserve generated text ^legacy-text")
    embedded_index = updated.index("## Embedded Files")
    drawing_index = updated.index("## Drawing")
    assert text_index < embedded_index < drawing_index
    assert "image-id: [[assets/legacy.png]]" in updated
    assert json.loads(extract_json_from_markdown(updated)) == scene


def test_atomic_write_failure_keeps_original_file(tmp_path, monkeypatch):
    """置換に失敗しても、既存ファイルを途中内容で破損させない。"""
    path = tmp_path / "atomic.excalidraw"
    path.write_text("original-content", encoding="utf-8")

    def fail_replace(_source, _target):
        raise OSError("simulated replace failure")

    monkeypatch.setattr(backend_main.os, "replace", fail_replace)
    with pytest.raises(OSError, match="simulated replace failure"):
        atomic_write_text(path, "new-content")

    assert path.read_text(encoding="utf-8") == "original-content"
    assert not list(tmp_path.glob(".atomic.excalidraw.*.tmp"))


def test_atomic_write_preserves_existing_mode_and_sets_new_file_mode(tmp_path):
    """原子的置換で既存権限を変えず、新規ファイルを0600のまま残さない。"""
    existing_path = tmp_path / "existing.excalidraw"
    existing_path.write_text("old", encoding="utf-8")
    existing_path.chmod(0o640)
    atomic_write_text(existing_path, "new")
    assert existing_path.stat().st_mode & 0o777 == 0o640

    new_path = tmp_path / "new.excalidraw"
    atomic_write_text(new_path, "new")
    assert new_path.stat().st_mode & 0o777 == 0o644


def test_forced_backups_in_same_second_do_not_overwrite(tmp_path, monkeypatch):
    """同じ秒の連続手動保存でも、それぞれのバックアップを残す。"""
    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 8, 11, 10, 0, 0, tzinfo=tz)

    monkeypatch.setattr(backend_main, "datetime", FrozenDateTime)
    path = tmp_path / "rapid-save.excalidraw"
    path.write_text('{"version":1}', encoding="utf-8")

    assert create_backup(str(path), force=True)
    assert create_backup(str(path), force=True)

    backups = sorted((tmp_path / "backup").glob("rapid-save_backup_*.excalidraw"))
    assert len(backups) == 2
    assert backups[0].read_text(encoding="utf-8") == '{"version":1}'
    assert backups[1].read_text(encoding="utf-8") == '{"version":1}'
