"""
利用者のテキストファイルの文字コードのテスト。

Windows の日本語環境には Shift-JIS や UTF-16 のテキストが多い。UTF-8 だけで読むと文字化けして検索できない。

仕様:
- BOM があれば BOM の文字コード（UTF-8 / UTF-16 / UTF-32）で読み、BOM は本文に残さない。
- BOM が無ければ UTF-8 で読み、UTF-8 として読めなければ cp932（Shift-JIS）で読む。
- ほぼ UTF-8 で一部だけ壊れたファイルは、壊れた箇所を除いて UTF-8 として読む（全体を文字化けさせない）。
- 全文インデックス・ベクトルインデックス・AIインプットが同じ読み取りを使う。
"""

import json
import sqlite3
from pathlib import Path

import pytest

from app.db.schema import initialize_schema
from app.extractors.text_encoding import decode_text, read_text_file
from app.extractors.text_extractor import extract_text
from app.services.index_service import IndexService
from app.vector.db import open_db
from app.vector.export_document_reader import read_export_document_text
from app.vector.state import VectorState

TEXT = "社内規程の改定について。第三条を変更する。"


@pytest.mark.parametrize(
    "raw",
    [
        TEXT.encode("utf-8"),
        TEXT.encode("utf-8-sig"),
        TEXT.encode("cp932"),
        TEXT.encode("utf-16"),
        TEXT.encode("utf-16-le").join([b"\xff\xfe", b""]),
        b"\xfe\xff" + TEXT.encode("utf-16-be"),
        TEXT.encode("utf-32"),
    ],
    ids=["utf8", "utf8bom", "cp932", "utf16", "utf16le", "utf16be", "utf32"],
)
def test_decode_text_detects_the_encoding(raw: bytes) -> None:
    assert decode_text(raw) == TEXT


def test_mostly_utf8_with_a_broken_byte_stays_utf8() -> None:
    raw = ("本文" * 200).encode("utf-8") + b"\xff" + "末尾".encode("utf-8")

    decoded = decode_text(raw)

    assert decoded.startswith("本文本文")
    assert decoded.endswith("末尾")


def test_read_text_file_normalizes_newlines(tmp_path: Path) -> None:
    path = tmp_path / "note.md"
    path.write_bytes("1行目\r\n2行目\r3行目\n".encode("cp932"))

    assert read_text_file(path) == "1行目\n2行目\n3行目\n"


def test_decode_text_handles_empty_and_binary_noise() -> None:
    assert decode_text(b"") == ""
    assert isinstance(decode_text(bytes(range(256))), str)


@pytest.mark.parametrize(
    ("name", "raw"),
    [
        ("sjis.txt", TEXT.encode("cp932")),
        ("sjis.md", TEXT.encode("cp932")),
        ("utf16.txt", TEXT.encode("utf-16")),
        ("sjis.xml", f'<?xml version="1.0" encoding="shift_jis"?><a>{TEXT}</a>'.encode("cp932")),
        ("bom.json", json.dumps({"a": TEXT}, ensure_ascii=False).encode("utf-8-sig")),
        ("bom.md", TEXT.encode("utf-8-sig")),
    ],
)
def test_extract_text_reads_each_encoding(tmp_path: Path, name: str, raw: bytes) -> None:
    path = tmp_path / name
    path.write_bytes(raw)

    text = extract_text(path)

    assert "社内規程" in text
    assert "﻿" not in text


def test_shift_jis_note_is_searchable_after_indexing(tmp_path: Path) -> None:
    connection = sqlite3.connect(tmp_path / "search.db")
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    target = (tmp_path / "work").resolve()
    target.mkdir()
    (target / "規程.txt").write_bytes(TEXT.encode("cp932"))

    IndexService(connection=connection).ensure_fresh_target(full_path=target.as_posix(), refresh_window_minutes=0, index_depth=5)

    body = connection.execute("SELECT content FROM file_segments WHERE segment_type = 'body'").fetchone()[0]
    connection.close()
    assert "社内規程" in body


def test_vector_index_reads_shift_jis_markdown(tmp_path: Path) -> None:
    folder = tmp_path / "notes"
    folder.mkdir()
    (folder / "規程.md").write_bytes(TEXT.encode("cp932"))
    state = VectorState(data_dir=tmp_path)
    state.load_model(use_mock=True, mock_dim=32)

    state.sync_index(target_folders=[str(folder)], exclude_keywords="")

    with open_db(state.searcher.db_path) as connection:
        chunks = [str(row[0]) for row in connection.execute("SELECT text FROM chunks")]
    assert any("社内規程" in chunk for chunk in chunks)


def test_export_reader_handles_utf16(tmp_path: Path) -> None:
    path = tmp_path / "note.md"
    path.write_bytes(TEXT.encode("utf-16"))

    assert read_export_document_text(path) == TEXT
