"""
画像の WebP 変換テスト（obsidian-image-converter と同じ方針）

- 新しく書き出す画像だけを WebP（品質 75・リサイズなし）に変換する
- 元より 30KB 以上小さくならない場合、元より大きくなる場合は元の形式のまま
- GIF・SVG・WebP・tif・heic・*.drawio.*・*.excalidraw.* は変換しない
- ファイル名は {図面名}-{タイムスタンプ}.webp（同名があれば連番）
"""
import base64
import io
import os
import re
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.main import app
from backend.image_convert import (
    MIN_SAVINGS_BYTES,
    build_image_filename,
    convert_to_webp,
    should_skip_conversion,
)

FIXTURE_VAULT = Path(__file__).parent / "obsidian_test"
client = TestClient(app)


def noisy_png_bytes(size: int = 300) -> bytes:
    """WebP にすると 30KB 以上小さくなる、圧縮しにくい PNG を作る。"""
    image = Image.frombytes("RGB", (size, size), os.urandom(size * size * 3))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def flat_png_bytes() -> bytes:
    """もともと小さい PNG（30KB も削れない）。"""
    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), (255, 0, 0)).save(buffer, format="PNG")
    return buffer.getvalue()


def data_url(raw: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


@pytest.fixture
def vault(tmp_path):
    copy = tmp_path / "vault"
    shutil.copytree(FIXTURE_VAULT, copy)
    return copy


def load(path: Path):
    return client.get("/api/load-file", params={"filepath": str(path)})


def save(path: Path, data: dict):
    return client.post("/api/save-file", json={"filepath": str(path), "data": data})


def add_image(data: dict, file_id: str, raw: bytes, mime: str = "image/png") -> None:
    data["files"][file_id] = {"id": file_id, "mimeType": mime, "dataURL": data_url(raw, mime)}


# --- convert_to_webp / should_skip_conversion ---------------------------------

def test_convert_to_webp_shrinks_large_png():
    raw = noisy_png_bytes()
    result = convert_to_webp(raw, "image/png")
    assert result is not None
    webp_bytes = result
    assert webp_bytes[:4] == b"RIFF" and webp_bytes[8:12] == b"WEBP"
    assert len(raw) - len(webp_bytes) >= MIN_SAVINGS_BYTES


def test_convert_to_webp_keeps_original_when_savings_are_small():
    assert convert_to_webp(flat_png_bytes(), "image/png") is None


def test_convert_to_webp_force_ignores_savings_threshold():
    result = convert_to_webp(flat_png_bytes(), "image/png", force=True)
    assert result is not None and result[8:12] == b"WEBP"


def test_convert_to_webp_returns_none_for_broken_data():
    assert convert_to_webp(b"not an image", "image/png", force=True) is None


@pytest.mark.parametrize("mime", ["image/gif", "image/svg+xml", "image/webp", "image/tiff", "image/heic"])
def test_skipped_mime_types(mime):
    assert should_skip_conversion(mime, None) is True


@pytest.mark.parametrize("name", ["a.drawio.png", "a.dio.svg", "図.excalidraw.png", "x.excalidraw.svg"])
def test_skipped_filename_patterns(name):
    assert should_skip_conversion("image/png", name) is True


def test_png_is_not_skipped():
    assert should_skip_conversion("image/png", "photo.png") is False
    assert should_skip_conversion("image/jpeg", None) is False


# --- ファイル名 ---------------------------------------------------------------

def test_build_image_filename_uses_note_name_and_timestamp(tmp_path):
    name = build_image_filename(tmp_path, "設計図.excalidraw.md", "webp")
    assert re.fullmatch(r"設計図-\d{14}\.webp", name)


def test_build_image_filename_increments_on_conflict(tmp_path):
    first = build_image_filename(tmp_path, "note.md", "webp")
    (tmp_path / first).write_bytes(b"x")
    second = build_image_filename(tmp_path, "note.md", "webp")
    assert second != first
    assert re.fullmatch(r"note-\d{14}-1\.webp", second)


# --- 保存 API ----------------------------------------------------------------

def test_new_image_is_saved_as_webp_with_note_name(vault):
    path = vault / "test_api.excalidraw.md"
    data = load(path).json()["data"]
    raw = noisy_png_bytes()
    add_image(data, "img00001", raw)

    assert save(path, data).status_code == 200

    webps = list(vault.glob("test_api-*.webp"))
    assert len(webps) == 1
    assert webps[0].read_bytes()[8:12] == b"WEBP"
    assert not (vault / "img00001.png").exists()
    content = path.read_text(encoding="utf-8")
    assert f"img00001: [[{webps[0].name}]]" in content

    reloaded = load(path).json()["data"]
    assert reloaded["files"]["img00001"]["dataURL"].startswith("data:image/webp;base64,")


def test_small_image_stays_png_but_uses_new_name(vault):
    path = vault / "test_api.excalidraw.md"
    data = load(path).json()["data"]
    add_image(data, "img00002", flat_png_bytes())

    assert save(path, data).status_code == 200

    pngs = list(vault.glob("test_api-*.png"))
    assert len(pngs) == 1
    assert not list(vault.glob("test_api-*.webp"))


def test_saving_again_does_not_rewrite_or_duplicate_webp(vault):
    path = vault / "test_api.excalidraw.md"
    data = load(path).json()["data"]
    raw = noisy_png_bytes()
    add_image(data, "img00003", raw)
    assert save(path, data).status_code == 200
    webp = next(vault.glob("test_api-*.webp"))
    first_bytes = webp.read_bytes()

    # ブラウザ側は PNG の dataURL を持ち続けるので、同じ内容のまま再保存する
    data2 = load(path).json()["data"]
    add_image(data2, "img00003", raw)
    assert save(path, data2).status_code == 200

    assert list(vault.glob("test_api-*.webp")) == [webp]
    assert webp.read_bytes() == first_bytes
    assert webp.read_bytes()[8:12] == b"WEBP"


def test_existing_png_link_is_not_converted(vault):
    path = vault / "test_api.excalidraw.md"
    data = load(path).json()["data"]
    # まず PNG のまま書き出された画像（Embedded Files に PNG のリンクがある状態）を作る
    add_image(data, "old00001", flat_png_bytes())
    assert save(path, data).status_code == 200
    png = next(vault.glob("test_api-*.png"))

    # 既存リンクの画像は、リンク先を変えず元の形式のまま上書きする
    raw = noisy_png_bytes()
    data2 = load(path).json()["data"]
    add_image(data2, "old00001", raw)
    assert save(path, data2).status_code == 200

    assert png.read_bytes() == raw
    assert not list(vault.glob("*.webp"))
