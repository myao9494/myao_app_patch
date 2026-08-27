"""
Obsidian互換機能のテスト

このテストでは以下を確認する：
1. is_obsidian_path関数のパス判定
2. JSONの圧縮・解凍
3. MarkdownからのJSON抽出
4. MarkdownへのJSON埋め込み
5. 画像インデックス辞書を用いた画像解決
6. Obsidian外に移動したフォルダでの同一フォルダ/サブフォルダ画像自動解決
7. 移動したフォルダでのload_fileによる画像ハイドレーション
"""
import sys
import json
import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
from fastapi import HTTPException

# プロジェクトルートをパスに追加
sys.path.insert(0, str(Path(__file__).parent.parent))

from backend.main import (
    is_obsidian_path,
    extract_json_from_markdown,
    embed_json_into_markdown,
    load_file,
    open_url,
    resolve_embedded_file_path,
)
from lzstring import LZString


def test_is_obsidian_path():
    """パス判定のテスト"""
    print("Testing is_obsidian_path...")

    # Obsidianパスとして認識されるべきもの
    assert is_obsidian_path("/vault/obsidian/test.excalidraw.md") == True
    assert is_obsidian_path("/vault/Obsidian/test.excalidraw.md") == True
    assert is_obsidian_path("/vault/obsidian/test.excalidraw") == True

    # Obsidianパスとして認識されないもの
    # .excalidraw.md はVault名に依存せずObsidian形式として扱う
    assert is_obsidian_path("/vault/test.excalidraw.md") == True
    assert is_obsidian_path("/vault/test.excalidraw") == False
    assert is_obsidian_path("/vault/obsidian/test.json") == False

    print("✅ is_obsidian_path test passed")


def test_compression_decompression():
    """圧縮・解凍のテスト"""
    print("\nTesting compression/decompression...")

    lz = LZString()

    # テストデータ
    test_data = {
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": [
            {
                "type": "rectangle",
                "x": 100,
                "y": 100,
                "width": 200,
                "height": 150
            }
        ],
        "appState": {},
        "files": {}
    }

    json_str = json.dumps(test_data, ensure_ascii=False)

    # 圧縮
    compressed = lz.compressToBase64(json_str)
    assert compressed is not None
    assert len(compressed) > 0
    print(f"  Original size: {len(json_str)} bytes")
    print(f"  Compressed size: {len(compressed)} bytes")
    print(f"  Compression ratio: {len(compressed)/len(json_str)*100:.1f}%")

    # 解凍
    decompressed = lz.decompressFromBase64(compressed)
    assert decompressed is not None
    assert decompressed == json_str

    # 解凍したデータがJSONとしてパースできるか
    parsed = json.loads(decompressed)
    assert parsed == test_data

    print("✅ Compression/decompression test passed")


def test_extract_json_from_markdown():
    """MarkdownからJSON抽出のテスト"""
    print("\nTesting extract_json_from_markdown...")

    # テストケース1: 非圧縮JSON
    test_data = {"type": "excalidraw", "version": 2, "elements": []}
    json_str = json.dumps(test_data, ensure_ascii=False)

    markdown_content = f"""---
tags: [excalidraw]
excalidraw-plugin: parsed
---

# Text Elements

# Drawing
```compressed-json
{json_str}
```"""

    extracted = extract_json_from_markdown(markdown_content)
    assert json.loads(extracted) == test_data
    print("  ✓ Non-compressed JSON extraction passed")

    # テストケース2: 圧縮JSON
    lz = LZString()
    compressed = lz.compressToBase64(json_str)

    markdown_compressed = f"""---
tags: [excalidraw]
excalidraw-plugin: parsed
---

# Text Elements

# Drawing
```compressed-json
{compressed}
```"""

    extracted_compressed = extract_json_from_markdown(markdown_compressed)
    assert json.loads(extracted_compressed) == test_data
    print("  ✓ Compressed JSON extraction passed")

    print("✅ extract_json_from_markdown test passed")


