"""
「2 ファイルを保存」（統合マークダウン＋図面 PDF）を社内AIの上限に収めるテスト。

仕様:
- 図は PDF（1 ページ 1 図）で出力する。PDF が最大サイズ（既定 10MB、figure_pdf_max_bytes / 設定 figure_pdf_max_mb）を
  超えるときは図の境目で複数の PDF に分け、統合マークダウンの冒頭に PDF の数と「図面PDF n/m: 【図a】〜【図b】」を書く。
- 保存（POST /api/export/ai-bundle/save）: マークダウンが 20 万文字を超えたら `_context_part{n}of{m}.md` に分割し、
  図面 PDF は `_figures.pdf`（複数なら `_figures_part{n}of{m}.pdf`）で保存する。保存後に読み直して上限を確かめる。
- 図面 PDF の最大サイズ（MB）はサーバーに保存し（GET / POST /api/export/config の figure_pdf_max_mb、既定 10）、
  保存の要求で figure_pdf_max_mb を渡せばその値を使う。
- 応答には、各パートの文字数（text_parts）・図面 PDF の名前と容量・保存したファイル名の一覧を含める。
"""

from __future__ import annotations

import io
import random
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfReader

from app.vector.markdown_image_exporter import export_documents_to_markdown_and_image
from app.vector.output_limits import MAX_TEXT_CHARS


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    from app.config import settings
    from app.main import app

    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
    return TestClient(app)


def _noise_image(width: int, height: int, seed: int) -> Image.Image:
    """圧縮の効きにくい画像（容量の大きい PNG になる）。"""
    rng = random.Random(seed)
    return Image.frombytes("RGB", (width, height), bytes(rng.getrandbits(8) for _ in range(width * height * 3)))


def _figure_note(tmp_path: Path, count: int, size: int = 300) -> Path:
    lines = []
    for i in range(1, count + 1):
        _noise_image(size, size, i).save(tmp_path / f"img{i}.png")
        lines.append(f"![[img{i}.png]]")
    note = tmp_path / "note.md"
    note.write_text("# 図だらけ\n" + "\n".join(lines) + "\n", encoding="utf-8")
    return note


def test_figures_are_one_pdf_with_one_page_each(tmp_path: Path) -> None:
    note = _figure_note(tmp_path, 3, size=60)
    md, parts, stats = export_documents_to_markdown_and_image(file_paths=[str(note)], vault_path=str(tmp_path))

    assert len(parts) == 1
    assert parts[0].data.startswith(b"%PDF")
    assert len(PdfReader(io.BytesIO(parts[0].data)).pages) == 3
    assert parts[0].figures == (1, 3)
    assert "図面PDF（1ページに1図）" in md
    assert stats["figure_pdf_count"] == 1


def test_figure_pdf_is_split_at_max_size_and_markdown_lists_ranges(tmp_path: Path) -> None:
    note = _figure_note(tmp_path, 4)
    md, parts, stats = export_documents_to_markdown_and_image(
        file_paths=[str(note)], vault_path=str(tmp_path), figure_pdf_max_bytes=600_000
    )

    assert len(parts) > 1
    assert all(len(part.data) <= 600_000 for part in parts)
    assert f"図面PDFは容量制限のため全{len(parts)}個に分割されています" in md
    assert f"図面PDF 1/{len(parts)}: 【図1】" in md
    assert stats["figure_pdf_sizes"] == [len(part.data) for part in parts]


def test_save_splits_long_markdown_and_reports_parts(tmp_path: Path, client: TestClient) -> None:
    out = tmp_path / "out"
    notes = []
    for i in range(3):
        note = tmp_path / f"long{i}.md"
        note.write_text(f"# 長いノート{i}\n" + ("長い本文の行です。\n" * 10_000), encoding="utf-8")
        notes.append(str(note))

    resp = client.post(
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


def test_save_keeps_single_names_when_within_limits(tmp_path: Path, client: TestClient) -> None:
    Image.new("RGB", (40, 40), (0, 0, 255)).save(tmp_path / "a.png")
    note = tmp_path / "short.md"
    note.write_text("# 短い\n![[a.png]]\n", encoding="utf-8")
    out = tmp_path / "out"

    data = client.post(
        "/api/export/ai-bundle/save",
        json={"file_paths": [str(note)], "vault_path": str(tmp_path), "file_base_name": "AI", "target_dir": str(out)},
    ).json()

    assert data["markdown_names"] == ["AI_context.md"]
    assert data["figure_pdf_names"] == ["AI_figures.pdf"]
    assert len(PdfReader(out / "AI_figures.pdf").pages) == 1
    assert len(data["text_parts"]) == 1 and data["text_parts"][0]["chars"] > 0
    assert data["has_images"] is True
    assert data["problems"] == []


def test_figure_pdf_max_size_is_saved_and_used(tmp_path: Path, client: TestClient) -> None:
    assert client.get("/api/export/config").json()["figure_pdf_max_mb"] == 10

    saved = client.post("/api/export/config", json={"figure_pdf_max_mb": 0.6}).json()
    assert saved["figure_pdf_max_mb"] == 0.6
    assert client.get("/api/export/config").json()["figure_pdf_max_mb"] == 0.6

    note = _figure_note(tmp_path, 4)
    out = tmp_path / "out"
    data = client.post(
        "/api/export/ai-bundle/save",
        json={"file_paths": [str(note)], "vault_path": str(tmp_path), "file_base_name": "AI", "target_dir": str(out)},
    ).json()

    total = len(data["figure_pdf_names"])
    assert total > 1, "保存した最大サイズ（0.6MB）で分割する"
    assert data["figure_pdf_names"] == [f"AI_figures_part{n}of{total}.pdf" for n in range(1, total + 1)]
    assert all(size <= 600_000 for size in data["figure_pdf_sizes"])
    assert data["figure_pdf_max_bytes"] == 600_000

    override = client.post(
        "/api/export/ai-bundle/save",
        json={"file_paths": [str(note)], "vault_path": str(tmp_path), "file_base_name": "B", "target_dir": str(out), "figure_pdf_max_mb": 50},
    ).json()
    assert override["figure_pdf_names"] == ["B_figures.pdf"], "要求で渡した最大サイズを優先する"


def test_figure_pdf_max_size_rejects_invalid_values(client: TestClient) -> None:
    assert client.post("/api/export/config", json={"figure_pdf_max_mb": 0}).status_code == 400
    assert client.post("/api/export/config", json={"figure_pdf_max_mb": -3}).status_code == 400
