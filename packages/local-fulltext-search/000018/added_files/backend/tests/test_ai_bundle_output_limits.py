"""
「2 ファイルを保存」（統合マークダウン＋結合画像）を社内AIの上限（20万文字・4.5MB）に収めるテスト。

仕様:
- 結合画像: 連結した無圧縮 PNG が上限以下ならそのまま 1 枚、分割しきい値（6MB）以下なら縮小・JPEG 化で 1 枚、
  それを超えるなら図の境界で分割し、各枚を上限以下にする（build_image_parts）。各枚は収録した図番号の範囲を持つ。
- 結合画像が複数枚のときは、統合マークダウンの冒頭に枚数と「結合画像 n/m: 【図a】〜【図b】」の対応を書く。
- 保存（POST /api/export/ai-bundle/save）: マークダウンが 20 万文字を超えたら `_context_part{n}of{m}.md` に分割し、
  画像が複数枚なら `_images_part{n}of{m}` で保存する。保存後に読み直して上限を確かめ、結果を返す。
- 応答には、各パートの文字数（text_parts）・画像の容量（image_sizes）・保存したファイル名の一覧を含める。
"""

from __future__ import annotations

import io
import random
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from app.vector.markdown_image_exporter import build_image_parts, export_documents_to_markdown_and_image
from app.vector.output_limits import MAX_TEXT_CHARS


def _noise_image(width: int, height: int, seed: int) -> Image.Image:
    """圧縮の効きにくい画像（容量の大きい PNG になる）。"""
    rng = random.Random(seed)
    return Image.frombytes("RGB", (width, height), bytes(rng.getrandbits(8) for _ in range(width * height * 3)))


def _figures(count: int, size: int = 300) -> list[dict]:
    return [
        {"index": i, "note_name": f"n{i}.md", "link_text": f"![[img{i}.png]]", "image": _noise_image(size, size, i)}
        for i in range(1, count + 1)
    ]


def test_small_images_stay_in_one_png() -> None:
    images = [
        {"index": i, "note_name": "n.md", "link_text": f"![[{i}.png]]", "image": Image.new("RGB", (50, 50), (255, 0, 0))}
        for i in (1, 2)
    ]
    parts = build_image_parts(images)
    assert len(parts) == 1
    assert parts[0].figures == (1, 2)
    assert parts[0].data.startswith(b"\x89PNG")


def test_images_over_threshold_are_split_and_each_part_fits() -> None:
    images = _figures(4)
    parts = build_image_parts(images, target_width=320, max_bytes=300_000, split_threshold=400_000)

    assert len(parts) > 1
    assert all(len(part.data) <= 300_000 for part in parts)
    ranges = [part.figures for part in parts]
    assert ranges[0][0] == 1 and ranges[-1][1] == 4
    for (_, prev_end), (next_start, _) in zip(ranges, ranges[1:]):
        assert next_start == prev_end + 1, "図番号の範囲は欠けも重なりもなく続く"


def test_images_between_limit_and_threshold_are_compressed_into_one() -> None:
    images = _figures(2)
    parts = build_image_parts(images, target_width=320, max_bytes=300_000, split_threshold=10_000_000)
    assert len(parts) == 1
    assert len(parts[0].data) <= 300_000
    assert Image.open(io.BytesIO(parts[0].data)).format == "JPEG"


def test_markdown_lists_image_parts_when_split(tmp_path: Path) -> None:
    lines = []
    for i in range(1, 5):
        _noise_image(300, 300, i).save(tmp_path / f"img{i}.png")
        lines.append(f"![[img{i}.png]]")
    note = tmp_path / "note.md"
    note.write_text("# 図だらけ\n" + "\n".join(lines) + "\n", encoding="utf-8")

    md, parts, stats = export_documents_to_markdown_and_image(
        file_paths=[str(note)], vault_path=str(tmp_path), image_max_bytes=300_000, image_split_threshold=400_000
    )

    assert len(parts) > 1
    assert f"結合画像は容量制限のため全{len(parts)}枚に分割されています" in md
    assert f"結合画像 1/{len(parts)}: 【図1】" in md
    assert stats["image_part_count"] == len(parts)
    assert stats["image_sizes"] == [len(part.data) for part in parts]


def test_save_splits_long_markdown_and_reports_parts(tmp_path: Path, monkeypatch) -> None:
    from app.config import settings
    from app.main import app

    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
    out = tmp_path / "out"
    notes = []
    for i in range(3):
        note = tmp_path / f"long{i}.md"
        note.write_text(f"# 長いノート{i}\n" + ("長い本文の行です。\n" * 10_000), encoding="utf-8")
        notes.append(str(note))

    resp = TestClient(app).post(
        "/api/export/ai-bundle/save",
        json={"file_paths": notes, "file_base_name": "AI", "target_dir": str(out)},
    )

    assert resp.status_code == 200
    data = resp.json()
    total = len(data["text_parts"])
    assert total > 1
    assert data["markdown_names"] == [f"AI_context_part{n}of{total}.md" for n in range(1, total + 1)]
    for name, part in zip(data["markdown_names"], data["text_parts"]):
        saved = (out / name).read_text(encoding="utf-8")
        assert len(saved) == part["chars"] <= MAX_TEXT_CHARS
    assert data["problems"] == []
    assert data["markdown_name"] == data["markdown_names"][0], "従来の項目（先頭のファイル）も返す"


def test_save_keeps_single_names_when_within_limits(tmp_path: Path, monkeypatch) -> None:
    from app.config import settings
    from app.main import app

    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
    Image.new("RGB", (40, 40), (0, 0, 255)).save(tmp_path / "a.png")
    note = tmp_path / "short.md"
    note.write_text("# 短い\n![[a.png]]\n", encoding="utf-8")
    out = tmp_path / "out"

    data = TestClient(app).post(
        "/api/export/ai-bundle/save",
        json={"file_paths": [str(note)], "vault_path": str(tmp_path), "file_base_name": "AI", "target_dir": str(out)},
    ).json()

    assert data["markdown_names"] == ["AI_context.md"]
    assert data["image_names"] == ["AI_images.png"]
    assert len(data["text_parts"]) == 1 and data["text_parts"][0]["chars"] > 0
    assert data["has_images"] is True and data["image_name"] == "AI_images.png"