def test_load_obsidian_file_returns_400_for_invalid_json():
    """Obsidian markdown 内の不正 JSON は 500 ではなく 400 を返す。"""
    print("\nTesting invalid Obsidian JSON handling...")

    with TemporaryDirectory() as tmp_dir:
        vault_root = Path(tmp_dir) / "obsidian-vault"
        (vault_root / ".obsidian").mkdir(parents=True)
        target_file = vault_root / "broken.excalidraw.md"
        target_file.write_text(
            """---
tags: [excalidraw]
excalidraw-plugin: parsed
---

# Excalidraw Data

## Drawing
```json
{"type":"excalidraw","elements":[}
```
""",
            encoding="utf-8",
        )

        try:
            asyncio.run(load_file(str(target_file)))
            raise AssertionError("Expected HTTPException to be raised")
        except HTTPException as exc:
            assert exc.status_code == 400

    print("✅ Invalid Obsidian JSON returns 400")


def test_open_url_returns_400_for_invalid_format():
    """不正なURLは 500 ではなく 400 を返す。"""
    print("\nTesting invalid open-url handling...")

    try:
        asyncio.run(open_url("not-a-valid-url"))
        raise AssertionError("Expected HTTPException to be raised")
    except HTTPException as exc:
        assert exc.status_code == 400

    print("✅ Invalid open-url returns 400")


def test_embed_json_into_markdown():
    """MarkdownへのJSON埋め込みのテスト"""
    print("\nTesting embed_json_into_markdown...")

    test_data = {"type": "excalidraw", "version": 2, "elements": []}
    json_str = json.dumps(test_data, ensure_ascii=False)

    # テストケース1: 新規作成
    result = embed_json_into_markdown(None, json_str)
    assert "```compressed-json" in result
    assert "tags: [excalidraw]" in result
    assert "excalidraw-plugin: parsed" in result

    # JSONブロックを抽出して解凍できるか確認
    extracted = extract_json_from_markdown(result)
    assert json.loads(extracted) == test_data
    print("  ✓ New markdown creation passed")

    # テストケース2: 既存コンテンツの更新
    existing_content = """---
tags: [excalidraw, custom]
excalidraw-plugin: parsed
custom-field: value
---

# Text Elements
- Custom text

# Drawing
```compressed-json
OLD_DATA
```

# Additional Notes
Some custom notes"""

    updated_data = {"type": "excalidraw", "version": 2, "elements": [{"id": "new"}]}
    updated_json_str = json.dumps(updated_data, ensure_ascii=False)

    result_updated = embed_json_into_markdown(existing_content, updated_json_str)

    # カスタムフィールドが維持されているか確認
    assert "custom-field: value" in result_updated
    assert "Custom text" in result_updated
    assert "Additional Notes" in result_updated
    assert "Some custom notes" in result_updated

    # 更新されたJSONが抽出できるか確認
    extracted_updated = extract_json_from_markdown(result_updated)
    assert json.loads(extracted_updated) == updated_data
    print("  ✓ Existing markdown update passed")

    print("✅ embed_json_into_markdown test passed")


def test_end_to_end():
    """エンドツーエンドのテスト"""
    print("\nTesting end-to-end workflow...")

    # テストデータ
    original_data = {
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": [
            {
                "type": "rectangle",
                "id": "rect1",
                "x": 100,
                "y": 100,
                "width": 200,
                "height": 150
            }
        ],
        "appState": {"viewBackgroundColor": "#ffffff"},
        "files": {}
    }

    json_str = json.dumps(original_data, ensure_ascii=False)

    # ステップ1: Markdown作成
    markdown = embed_json_into_markdown(None, json_str)
    print("  ✓ Step 1: Created markdown")

    # ステップ2: JSON抽出
    extracted_json = extract_json_from_markdown(markdown)
    print("  ✓ Step 2: Extracted JSON")

    # ステップ3: データ検証
    extracted_data = json.loads(extracted_json)
    assert extracted_data == original_data
    print("  ✓ Step 3: Data verified")

    # ステップ4: データ更新
    updated_data = original_data.copy()
    updated_data["elements"].append({
        "type": "ellipse",
        "id": "ellipse1",
        "x": 300,
        "y": 300,
        "width": 100,
        "height": 100
    })
    updated_json_str = json.dumps(updated_data, ensure_ascii=False)

    # ステップ5: Markdown更新
    updated_markdown = embed_json_into_markdown(markdown, updated_json_str)
    print("  ✓ Step 4: Updated markdown")

    # ステップ6: 更新データ検証
    final_extracted = extract_json_from_markdown(updated_markdown)
    final_data = json.loads(final_extracted)
    assert final_data == updated_data
    assert len(final_data["elements"]) == 2
    print("  ✓ Step 5: Updated data verified")

    print("✅ End-to-end test passed")


