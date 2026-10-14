"""
DB 保守（空き領域の回収）の単体テスト。

仕様:
- 全文検索DBの圧縮は、削除済みデータが占めていた領域を回収し、残っているデータと検索結果を変えない。
- インデックス実行中の DB には実行しない。
- ベクトルDBの圧縮は、文書・チャンクを変えずに空き領域だけを回収する。
"""

from pathlib import Path
import sqlite3

import numpy as np
import pytest

from app.db.maintenance import DatabaseBusyError, compact_search_database, compact_vector_database
from app.db.schema import initialize_schema
from app.models.search import SearchQueryParams
from app.services.search_service import SearchService
from app.vector import db as vector_db


def _open(db_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON;")
    return connection


def test_compact_search_database_reclaims_space_and_keeps_search_results(tmp_path: Path) -> None:
    db_path = tmp_path / "search.db"
    connection = _open(db_path)
    initialize_schema(connection)
    service = SearchService(connection=connection)
    kept = tmp_path / "kept"
    removed = tmp_path / "removed"
    kept.mkdir()
    removed.mkdir()
    (kept / "keep.md").write_text("apple pie recipe", encoding="utf-8")
    for index in range(60):
        (removed / f"bulk_{index}.md").write_text(f"filler {index} " + "lorem ipsum dolor " * 400, encoding="utf-8")
    for folder in (kept, removed):
        service.index_service.add_search_target(folder_path=folder.as_posix(), index_depth=5)
    service.index_service.reindex_search_targets([kept.as_posix(), removed.as_posix()])
    service.index_service.delete_indexed_targets([removed.as_posix()])
    connection.execute("UPDATE files SET click_count = 3 WHERE file_name = 'keep.md'")
    connection.commit()
    before = service.search(SearchQueryParams(q="apple", search_all_enabled=True))
    connection.close()

    result = compact_search_database(db_path)

    assert result.size_after < result.size_before
    assert result.reclaimed_bytes == result.size_before - result.size_after
    assert db_path.stat().st_size == result.size_after
    connection = _open(db_path)
    try:
        after = SearchService(connection=connection).search(SearchQueryParams(q="apple", search_all_enabled=True))
        assert [item.full_path for item in after.items] == [item.full_path for item in before.items]
        assert [item.click_count for item in after.items] == [3]
        assert SearchService(connection=connection).search(
            SearchQueryParams(q="lorem", search_all_enabled=True)
        ).items == []
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        connection.close()


def test_compact_search_database_refuses_while_indexing_is_running(tmp_path: Path) -> None:
    db_path = tmp_path / "search.db"
    connection = _open(db_path)
    initialize_schema(connection)
    connection.execute("UPDATE index_runs SET is_running = 1 WHERE id = 1")
    connection.commit()
    connection.close()

    with pytest.raises(DatabaseBusyError):
        compact_search_database(db_path)


def test_compact_vector_database_reclaims_space_and_keeps_documents(tmp_path: Path) -> None:
    db_path = str(tmp_path / "vector.db")
    vector_db.init_db(db_path)
    vector = np.ones(256, dtype=np.float32).tobytes()
    with vector_db.open_db(db_path) as conn:
        for index in range(200):
            vector_db.save_document_with_chunks(
                conn, path=f"/docs/{index}.md", title=str(index), mtime=1.0, size=1, sha256=str(index),
                text="body " * 200, embedding=vector,
                chunks_data=[{"chunk_index": 0, "text": "chunk", "embedding": vector, "embedding_dim": 256}],
            )
    vector_db.delete_documents(db_path, [f"/docs/{index}.md" for index in range(1, 200)])

    result = compact_vector_database(db_path)

    assert result.size_after < result.size_before
    assert set(vector_db.get_all_documents_metadata(db_path)) == {"/docs/0.md"}
    assert vector_db.get_db_stats(db_path)["chunk_count"] == 1
