"""出力の上限（テキスト20万文字・画像4.5MB）に収める分割・保存・検証のテスト (output_limits_test.py)"""

from __future__ import annotations

import io
import random
import re
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from backend.main import app
from backend.mkdocs_support import build_image_parts
from backend.output_limits import (
    IMAGE_SPLIT_THRESHOLD_BYTES,
    MAX_ATTEMPTS,
    MAX_IMAGE_BYTES,
    MAX_TEXT_CHARS,
    check_image_parts,
    check_text_parts,
    image_limit_for_attempt,
    part_file_name,
    split_text_parts,
    text_limit_for_attempt,
    verify_saved_files,
    write_text_files,
)

client = TestClient(app)


def _files_text(count: int, chars_each: int) -> str:
    blocks = [f'<file path="src/f{n}.py">\n' + ("x = 1  # 日本語の行\n" * (chars_each // 16)) + "</file>" for n in range(count)]
    return "\n\n".join(blocks)


def _noisy_image(width: int = 1200, height: int = 800, seed: int = 0) -> Image.Image:
    random.seed(seed)
    return Image.frombytes("RGB", (width, height), random.randbytes(width * height * 3))


def _figure(index: int, seed: int) -> dict:
    return {"index": index, "doc_path": f"docs/d{index}.md", "link_text": f"![f{index}](f{index}.png)", "image": _noisy_image(seed=seed)}


def _strip_markers(part: str) -> str:
    body = re.sub(r"\A【分割ファイル[^\n]*\n(?:指示文[^\n]*\n)?\n", "", part)
    return re.sub(r"\n\n【(?:続きあり|分割ファイルはここまでです)】[^\n]*\n\Z", "", body)


def test_上限以内のテキストは分割せずそのまま返す():
    text = "a" * MAX_TEXT_CHARS
    assert split_text_parts(text) == [text]


def test_上限を超えるテキストは各パートが20万文字以内に分割される():
    parts = split_text_parts(_files_text(5, 100_000))
    assert len(parts) > 1
    assert all(len(part) <= MAX_TEXT_CHARS for part in parts)
    assert check_text_parts(parts) == []


def test_分割しても本文は欠落も重複もなく順に連結すると元に戻る():
    text = _files_text(5, 100_000)
    parts = split_text_parts(text)
    assert "".join(_strip_markers(part) for part in parts).replace("\n", "") == text.replace("\n", "")


def test_分割はファイル境界を優先し各パートの先頭はファイル開始タグになる():
    parts = split_text_parts(_files_text(6, 80_000))
    for part in parts:
        assert _strip_markers(part).startswith('<file path="')


def test_分割ファイルには番号と続きがあることが記載される():
    parts = split_text_parts(_files_text(5, 100_000))
    total = len(parts)
    assert parts[0].startswith(f"【分割ファイル 1/{total}】")
    assert "【続きあり】" in parts[0] and f"2/{total}" in parts[0]
    assert f"【分割ファイル {total}/{total}】" in parts[-1]
    assert "【続きあり】" not in parts[-1] and "【分割ファイルはここまでです】" in parts[-1]


def test_1ファイルだけで20万文字を超えても行の途中を避けて分割される():
    text = '<file path="big.py">\n' + ("y = 2  # 長い一行です\n" * 30_000) + "</file>"
    parts = split_text_parts(text)
    assert len(parts) >= 2 and check_text_parts(parts) == []
    assert all(_strip_markers(part).endswith(("長い一行です", "</file>")) for part in parts)
    assert "".join(_strip_markers(part) for part in parts).replace("\n", "") == text.replace("\n", "")


def test_先頭付近に空行があっても後ろの長い本文をできるだけ詰めて分割する():
    text = "# 見出し\n\n説明です。\n\n" + ("本文の一行です。\n" * 40_000)
    parts = split_text_parts(text)
    assert len(parts) == 2
    assert len(parts[0]) > MAX_TEXT_CHARS * 0.9


def test_改行のない巨大な1行でも上限以内に分割できる():
    parts = split_text_parts("あ" * 450_000)
    assert len(parts) >= 3 and check_text_parts(parts) == []


def test_やり直しのたびに文字数と画像サイズの上限は厳しくなる():
    assert [text_limit_for_attempt(n) for n in range(MAX_ATTEMPTS)] == sorted({text_limit_for_attempt(n) for n in range(MAX_ATTEMPTS)}, reverse=True)
    assert image_limit_for_attempt(0) == MAX_IMAGE_BYTES
    assert image_limit_for_attempt(1) < image_limit_for_attempt(0)


def test_ファイル名は分割なしと分割ありで区別される():
    assert part_file_name("repo", "context", 1, 1, ".txt") == "repo_context.txt"
    assert part_file_name("repo", "context", 2, 3, ".txt") == "repo_context_part2of3.txt"


def test_保存検証は書き出したファイルを読み直して上限超過を検出する(tmp_path: Path):
    ok = tmp_path / "ok.txt"
    ok.write_text("a" * MAX_TEXT_CHARS, encoding="utf-8")
    too_long = tmp_path / "long.txt"
    too_long.write_text("あ" * (MAX_TEXT_CHARS + 1), encoding="utf-8")
    assert verify_saved_files([ok], []) == []
    problems = verify_saved_files([ok, too_long], [])
    assert len(problems) == 1 and "long.txt" in problems[0]


def test_保存検証は壊れた画像と容量超過の画像を検出する(tmp_path: Path):
    good = tmp_path / "good.png"
    Image.new("RGB", (10, 10), (1, 2, 3)).save(good)
    broken = tmp_path / "broken.png"
    broken.write_bytes(b"not an image")
    big = tmp_path / "big.png"
    _noisy_image(1800, 1000).save(big)
    assert big.stat().st_size > MAX_IMAGE_BYTES
    problems = verify_saved_files([], [good, broken, big])
    assert len(problems) == 2
    assert any("broken.png" in p for p in problems) and any("big.png" in p for p in problems)


def test_テキスト書き出しは古い分割ファイルを残さない(tmp_path: Path):
    out = tmp_path / "out"
    out.mkdir()
    write_text_files(out, "r", "context", ".txt", ["a", "b", "c"])
    assert sorted(p.name for p in out.iterdir()) == ["r_context_part1of3.txt", "r_context_part2of3.txt", "r_context_part3of3.txt"]
    write_text_files(out, "r", "context", ".txt", ["only"])
    assert [p.name for p in out.iterdir()] == ["r_context.txt"]


def test_テキスト書き出しは改行をLFのまま保ち他の名前のファイルは消さない(tmp_path: Path):
    out = tmp_path / "out"
    out.mkdir()
    (out / "memo.txt").write_text("keep", encoding="utf-8")
    (out / "other_context.txt").write_text("other", encoding="utf-8")
    [path] = write_text_files(out, "r", "context", ".txt", ["a\nb\n"])
    assert path.read_bytes() == b"a\nb\n"
    assert (out / "memo.txt").exists() and (out / "other_context.txt").exists()


# ---- 画像 -----------------------------------------------------------------


def test_6MB以下の結合画像は圧縮して1枚で4_5MB以下に収める():
    figures = [_figure(1, 1), _figure(2, 2)]
    parts = build_image_parts(figures)
    assert len(parts) == 1 and parts[0].figures == (1, 2)
    assert len(parts[0].data) <= MAX_IMAGE_BYTES
    assert parts[0].data[:2] == b"\xff\xd8"


def test_4_5MB以下に収まる結合画像は無圧縮PNGのまま出力する():
    parts = build_image_parts([{"index": 1, "doc_path": "d.md", "link_text": "l", "image": Image.new("RGB", (400, 200), (9, 9, 9))}])
    assert len(parts) == 1 and parts[0].data.startswith(b"\x89PNG")


def test_6MBを超える結合画像は図の境界で分割し各4_5MB以下にする():
    figures = [_figure(n, n) for n in range(1, 5)]
    parts = build_image_parts(figures)
    assert len(parts) >= 2
    assert check_image_parts([part.data for part in parts]) == []
    ranges = [part.figures for part in parts]
    assert ranges[0][0] == 1 and ranges[-1][1] == 4
    assert all(ranges[i][1] + 1 == ranges[i + 1][0] for i in range(len(ranges) - 1))
    assert IMAGE_SPLIT_THRESHOLD_BYTES > MAX_IMAGE_BYTES


def test_1枚の図が6MBを超えて分割できなくても縮小して4_5MB以下にする():
    parts = build_image_parts([{"index": 1, "doc_path": "d.md", "link_text": "l", "image": _noisy_image(2800, 2500)}])
    assert len(parts) == 1 and len(parts[0].data) <= MAX_IMAGE_BYTES


# ---- API ------------------------------------------------------------------


def test_コード保存は25万文字を複数ファイルに分け読み直して各20万文字以内を確認する(tmp_path: Path):
    repo = tmp_path / "big_repo"
    repo.mkdir()
    out = tmp_path / "out"
    context = _files_text(5, 50_000)
    data = client.post("/api/save_context", json={"library_path": str(repo), "context": context, "target_dir": str(out)}).json()
    assert data["verified"] is True and data["part_count"] == len(data["files"]) >= 2
    names = sorted(p.name for p in out.iterdir())
    assert names == [f"big_repo_context_part{n}of{data['part_count']}.txt" for n in range(1, data["part_count"] + 1)]
    for name in names:
        assert len((out / name).read_bytes().decode("utf-8")) <= MAX_TEXT_CHARS


def test_コンテキスト作成APIは合計文字数と分割パートを返す(tmp_path: Path):
    (tmp_path / "a.py").write_text("print('x')\n" * 25_000, encoding="utf-8")
    (tmp_path / "b.py").write_text("print('y')\n" * 25_000, encoding="utf-8")
    data = client.post("/api/repository_context", json={"library_path": str(tmp_path), "selected_files": ["a.py", "b.py"]}).json()
    assert data["chars"] == len(data["context"])
    assert len(data["text_parts"]) >= 2
    assert all(part["chars"] <= MAX_TEXT_CHARS and part["total"] == len(data["text_parts"]) for part in data["text_parts"])


def test_コンテキスト作成APIは小さい出力なら1パートのまま返す(tmp_path: Path):
    (tmp_path / "a.py").write_text("print('x')\n", encoding="utf-8")
    data = client.post("/api/repository_context", json={"library_path": str(tmp_path), "selected_files": ["a.py"]}).json()
    assert [part["text"] for part in data["text_parts"]] == [data["context"]]


def _mkdocs_repo(tmp_path: Path, image_count: int, doc_chars: int = 0) -> Path:
    (tmp_path / "docs").mkdir(parents=True)
    (tmp_path / "mkdocs.yml").write_text("site_name: Big\n", encoding="utf-8")
    lines = []
    for n in range(1, image_count + 1):
        _noisy_image(seed=n).save(tmp_path / "docs" / f"img{n}.png")
        lines.append(f"![図{n}](img{n}.png)")
    body = "# 大きな文書\n\n" + "\n\n".join(lines) + "\n\n" + ("本文の一行です。\n" * (doc_chars // 9))
    (tmp_path / "docs" / "index.md").write_text(body, encoding="utf-8")
    return tmp_path


def test_MkDocs保存は6MBを超える画像を分割し各4_5MB以下で読み直して確認する(tmp_path: Path):
    repo = _mkdocs_repo(tmp_path / "repo", 4)
    out = tmp_path / "out"
    data = client.post("/api/mkdocs/save_bundle", json={"library_path": str(repo), "selected_files": ["mkdocs.yml", "docs/index.md"], "target_dir": str(out), "file_base_name": "big"}).json()
    assert data["verified"] is True
    assert len(data["image_files"]) >= 2
    for item in data["image_files"]:
        assert (out / item["name"]).stat().st_size <= MAX_IMAGE_BYTES
        assert re.fullmatch(r"big_images_part\d+of\d+\.(png|jpg)", item["name"])
    md = (out / data["markdown_files"][0]["name"]).read_text(encoding="utf-8")
    assert f"結合画像 1/{len(data['image_files'])}" in md


def test_MkDocs保存は20万文字を超えるMarkdownを分割して続きを明記する(tmp_path: Path):
    repo = _mkdocs_repo(tmp_path / "repo", 0, doc_chars=450_000)
    out = tmp_path / "out"
    data = client.post("/api/mkdocs/save_bundle", json={"library_path": str(repo), "selected_files": ["mkdocs.yml", "docs/index.md"], "target_dir": str(out), "file_base_name": "big"}).json()
    files = data["markdown_files"]
    assert len(files) >= 3 and data["has_images"] is False
    for number, item in enumerate(files, start=1):
        assert item["name"] == f"big_context_part{number}of{len(files)}.md"
        text = (out / item["name"]).read_bytes().decode("utf-8")
        assert len(text) <= MAX_TEXT_CHARS
        assert f"【分割ファイル {number}/{len(files)}】" in text
    assert "【続きあり】" in (out / files[0]["name"]).read_text(encoding="utf-8")


def test_MkDocsプレビューは合計文字数とパート情報を返し保存はしない(tmp_path: Path):
    repo = _mkdocs_repo(tmp_path / "repo", 4, doc_chars=650_000)
    data = client.post("/api/mkdocs/context", json={"library_path": str(repo), "selected_files": ["mkdocs.yml", "docs/index.md"]}).json()
    assert data["chars"] == len(data["context"]) > MAX_TEXT_CHARS
    assert len(data["text_parts"]) >= 3 and len(data["image_parts"]) >= 2
    assert data["image_data_url"] == data["image_parts"][0]["data_url"]
    assert all(part["size"] <= MAX_IMAGE_BYTES for part in data["image_parts"])
    assert "5ファイル" in data["warning"]
    assert not (tmp_path / "out").exists()


def test_MkDocs保存で出力が少なければ従来どおり2ファイルだけ書き出す(tmp_path: Path):
    repo = _mkdocs_repo(tmp_path / "repo", 1)
    out = tmp_path / "out"
    data = client.post("/api/mkdocs/save_bundle", json={"library_path": str(repo), "selected_files": ["mkdocs.yml", "docs/index.md"], "target_dir": str(out), "file_base_name": "small"}).json()
    assert data["warning"] == ""
    assert data["markdown_name"] == "small_context.md" and data["image_name"] in {"small_images.png", "small_images.jpg"}
    assert len(list(out.iterdir())) == 2
    assert Image.open(io.BytesIO((out / data["image_name"]).read_bytes())).width > 0