def test_resolve_embedded_file_path_via_index():
    """画像インデックス辞書を用いた画像解決のテスト"""
    print("\nTesting resolve_embedded_file_path with index dictionary...")

    with TemporaryDirectory() as tmp_dir:
        vault_root = Path(tmp_dir) / "obsidian-vault"
        vault_root.mkdir(parents=True)
        (vault_root / ".obsidian").mkdir()
        
        # 1. 正常系：インデックス辞書を用いた解決
        # 画像ファイルを無関係な一時フォルダ配下に作成
        other_dir = Path(tmp_dir) / "other-folder"
        other_dir.mkdir(parents=True)
        target_img = other_dir / "my_image.png"
        target_img.write_text("dummy-image-data")

        # 辞書ファイルを用意
        plugin_dir = vault_root / ".obsidian" / "plugins" / "obsidian-sidebar-explorer"
        plugin_dir.mkdir(parents=True)
        index_file = plugin_dir / "image_paths.json"
        
        index_data = {
            "byObsidianPath": {
                "my_image.png": str(target_img)
            }
        }
        with open(index_file, "w", encoding="utf-8") as f:
            json.dump(index_data, f)

        # テスト対象のExcalidrawマークダウンファイルパス
        excalidraw_file = vault_root / "01_data" / "drawing.excalidraw.md"
        excalidraw_file.parent.mkdir(parents=True)
        
        # パス解決の呼び出し
        resolved = resolve_embedded_file_path(excalidraw_file, "my_image.png", vault_root)
        
        assert resolved == target_img
        assert resolved.exists()
        print("  ✓ Successfully resolved path using index dictionary")

        # 2. フォールバック系：辞書にあるが実在しない場合は従来のフォールバックを行う
        non_existent_img = other_dir / "no_exists.png"
        index_data["byObsidianPath"]["no_exists.png"] = str(non_existent_img)
        with open(index_file, "w", encoding="utf-8") as f:
            json.dump(index_data, f)

        # 従来探索で引っかかるように、同一フォルダに同名ファイルを作成
        fallback_img = excalidraw_file.parent / "no_exists.png"
        fallback_img.write_text("fallback-image-data")

        resolved_fallback = resolve_embedded_file_path(excalidraw_file, "no_exists.png", vault_root)
        assert resolved_fallback == fallback_img
        print("  ✓ Fallback to traditional search when indexed file does not exist")

    print("✅ resolve_embedded_file_path test passed")


def test_resolve_embedded_file_path_moved_outside_vault():
    """Obsidian外に移動したフォルダでの画像解決テスト"""
    print("\nTesting resolve_embedded_file_path for folders moved outside vault...")

    with TemporaryDirectory() as tmp_dir:
        # Vault外の独立したフォルダを作成（.obsidianは存在しない）
        moved_folder = Path(tmp_dir) / "moved_project"
        moved_folder.mkdir(parents=True)
        excalidraw_file = moved_folder / "diagram.excalidraw.md"

        # 1. パス付きリンク（attachments/photo.png）で同一フォルダ直下に photo.png がある場合
        img_photo = moved_folder / "photo.png"
        img_photo.write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR...")
        resolved = resolve_embedded_file_path(excalidraw_file, "attachments/photo.png", vault_root=None)
        assert resolved == img_photo
        assert resolved.exists()
        print("  ✓ Resolved path-prefixed link to same-folder image")

        # 2. 拡張子なしリンク（attachments/photo）で同一フォルダ直下に photo.png がある場合
        resolved_no_ext = resolve_embedded_file_path(excalidraw_file, "attachments/photo", vault_root=None)
        assert resolved_no_ext == img_photo
        assert resolved_no_ext.exists()
        print("  ✓ Resolved extension-omitted link to same-folder image")

        # 3. URLエンコードされたリンク（attachments/My%20Image.png）で My Image.png がある場合
        img_space = moved_folder / "My Image.png"
        img_space.write_bytes(b"\x89PNG\r\n\x1a\n...")
        resolved_encoded = resolve_embedded_file_path(excalidraw_file, "attachments/My%20Image.png", vault_root=None)
        assert resolved_encoded == img_space
        assert resolved_encoded.exists()
        print("  ✓ Resolved URL-encoded link to same-folder image")

        # 4. パイプやサイズ指定付きリンク（photo.png|200）で photo.png がある場合
        resolved_pipe = resolve_embedded_file_path(excalidraw_file, "photo.png|200", vault_root=None)
        assert resolved_pipe == img_photo
        assert resolved_pipe.exists()
        print("  ✓ Resolved piped link to same-folder image")

        # 5. 大文字小文字の違い（リンク: PHOTO.png, 実ファイル: photo.png）
        resolved_case = resolve_embedded_file_path(excalidraw_file, "PHOTO.png", vault_root=None)
        assert resolved_case == img_photo
        assert resolved_case.exists()
        print("  ✓ Resolved case-insensitive image filename")

        # 6. 同一フォルダ内の attachments/ サブフォルダにある場合
        attachments_dir = moved_folder / "attachments"
        attachments_dir.mkdir(parents=True)
        img_sub = attachments_dir / "sub_pic.png"
        img_sub.write_bytes(b"\x89PNG\r\n\x1a\n...")
        # リンクがファイル名のみでも attachments/ 配下を探索して解決
        resolved_sub = resolve_embedded_file_path(excalidraw_file, "sub_pic.png", vault_root=None)
        assert resolved_sub == img_sub
        assert resolved_sub.exists()
        print("  ✓ Resolved same-folder attachments subfolder image")

    print("✅ resolve_embedded_file_path moved outside vault test passed")


