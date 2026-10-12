"""
ベクトルインデックスの堅牢性（アトミック書き込み・失敗の再試行・削除候補の保護・接続の使い回し）の単体テスト。

仕様:
- 文書とチャンクは 1 トランザクションで保存し、途中失敗時に「チャンクの無い登録済み文書」を残さない。
- 1 ファイルの失敗で全体を止めず、失敗したファイルは次回の差分更新で再試行される。
- 到達不能な対象フォルダ配下の文書は、削除許可があっても削除候補にしない。
- 文書ベクトルとチャンクベクトルは 1 ファイルにつき 1 回のバッチ推論で生成する。
- 未初期化のベクトルDBに対する検索・統計取得は、例外ではなく 0 件として扱う。
"""

from pathlib import Path
import sqlite3

import numpy as np
import pytest

from app.vector import db as vector_db
from app.vector.embedder import MockEmbedder
from app.vector.indexer import VectorIndexManager
from app.vector.searcher import SearchMode, VectorSearcher


class CountingEmbedder(MockEmbedder):
    """推論呼び出し回数を記録するモック Embedder。"""

    def __init__(self, dim: int = 16) -> None:
        super().__init__(dim=dim, model_path="mock_model")
        self.single_calls = 0
        self.batch_calls = 0

    def encode(self, text: str, is_query: bool = False) -> np.ndarray:
        self.single_calls += 1
        return super().encode(text, is_query=is_query)

    def encode_batch(self, texts, is_query: bool = False, batch_size: int = 32) -> np.ndarray:
        self.batch_calls += 1
        return super().encode_batch(texts, is_query=is_query, batch_size=batch_size)


def _document_paths(db_path: str) -> set[str]:
    return set(vector_db.get_all_documents_metadata(db_path).keys())


def test_save_document_with_chunks_rolls_back_document_when_chunks_fail(tmp_path: Path) -> None:
    db_path = str(tmp_path / "vector.db")
    vector_db.init_db(db_path)
    broken_chunks = [{"chunk_index": 0, "text": "chunk without embedding"}]

    with vector_db.open_db(db_path) as conn:
        with pytest.raises(KeyError):
            vector_db.save_document_with_chunks(
                conn,
                path="/docs/a.md",
                title="a",
                mtime=1.0,
                size=10,
                sha256="hash",
                text="body",
                embedding=None,
                chunks_data=broken_chunks,
            )

    assert vector_db.get_all_documents_metadata(db_path) == {}
    assert vector_db.get_db_stats(db_path)["chunk_count"] == 0


def test_save_document_with_chunks_replaces_existing_chunks(tmp_path: Path) -> None:
    db_path = str(tmp_path / "vector.db")
    vector_db.init_db(db_path)
    vector = np.ones(4, dtype=np.float32).tobytes()

    def chunks(count: int) -> list[dict[str, object]]:
        return [{"chunk_index": i, "text": f"c{i}", "embedding": vector, "embedding_dim": 4} for i in range(count)]

    with vector_db.open_db(db_path) as conn:
        first_id = vector_db.save_document_with_chunks(
            conn, path="/docs/a.md", title="a", mtime=1.0, size=1, sha256="h1", text="t", embedding=vector,
            chunks_data=chunks(3),
        )
        second_id = vector_db.save_document_with_chunks(
            conn, path="/docs/a.md", title="a", mtime=2.0, size=2, sha256="h2", text="t2", embedding=vector,
            chunks_data=chunks(1),
        )

    assert first_id == second_id
    stats = vector_db.get_db_stats(db_path)
    assert stats["document_count"] == 1
    assert stats["chunk_count"] == 1
    assert vector_db.get_all_documents_metadata(db_path)["/docs/a.md"]["sha256"] == "h2"


def test_open_db_closes_connection_and_rolls_back_on_error(tmp_path: Path) -> None:
    db_path = str(tmp_path / "vector.db")
    vector_db.init_db(db_path)

    with pytest.raises(RuntimeError):
        with vector_db.open_db(db_path) as conn:
            conn.execute(
                "INSERT INTO documents (path, title, mtime, size, sha256) VALUES ('/x.md', 'x', 1, 1, 'h')"
            )
            raise RuntimeError("boom")

    assert vector_db.get_all_documents_metadata(db_path) == {}
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


def test_delete_documents_removes_only_given_paths_with_their_chunks(tmp_path: Path) -> None:
    db_path = str(tmp_path / "vector.db")
    vector_db.init_db(db_path)
    vector = np.ones(4, dtype=np.float32).tobytes()
    with vector_db.open_db(db_path) as conn:
        for name in ("a", "b", "c"):
            vector_db.save_document_with_chunks(
                conn, path=f"/docs/{name}.md", title=name, mtime=1.0, size=1, sha256=name, text=name,
                embedding=vector,
                chunks_data=[{"chunk_index": 0, "text": name, "embedding": vector, "embedding_dim": 4}],
            )

    deleted = vector_db.delete_documents(db_path, ["/docs/a.md", "/docs/c.md", "/docs/missing.md"])

    assert deleted == 2
    assert _document_paths(db_path) == {"/docs/b.md"}
    assert vector_db.get_db_stats(db_path)["chunk_count"] == 1
    assert vector_db.delete_documents(db_path, []) == 0


