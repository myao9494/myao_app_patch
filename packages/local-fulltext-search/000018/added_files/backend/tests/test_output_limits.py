"""
AIインプット出力の上限（テキスト20万文字・ファイル4.5MB）に収める部品（app.vector.output_limits）のテスト。

仕様:
- 上限は 200,000 文字・4,500,000 バイト。
- split_text_parts: 上限以内ならそのまま 1 パート。超えたら、ノートの境界 → 空行 → 改行 の順で切り、
  各パートの先頭に「分割ファイル n/m」、末尾に「続きあり」/「ここまで」を書く。注記込みで上限以内。
  ほぼ空のパートは作らない。本文は欠けない。
- part_file_name: 分割なしは `{base}_{kind}{ext}`、分割ありは `{base}_{kind}_part{n}of{m}{ext}`。
- html_text_chars: HTML の文字数から、埋め込み画像（data URL の base64 部分）を除いて数える。
- verify_saved_files: 書き出したファイルを読み直し、文字数・容量・画像として読めるかを確かめる。
"""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from PIL import Image

from app.vector.output_limits import (
    MAX_IMAGE_BYTES,
    MAX_TEXT_CHARS,
    html_text_chars,
    part_file_name,
    split_text_parts,
    verify_saved_files,
)


def test_limits_match_company_ai() -> None:
    assert MAX_TEXT_CHARS == 200_000
    assert MAX_IMAGE_BYTES == 4_500_000


def test_text_within_limit_is_returned_as_is() -> None:
    assert split_text_parts("短い本文", limit=5_000) == ["短い本文"]


def test_split_parts_fit_limit_and_keep_all_content() -> None:
    notes = [f"# ===== [ファイル {i}/30] note{i}.md =====\n" + ("本文の行です。\n" * 60) for i in range(1, 31)]
    text = "\n\n".join(notes)
    parts = split_text_parts(text, limit=5_000)

    assert len(parts) > 1
    assert all(len(part) <= 5_000 for part in parts)
    total = len(parts)
    for index, part in enumerate(parts, start=1):
        assert part.startswith(f"【分割ファイル {index}/{total}】")
        if index < total:
            assert f"続きは {index + 1}/{total} 番目" in part
        else:
            assert "ここまで" in part
    for i in range(1, 31):
        assert sum(part.count(f"note{i}.md") for part in parts) == 1, "各ノートの見出しはちょうど 1 回現れる"
    assert sum(part.count("本文の行です。") for part in parts) == 30 * 60, "本文は欠けない"


def test_split_prefers_note_boundaries() -> None:
    notes = [f"# ===== [ファイル {i}/10] n{i}.md =====\n" + ("あ" * 40 + "\n") * 20 for i in range(1, 11)]
    parts = split_text_parts("\n\n".join(notes), limit=3_000)
    for part in parts:
        body = part.split("\n\n", 1)[1]
        assert body.startswith("# ===== [ファイル"), "各パートの本文はノートの見出しから始まる"


def test_split_does_not_make_nearly_empty_parts() -> None:
    text = "# ===== [ファイル 1/2] a.md =====\n短い\n\n" + "# ===== [ファイル 2/2] b.md =====\n" + ("長い行\n" * 2_000)
    parts = split_text_parts(text, limit=3_000)
    assert all(len(part) > 3_000 * 0.25 for part in parts[:-1])


def test_split_rejects_too_small_limit() -> None:
    with pytest.raises(ValueError):
        split_text_parts("x" * 5_000, limit=1_200)


def test_part_file_name() -> None:
    assert part_file_name("AI", "context", 1, 1, ".md") == "AI_context.md"
    assert part_file_name("AI", "context", 2, 3, ".md") == "AI_context_part2of3.md"


def test_html_text_chars_excludes_embedded_image_data() -> None:
    payload = "A" * 50_000
    html = f'<p>本文</p><img src="data:image/png;base64,{payload}" /><img src="data:image/svg+xml;base64,{payload}">'
    without = '<p>本文</p><img src="data:image/png;base64," /><img src="data:image/svg+xml;base64,">'
    assert html_text_chars(html) == len(without)


def _png_bytes(size: tuple[int, int] = (10, 10)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (200, 10, 10)).save(buf, format="PNG")
    return buf.getvalue()


def test_verify_saved_files_reports_problems(tmp_path: Path) -> None:
    ok_text = tmp_path / "ok.md"
    ok_text.write_text("短い", encoding="utf-8")
    long_text = tmp_path / "long.md"
    long_text.write_text("あ" * (MAX_TEXT_CHARS + 1), encoding="utf-8")
    ok_image = tmp_path / "ok.png"
    ok_image.write_bytes(_png_bytes())
    broken_image = tmp_path / "broken.png"
    broken_image.write_bytes(b"not an image")

    problems = verify_saved_files([ok_text, long_text], [ok_image, broken_image])

    assert len(problems) == 2
    assert "long.md" in problems[0] and "200,000" in problems[0]
    assert "broken.png" in problems[1]


def test_verify_saved_html_counts_text_without_image_data(tmp_path: Path) -> None:
    html_file = tmp_path / "a.html"
    html_file.write_text(f'<p>本文</p><img src="data:image/png;base64,{"A" * (MAX_TEXT_CHARS + 10)}">', encoding="utf-8")
    assert verify_saved_files([html_file], []) == []
