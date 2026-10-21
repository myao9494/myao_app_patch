"""
AI用HTMLを社内AIの上限（20万文字・4.5MB）に収めるテスト。

仕様:
- 文字数は、埋め込み画像（data URL の base64 部分）を除いて数える。容量はファイル全体のバイト数。
- 上限以内なら 1 ファイル。文字数が上限を超えたら、ノート（メール）の境目で複数の HTML に分割する。
  1 つのノートだけで上限を超えるときは、そのノートを「(続き k/K)」の記事に分けてから振り分ける。
- 容量だけが上限を超え、分割しきい値（6MB）以下なら、埋め込み画像を縮小・JPEG 化して 1 ファイルに収める。
  しきい値を超えたら、ノートの境目で分割し、それでも上限を超えるファイルは画像を縮小する。
- 分割した各ファイルの先頭に「分割ファイル n/m」と、そのファイルに含むノートの目次を書き、末尾に続きの有無を書く。
  AI への指示（prompt）は 1 番目のファイルにだけ書く。
- stats / API 応答の html_parts に、各ファイルの番号・全体数・文字数・容量・HTML を入れる。total_chars は分割前の文字数。
- 分割した HTML の保存（POST /api/export/ai-html/save-parts）は `{名前}_part{n}of{m}.html` で保存し、
  同名のファイルがあれば上書きせず ` (1)` などを付ける。保存後に読み直して上限を確かめる。
"""

from __future__ import annotations

import io
import random
import re
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from app.vector.html_exporter import export_documents_to_html
from app.vector.output_limits import html_text_chars


def _noise_png(path: Path, size: int, seed: int) -> None:
    rng = random.Random(seed)
    Image.frombytes("RGB", (size, size), bytes(rng.getrandbits(8) for _ in range(size * size * 3))).save(path)


def _notes(tmp_path: Path, count: int, lines: int) -> list[str]:
    paths = []
    for i in range(1, count + 1):
        note = tmp_path / f"note{i:02d}.md"
        note.write_text(f"# ノート{i}\n\n" + "\n\n".join(f"ノート{i}の段落{j}です。" * 3 for j in range(lines)), encoding="utf-8")
        paths.append(str(note))
    return paths


def _parts(stats: dict) -> list[str]:
    return [part["html_content"] for part in stats["html_parts"]]


def test_small_document_is_one_part_with_char_count(tmp_path: Path) -> None:
    paths = _notes(tmp_path, 2, 3)
    html, stats = export_documents_to_html(file_paths=paths)

    assert len(stats["html_parts"]) == 1
    part = stats["html_parts"][0]
    assert part["html_content"] == html
    assert (part["index"], part["total"]) == (1, 1)
    assert part["chars"] == html_text_chars(html) == stats["total_chars"]
    assert part["bytes"] == len(html.encode("utf-8"))
    assert "分割ファイル" not in html


def test_long_text_is_split_at_note_boundaries(tmp_path: Path) -> None:
    paths = _notes(tmp_path, 20, 120)
    html, stats = export_documents_to_html(file_paths=paths, prompt="要約して", text_char_limit=40_000)

    parts = _parts(stats)
    total = len(parts)
    assert total > 1
    assert html == parts[0]
    assert stats["total_chars"] > 40_000
    for index, part in enumerate(parts, start=1):
        assert html_text_chars(part) <= 40_000
        assert f"【分割ファイル {index}/{total}】" in part
        assert part.rstrip().endswith("</html>")
    assert "要約して" in parts[0] and all("要約して" not in part for part in parts[1:])
    for i in range(1, 21):
        heading = f"] note{i:02d}</h2>"
        assert sum(part.count(heading) for part in parts) == 1, "各ノートはどれか 1 つのファイルにまるごと入る"


def test_single_huge_note_is_split_into_continuations(tmp_path: Path) -> None:
    note = tmp_path / "huge.md"
    note.write_text("# 巨大ノート\n\n" + "\n\n".join(f"段落{j}の本文です。" * 4 for j in range(3_000)), encoding="utf-8")

    _, stats = export_documents_to_html(file_paths=[str(note)], text_char_limit=40_000)

    parts = _parts(stats)
    assert len(parts) > 1
    assert all(html_text_chars(part) <= 40_000 for part in parts)
    joined = "".join(parts)
    assert re.search(r"huge \(続き 1/\d+\)", joined)
    for j in (0, 1_500, 2_999):
        assert f"段落{j}の本文です。" in joined, "本文は欠けない"


def test_images_over_limit_but_under_threshold_are_compressed_into_one(tmp_path: Path) -> None:
    for i in range(3):
        _noise_png(tmp_path / f"img{i}.png", 300, i)
    note = tmp_path / "figs.md"
    note.write_text("# 図\n" + "\n".join(f"![[img{i}.png]]" for i in range(3)) + "\n", encoding="utf-8")

    html, stats = export_documents_to_html(
        file_paths=[str(note)], size_limit_bytes=600_000, split_threshold_bytes=1_500_000
    )

    assert len(stats["html_parts"]) == 1
    assert len(html.encode("utf-8")) <= 600_000
    assert html.count("data:image/jpeg;base64,") == 3, "画像は縮小・JPEG 化して残す"


def test_images_over_threshold_are_split_and_each_part_fits(tmp_path: Path) -> None:
    paths = []
    for i in range(6):
        _noise_png(tmp_path / f"img{i}.png", 300, i)
        note = tmp_path / f"fig{i}.md"
        note.write_text(f"# 図{i}\n![[img{i}.png]]\n", encoding="utf-8")
        paths.append(str(note))

    _, stats = export_documents_to_html(file_paths=paths, size_limit_bytes=600_000, split_threshold_bytes=700_000)

    parts = _parts(stats)
    assert len(parts) > 1
    assert all(len(part.encode("utf-8")) <= 600_000 for part in parts)
    assert sum(part.count("<img ") for part in parts) == 6


def test_api_returns_parts_and_limits(tmp_path: Path) -> None:
    from app.main import app

    paths = _notes(tmp_path, 1, 2)
    data = TestClient(app).post("/api/export/ai-html", json={"file_paths": paths}).json()

    assert data["char_limit"] == 200_000
    assert data["size_limit_bytes"] == 4_500_000
    assert len(data["html_parts"]) == 1
    part = data["html_parts"][0]
    assert part["html_content"] == data["html_content"]
    assert part["chars"] == data["total_chars"] > 0
    assert part["bytes"] == data["size_bytes"]


def test_save_parts_writes_numbered_files_without_overwriting(tmp_path: Path) -> None:
    from app.main import app

    out = tmp_path / "out"
    out.mkdir()
    (out / "AI_part1of2.html").write_text("既存", encoding="utf-8")
    client = TestClient(app)

    data = client.post(
        "/api/export/ai-html/save-parts",
        json={"html_parts": ["<p>1</p>", "<p>2</p>"], "file_name": "AI.html", "target_dir": str(out)},
    ).json()

    assert data["file_names"] == ["AI (1)_part1of2.html", "AI (1)_part2of2.html"]
    assert (out / "AI_part1of2.html").read_text(encoding="utf-8") == "既存", "既存のファイルは上書きしない"
    assert [Path(p).read_text(encoding="utf-8") for p in data["saved_paths"]] == ["<p>1</p>", "<p>2</p>"]
    assert data["problems"] == []

    single = client.post(
        "/api/export/ai-html/save-parts",
        json={"html_parts": ["<p>only</p>"], "file_name": "Solo.html", "target_dir": str(out)},
    ).json()
    assert single["file_names"] == ["Solo.html"]
