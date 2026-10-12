"""
ベクトルデータベース管理モジュール。
仕様:
- SQLite DBファイル（デフォルト: backend/data/vector_index_<model_name>.db）のテーブル定義（documents, chunks）をモデル別に独立管理する。
- ドキュメント情報およびチャンク情報の永続化、更新、削除を高速に行う。
- ドキュメントとそのチャンクは 1 トランザクションで書き込み、途中失敗で「チャンクの無い文書」が残らないようにする。
- 各関数は処理ごとに接続を開いて必ず閉じる。連続処理では open_db() の接続を使い回して接続コストを避ける。
- Embedding（BLOB）の格納と一括ロードをサポートする。
- チャンクIDから同一文書内の直前（prev）および直後（next）のチャンクを含む文脈情報を取得する。
- DBファイルサイズ、登録件数等の統計情報を集計する。
- モデル識別子の抽出（get_model_identifier）およびDBパスの解決（get_model_db_path）を提供する。
"""

import re
import sqlite3
import time
from collections.abc import Iterable, Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import numpy as np

from app.config import settings

VECTOR_DB_FILE_PREFIX = "vector_index_"
_SQLITE_IN_CHUNK_SIZE = 500


def get_model_identifier(model_path: Optional[str] = None, embedder: Optional[Any] = None) -> str:
    """モデルパスまたはEmbedderインスタンスから安全な識別子文字列を生成する"""
    target_path = ""
    if model_path:
        target_path = str(model_path)
    elif embedder and getattr(embedder, "model_path", None):
        target_path = str(embedder.model_path)

    if not target_path:
        return "default"

    clean_name = Path(target_path).name.strip()
    clean_name = re.sub(r"[^\w\-.]", "_", clean_name)
    return clean_name or "default"


def get_model_db_path(model_identifier: str = "default", data_dir: Optional[Path] = None) -> str:
    """モデル識別子に応じた SQLite DB の絶対パスを返す"""
    target_dir = data_dir or settings.data_dir
    target_dir.mkdir(parents=True, exist_ok=True)
    db_file = target_dir / f"{VECTOR_DB_FILE_PREFIX}{model_identifier}.db"
    return str(db_file.resolve())


def list_vector_db_paths(data_dir: Optional[Path] = None) -> List[str]:
    """データディレクトリ内の全モデル分のベクトルDBパスを返す"""
    target_dir = data_dir or settings.data_dir
    if not target_dir.is_dir():
        return []
    return sorted(str(path.resolve()) for path in target_dir.glob(f"{VECTOR_DB_FILE_PREFIX}*.db"))


def get_db_connection(db_path: str) -> sqlite3.Connection:
    """SQLiteコネクションを取得し、Rowファクトリ・外部キー・WALを設定する（呼び出し側が close する）"""
    parent = Path(db_path).parent
    parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    return conn


@contextmanager
def open_db(db_path: str) -> Iterator[sqlite3.Connection]:
    """
    接続を開き、正常終了時は commit、例外時は rollback したうえで必ず close する。
    （sqlite3.Connection 自体の with 文は commit / rollback だけで接続を閉じないため、こちらを使う）
    """
    conn = get_db_connection(db_path)
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def _has_table(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", (table_name,)
    ).fetchone()
    return bool(row[0])


