"""
Excalidraw の図データを検索本文へ入れない仕様のテスト。

Excalidraw のノートの大半は図の JSON と貼り付け画像の base64 で、実データでは 1 件 1,500 万文字のうち
文章は約 9,000 文字だった。これを検索本文へ入れると、英数字の短い語が base64 に偶然一致し、
索引も大きくなる。

仕様:
- `## Drawing` 以降（JSON・compressed-json）は検索本文に入れない。
- `## Text Elements`（図の中の文字）とフロントマター、見出しより前の本文は検索できる。
- 普通の Markdown に `## Drawing` という見出しがあっても削らない。
- `.excalidraw`（JSON）は図形の文字を検索でき、埋め込み画像（`data:` の値）は入れない。
- ベクトルインデックスは `chunker` が `# Excalidraw Data` 以降をまとめて除く（図の中の文字も入らない）。
- 作成済みのインデックスは、ファイルが変わっていなくても版の更新で 1 度だけ作り直す。
"""

import json
import sqlite3
from pathlib import Path

import pytest

from app.db.schema import initialize_schema
from app.extractors.text_extractor import extract_text
from app.services.index_service import IndexService
from app.services.search_target_store import CURRENT_TARGET_INDEX_VERSION
from app.vector.db import open_db
from app.vector.state import VectorState

BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg" * 40


def _excalidraw_note(drawing_block: str) -> str:
    return (
        "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n"
        "==⚠  Switch to EXCALIDRAW VIEW ==\n\n\n"
        "# Excalidraw Data\n\n"
        "## Text Elements\n"
        "受注から出荷までの流れ ^abc123\n\n"
        "## Embedded Files\n"
        "deadbeef: [[pasted.png]]\n\n"
        "%%\n"
        "## Drawing\n"
        f"{drawing_block}\n"
        "%%\n"
    )


JSON_DRAWING = '```json\n{"type":"excalidraw","files":{"a":{"dataURL":"data:image/png;base64,' + BASE64 + '"}}}\n```'
COMPRESSED_DRAWING = "```compressed-json\nN4IgLgngDgpiBcIYA" + BASE64 + "\n```"


@pytest.mark.parametrize("drawing", [JSON_DRAWING, COMPRESSED_DRAWING], ids=["json", "compressed-json"])
@pytest.mark.parametrize("file_name", ["図.excalidraw.md", "図.md"])
def test_drawing_section_is_left_out_and_text_elements_are_kept(tmp_path: Path, file_name: str, drawing: str) -> None:
    path = tmp_path / file_name
    path.write_text(_excalidraw_note(drawing), encoding="utf-8")

    text = extract_text(path)

    assert "受注から出荷までの流れ" in text
    assert "pasted.png" in text
    assert "iVBORw0KGgo" not in text
    assert "## Drawing" not in text
    assert len(text) < 400


def test_ordinary_markdown_with_a_drawing_heading_is_kept(tmp_path: Path) -> None:
    path = tmp_path / "製図.md"
    path.write_text("# 製図の手順\n\n## Drawing\nこの見出しの本文は検索できる\n\n## 次の章\n続きの本文\n", encoding="utf-8")

    text = extract_text(path)

    assert "この見出しの本文は検索できる" in text
    assert "続きの本文" in text


def test_excalidraw_json_keeps_text_and_drops_embedded_images(tmp_path: Path) -> None:
    path = tmp_path / "図.excalidraw"
    path.write_text(
        json.dumps(
            {
                "type": "excalidraw",
                "elements": [{"type": "text", "text": "受注の流れ"}],
                "files": {"a": {"mimeType": "image/png", "dataURL": f"data:image/png;base64,{BASE64}"}},
            }
        ),
        encoding="utf-8",
    )

    text = extract_text(path)

    assert "受注の流れ" in text
    assert "iVBORw0KGgo" not in text


def test_vector_index_does_not_embed_the_drawing(tmp_path: Path) -> None:
    folder = tmp_path / "notes"
    folder.mkdir()
    (folder / "図.excalidraw.md").write_text(_excalidraw_note(JSON_DRAWING), encoding="utf-8")
    state = VectorState(data_dir=tmp_path)
    state.load_model(use_mock=True, mock_dim=32)

    state.sync_index(target_folders=[str(folder)], exclude_keywords="")

    with open_db(state.searcher.db_path) as connection:
        chunks = [str(row[0]) for row in connection.execute("SELECT text FROM chunks")]
    assert chunks
    assert not any("iVBORw0KGgo" in chunk for chunk in chunks)
    assert len(chunks) <= 2


def _connect(tmp_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(tmp_path / "search.db")
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    return connection


def _body(connection: sqlite3.Connection) -> str:
    row = connection.execute("SELECT content FROM file_segments WHERE segment_type = 'body'").fetchone()
    return str(row["content"])


def test_existing_index_is_rebuilt_once_without_a_file_change(tmp_path: Path) -> None:
    connection = _connect(tmp_path)
    service = IndexService(connection=connection)
    target = (tmp_path / "work").resolve()
    target.mkdir()
    (target / "図.excalidraw.md").write_text(_excalidraw_note(JSON_DRAWING), encoding="utf-8")
    service.ensure_fresh_target(full_path=target.as_posix(), refresh_window_minutes=0, index_depth=5)
    # 以前の版で作った状態（図データ入りの本文、古い版番号）を再現する
    connection.execute("UPDATE file_segments SET content = ? WHERE segment_type = 'body'", (f"old {BASE64}",))
    connection.execute("UPDATE targets SET index_version = ?", (CURRENT_TARGET_INDEX_VERSION - 1,))
    connection.commit()

    service.ensure_fresh_target(full_path=target.as_posix(), refresh_window_minutes=0, index_depth=5)

    assert "iVBORw0KGgo" not in _body(connection)
    assert "受注から出荷までの流れ" in _body(connection)
    assert int(connection.execute("SELECT index_version FROM targets").fetchone()[0]) == CURRENT_TARGET_INDEX_VERSION

    # 版が最新になったあとは、変更の無いファイルを読み直さない
    connection.execute("UPDATE file_segments SET content = 'kept' WHERE segment_type = 'body'")
    connection.commit()
    service.ensure_fresh_target(full_path=target.as_posix(), refresh_window_minutes=0, index_depth=5)
    assert _body(connection) == "kept"
    connection.close()