def test_get_chunks_with_context_returns_neighbors_for_each_chunk(tmp_path: Path) -> None:
    db_path = str(tmp_path / "vector.db")
    vector_db.init_db(db_path)
    vector = np.ones(4, dtype=np.float32).tobytes()
    with vector_db.open_db(db_path) as conn:
        vector_db.save_document_with_chunks(
            conn, path="/docs/a.md", title="a", mtime=1.0, size=1, sha256="h", text="t", embedding=vector,
            chunks_data=[
                {"chunk_index": i, "text": f"chunk-{i}", "embedding": vector, "embedding_dim": 4} for i in range(3)
            ],
        )
        chunk_ids = [int(row["id"]) for row in conn.execute("SELECT id FROM chunks ORDER BY chunk_index")]

    contexts = vector_db.get_chunks_with_context(db_path, [*chunk_ids, 9999])

    assert set(contexts) == set(chunk_ids)
    assert contexts[chunk_ids[0]]["prev_text"] is None
    assert contexts[chunk_ids[0]]["next_text"] == "chunk-1"
    assert contexts[chunk_ids[1]]["prev_text"] == "chunk-0"
    assert contexts[chunk_ids[1]]["hit_text"] == "chunk-1"
    assert contexts[chunk_ids[2]]["next_text"] is None
    assert contexts[chunk_ids[1]] == vector_db.get_chunk_with_context(db_path, chunk_ids[1])
    assert vector_db.get_chunks_with_context(db_path, []) == {}


def test_uninitialized_vector_db_is_treated_as_empty(tmp_path: Path) -> None:
    db_path = str(tmp_path / "empty.db")
    sqlite3.connect(db_path).close()

    ids, vectors = vector_db.get_all_chunk_embeddings(db_path)
    searcher = VectorSearcher(db_path=db_path, embedder=MockEmbedder(dim=8))

    assert ids == []
    assert vectors.shape[0] == 0
    assert vector_db.get_all_documents_metadata(db_path) == {}
    assert vector_db.get_db_stats(db_path)["document_count"] == 0
    assert searcher.search("anything").results == []
    assert searcher.search("anything", mode=SearchMode.DOCUMENT).results == []


def test_index_all_uses_one_batch_inference_per_file(tmp_path: Path) -> None:
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "a.md").write_text("# Title\n\n本文 A", encoding="utf-8")
    (folder / "b.txt").write_text("plain text B", encoding="utf-8")
    embedder = CountingEmbedder()
    manager = VectorIndexManager([str(folder)], str(tmp_path / "vector.db"), embedder=embedder)

    result = manager.index_all()

    assert result.new_count == 2
    assert embedder.batch_calls == 2
    assert embedder.single_calls == 0
    ids, vectors = vector_db.get_all_document_embeddings(manager.db_path)
    assert len(ids) == 2
    assert vectors.shape == (2, embedder.embedding_dim)


def test_document_embedding_matches_single_encoding_of_leading_text(tmp_path: Path) -> None:
    """バッチ化しても、文書ベクトルは本文先頭 1000 文字を単独で推論した結果と一致する。"""
    folder = tmp_path / "docs"
    folder.mkdir()
    body = "あ" * 1500
    (folder / "long.txt").write_text(body, encoding="utf-8")
    embedder = MockEmbedder(dim=16, model_path="mock_model")
    manager = VectorIndexManager([str(folder)], str(tmp_path / "vector.db"), embedder=embedder)

    manager.index_all()

    _, vectors = vector_db.get_all_document_embeddings(manager.db_path)
    np.testing.assert_array_equal(vectors[0], embedder.encode(body[:1000]))


def test_index_all_continues_after_failure_and_retries_failed_file_next_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    folder = tmp_path / "docs"
    folder.mkdir()
    good = folder / "good.md"
    bad = folder / "bad.md"
    good.write_text("good", encoding="utf-8")
    bad.write_text("bad", encoding="utf-8")
    manager = VectorIndexManager([str(folder)], str(tmp_path / "vector.db"), embedder=MockEmbedder(dim=16))
    original = manager._process_file_chunks

    def failing_process(file_path: Path):
        if file_path.name == "bad.md":
            raise RuntimeError("extraction exploded")
        return original(file_path)

    monkeypatch.setattr(manager, "_process_file_chunks", failing_process)
    with caplog.at_level("WARNING", logger="app.vector.indexer"):
        first = manager.index_all()

    assert first.new_count == 1
    assert _document_paths(manager.db_path) == {str(good.resolve())}
    assert "bad.md" in caplog.text
    assert "extraction exploded" in caplog.text

    monkeypatch.setattr(manager, "_process_file_chunks", original)
    second = manager.index_all()

    assert second.new_count == 1
    assert second.skipped_count == 1
    assert _document_paths(manager.db_path) == {str(good.resolve()), str(bad.resolve())}


def test_deletion_candidates_exclude_documents_under_unreachable_target_folder(tmp_path: Path) -> None:
    mounted = tmp_path / "mounted"
    network = tmp_path / "network_drive"
    mounted.mkdir()
    network.mkdir()
    kept = mounted / "kept.md"
    removed = mounted / "removed.md"
    remote = network / "remote.md"
    for path in (kept, removed, remote):
        path.write_text(path.stem, encoding="utf-8")
    db_path = str(tmp_path / "vector.db")
    embedder = MockEmbedder(dim=16)
    VectorIndexManager([str(mounted), str(network)], db_path, embedder=embedder).index_all()

    # mounted 内のファイルは実際に削除され、network は「接続が切れて見えなくなった」状態にする
    removed.unlink()
    remote.unlink()
    network.rmdir()
    manager = VectorIndexManager([str(mounted), str(network)], db_path, embedder=embedder)

    assert manager.get_pending_deletions() == [str(removed.resolve())]

    result = manager.index_all(clean_deleted_files=True)

    assert result.deleted_count == 1
    assert _document_paths(db_path) == {str(kept.resolve()), str(remote.resolve())}