def test_load_file_hydrates_images_in_moved_folder():
    """Obsidian外に移動したフォルダで load_file が画像を正しく読み込むことの統合テスト"""
    print("\nTesting load_file image hydration for moved folder...")

    with TemporaryDirectory() as tmp_dir:
        moved_folder = Path(tmp_dir) / "moved_project"
        moved_folder.mkdir(parents=True)
        excalidraw_file = moved_folder / "diagram.excalidraw.md"

        # 画像ファイルを同一フォルダ直下に作成
        image_file = moved_folder / "pasted_image.png"
        image_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4"
        image_file.write_bytes(image_bytes)

        # Excalidraw JSON
        scene_data = {
            "type": "excalidraw",
            "version": 2,
            "source": "https://excalidraw.com",
            "elements": [
                {
                    "type": "image",
                    "id": "elem_img_1",
                    "fileId": "file_id_123",
                    "x": 50,
                    "y": 50,
                    "width": 200,
                    "height": 150,
                    "isDeleted": False
                }
            ],
            "appState": {},
            "files": {
                "file_id_123": {
                    "id": "file_id_123",
                    "mimeType": "image/png"
                }
            }
        }
        json_str = json.dumps(scene_data, ensure_ascii=False)

        # Markdown形式で保存（リンクは attachments/pasted_image.png となっている）
        markdown_content = f"""---
excalidraw-plugin: parsed
tags: [excalidraw]
---

# Excalidraw Data

## Embedded Files
file_id_123: [[attachments/pasted_image.png]]

%%
## Drawing
```json
{json_str}
```
%%"""
        excalidraw_file.write_text(markdown_content, encoding="utf-8")

        # load_file を実行
        result = asyncio.run(load_file(str(excalidraw_file)))
        assert result is not None
        files = result["data"].get("files", {})
        assert "file_id_123" in files
        assert "dataURL" in files["file_id_123"]
        assert files["file_id_123"]["dataURL"].startswith("data:image/png;base64,")
        print("  ✓ load_file successfully hydrated image from moved folder")

    print("✅ load_file image hydration in moved folder test passed")


if __name__ == "__main__":
    print("=" * 60)
    print("Obsidian Integration Tests")
    print("=" * 60)

    try:
        test_is_obsidian_path()
        test_compression_decompression()
        test_extract_json_from_markdown()
        test_embed_json_into_markdown()
        test_resolve_embedded_file_path_via_index()
        test_resolve_embedded_file_path_moved_outside_vault()
        test_load_file_hydrates_images_in_moved_folder()
        test_end_to_end()

        print("\n" + "=" * 60)
        print("🎉 All tests passed!")
        print("=" * 60)

    except AssertionError as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