def init_db(db_path: str) -> None:
    """テーブルおよびインデックスを初期化する"""
    with open_db(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL,
            title TEXT,
            mtime REAL NOT NULL,
            size INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            text TEXT,
            embedding BLOB,
            indexed_at REAL
        );
        """)
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            text TEXT NOT NULL,
            embedding BLOB NOT NULL,
            embedding_dim INTEGER NOT NULL,
            FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
        );
        """)
        cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_chunks_document
        ON chunks(document_id);
        """)


def _upsert_document_row(
    conn: sqlite3.Connection,
    *,
    path: str,
    title: str,
    mtime: float,
    size: int,
    sha256: str,
    text: Optional[str],
    embedding: Optional[bytes],
) -> int:
    row = conn.execute(
        """
        INSERT INTO documents (path, title, mtime, size, sha256, text, embedding, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            title = excluded.title,
            mtime = excluded.mtime,
            size = excluded.size,
            sha256 = excluded.sha256,
            text = excluded.text,
            embedding = excluded.embedding,
            indexed_at = excluded.indexed_at
        RETURNING id;
        """,
        (path, title, mtime, size, sha256, text, embedding, time.time()),
    ).fetchone()
    return int(row[0]) if row else 0


def _replace_chunk_rows(conn: sqlite3.Connection, document_id: int, chunks_data: Sequence[Dict[str, Any]]) -> None:
    conn.execute("DELETE FROM chunks WHERE document_id = ?", (document_id,))
    if chunks_data:
        conn.executemany(
            """
            INSERT INTO chunks (document_id, chunk_index, text, embedding, embedding_dim)
            VALUES (?, ?, ?, ?, ?)
            """,
            [(document_id, c["chunk_index"], c["text"], c["embedding"], c["embedding_dim"]) for c in chunks_data],
        )


def save_document_with_chunks(
    conn: sqlite3.Connection,
    *,
    path: str,
    title: str,
    mtime: float,
    size: int,
    sha256: str,
    text: Optional[str],
    embedding: Optional[bytes],
    chunks_data: Sequence[Dict[str, Any]],
) -> int:
    """
    ドキュメントとそのチャンクを 1 トランザクションで登録し、document_id を返す。
    途中で失敗した場合はロールバックし、差分判定で「登録済み」と誤認される中途半端な文書を残さない。
    """
    try:
        document_id = _upsert_document_row(
            conn, path=path, title=title, mtime=mtime, size=size, sha256=sha256, text=text, embedding=embedding
        )
        _replace_chunk_rows(conn, document_id, chunks_data)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    return document_id


def upsert_document(
    db_path: str,
    path: str,
    title: str,
    mtime: float,
    size: int,
    sha256: str,
    text: Optional[str] = None,
    embedding: Optional[bytes] = None,
) -> int:
    """ドキュメントを挿入または更新し、document_id を返す"""
    with open_db(db_path) as conn:
        return _upsert_document_row(
            conn, path=path, title=title, mtime=mtime, size=size, sha256=sha256, text=text, embedding=embedding
        )


def insert_chunks(db_path: str, document_id: int, chunks_data: List[Dict[str, Any]]) -> None:
    """チャンクリストを一括登録する。既存チャンクは削除する"""
    with open_db(db_path) as conn:
        _replace_chunk_rows(conn, document_id, chunks_data)


def delete_document(db_path: str, path: str) -> None:
    """指定パスのドキュメント（およびCASCADEでチャンク）を削除する"""
    delete_documents(db_path, [path])


def delete_documents(db_path: str, paths: Iterable[str]) -> int:
    """指定パス群のドキュメント（およびCASCADEでチャンク）を 1 接続でまとめて削除し、削除件数を返す"""
    target_paths = list(paths)
    if not target_paths:
        return 0
    deleted_count = 0
    with open_db(db_path) as conn:
        for start in range(0, len(target_paths), _SQLITE_IN_CHUNK_SIZE):
            chunk = target_paths[start : start + _SQLITE_IN_CHUNK_SIZE]
            placeholders = ",".join("?" * len(chunk))
            cursor = conn.execute(f"DELETE FROM documents WHERE path IN ({placeholders})", chunk)
            deleted_count += int(cursor.rowcount or 0)
    return deleted_count


def clear_all_data(db_path: str) -> None:
    """全ドキュメントおよび全チャンクを削除する"""
    with open_db(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM chunks;")
        cursor.execute("DELETE FROM documents;")


def get_all_documents_metadata(db_path: str) -> Dict[str, Dict[str, Any]]:
    """差分比較用に全ドキュメントのメタデータ（path, mtime, size, sha256）を辞書で返す"""
    with open_db(db_path) as conn:
        if not _has_table(conn, "documents"):
            return {}
        rows = conn.execute("SELECT id, path, mtime, size, sha256 FROM documents").fetchall()
        return {
            row["path"]: {
                "id": row["id"],
                "path": row["path"],
                "mtime": row["mtime"],
                "size": row["size"],
                "sha256": row["sha256"],
            }
            for row in rows
        }


def _fetch_chunk_with_context(conn: sqlite3.Connection, chunk_id: int) -> Optional[Dict[str, Any]]:
    row = conn.execute(
        """
        SELECT c.id, c.document_id, c.chunk_index, c.text, d.path, d.title
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE c.id = ?
        """,
        (chunk_id,),
    ).fetchone()
    if not row:
        return None

    doc_id = row["document_id"]
    c_idx = row["chunk_index"]
    neighbor_rows = conn.execute(
        """
        SELECT chunk_index, text FROM chunks
        WHERE document_id = ? AND chunk_index IN (?, ?)
        """,
        (doc_id, c_idx - 1, c_idx + 1),
    ).fetchall()
    neighbors = {int(r["chunk_index"]): r["text"] for r in neighbor_rows}

    return {
        "chunk_id": row["id"],
        "document_id": doc_id,
        "chunk_index": c_idx,
        "path": row["path"],
        "title": row["title"],
        "hit_text": row["text"],
        "prev_text": neighbors.get(c_idx - 1),
        "next_text": neighbors.get(c_idx + 1),
    }


def get_chunk_with_context(db_path: str, chunk_id: int) -> Optional[Dict[str, Any]]:
    """チャンクIDから、ヒットチャンクおよび同一文書内の直前・直後チャンクのテキストを取得する"""
    with open_db(db_path) as conn:
        return _fetch_chunk_with_context(conn, chunk_id)


def get_chunks_with_context(db_path: str, chunk_ids: Sequence[int]) -> Dict[int, Dict[str, Any]]:
    """複数チャンクの文脈情報を 1 接続でまとめて取得する（存在しない ID は結果に含めない）"""
    if not chunk_ids:
        return {}
    contexts: Dict[int, Dict[str, Any]] = {}
    with open_db(db_path) as conn:
        for chunk_id in chunk_ids:
            context = _fetch_chunk_with_context(conn, int(chunk_id))
            if context is not None:
                contexts[int(chunk_id)] = context
    return contexts


def get_all_chunk_embeddings(db_path: str) -> Tuple[List[int], np.ndarray]:
    """FAISSインデックス構築用に全チャンクのIDとEmbedding行列を取得する（未初期化DBは 0 件として扱う）"""
    with open_db(db_path) as conn:
        if not _has_table(conn, "chunks"):
            return [], np.empty((0, 0), dtype=np.float32)
        rows = conn.execute("SELECT id, embedding FROM chunks ORDER BY id ASC").fetchall()
        if not rows:
            return [], np.empty((0, 0), dtype=np.float32)

        ids = [r["id"] for r in rows]
        emb_list = [np.frombuffer(r["embedding"], dtype=np.float32) for r in rows]
        return ids, np.vstack(emb_list)


def get_all_document_embeddings(db_path: str) -> Tuple[List[int], np.ndarray]:
    """FAISSインデックス構築用に全ドキュメントのIDとEmbedding行列を取得する（未初期化DBは 0 件として扱う）"""
    with open_db(db_path) as conn:
        if not _has_table(conn, "documents"):
            return [], np.empty((0, 0), dtype=np.float32)
        rows = conn.execute("SELECT id, embedding FROM documents WHERE embedding IS NOT NULL ORDER BY id ASC").fetchall()
        if not rows:
            return [], np.empty((0, 0), dtype=np.float32)

        ids = [r["id"] for r in rows]
        emb_list = [np.frombuffer(r["embedding"], dtype=np.float32) for r in rows]
        return ids, np.vstack(emb_list)


def get_document_by_id(db_path: str, doc_id: int) -> Optional[Dict[str, Any]]:
    """IDからドキュメントを取得する"""
    with open_db(db_path) as conn:
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
        return dict(row) if row else None


def get_documents_by_ids(db_path: str, doc_ids: Sequence[int]) -> Dict[int, Dict[str, Any]]:
    """複数ドキュメントを 1 接続でまとめて取得する（存在しない ID は結果に含めない）"""
    documents: Dict[int, Dict[str, Any]] = {}
    target_ids = [int(doc_id) for doc_id in doc_ids]
    if not target_ids:
        return documents
    with open_db(db_path) as conn:
        for start in range(0, len(target_ids), _SQLITE_IN_CHUNK_SIZE):
            chunk = target_ids[start : start + _SQLITE_IN_CHUNK_SIZE]
            placeholders = ",".join("?" * len(chunk))
            for row in conn.execute(f"SELECT * FROM documents WHERE id IN ({placeholders})", chunk):
                documents[int(row["id"])] = dict(row)
    return documents


def get_db_stats(db_path: str) -> Dict[str, Any]:
    """データベースの統計情報を取得する（未作成・未初期化・破損DBでも安全に0件を返す）"""
    db_file = Path(db_path)
    if not db_file.exists():
        return {"document_count": 0, "chunk_count": 0, "db_size_bytes": 0, "db_size_mb": 0.0}

    document_count = 0
    chunk_count = 0
    try:
        with open_db(db_path) as conn:
            if _has_table(conn, "documents"):
                document_count = int(conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0])
                chunk_count = int(conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0])
    except sqlite3.Error:
        document_count = 0
        chunk_count = 0

    size_bytes = db_file.stat().st_size if db_file.exists() else 0
    return {
        "document_count": document_count,
        "chunk_count": chunk_count,
        "db_size_bytes": size_bytes,
        "db_size_mb": round(size_bytes / (1024 * 1024), 2),
    }
