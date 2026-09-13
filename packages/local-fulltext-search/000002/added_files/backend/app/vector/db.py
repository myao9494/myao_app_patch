"""
ベクトルデータベース管理モジュール。
仕様:
- SQLite DBファイル（デフォルト: backend/data/vector_index_<model_name>.db）のテーブル定義（documents, chunks）をモデル別に独立管理する。
- ドキュメント情報およびチャンク情報の永続化、更新、削除を高速に行う。
- Embedding（BLOB）の格納と一括ロードをサポートする。
- チャンクIDから同一文書内の直前（prev）および直後（next）のチャンクを含む文脈情報を取得する。
- DBファイルサイズ、登録件数等の統計情報を集計する。
- モデル識別子の抽出（get_model_identifier）およびDBパスの解決（get_model_db_path）を提供する。
"""

import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import numpy as np

from app.config import settings


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
    db_file = target_dir / f"vector_index_{model_identifier}.db"
    return str(db_file.resolve())


def get_db_connection(db_path: str) -> sqlite3.Connection:
    """SQLiteコネクションを取得し、Rowファクトリ・外部キー・WALを設定する"""
    parent = Path(db_path).parent
    parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    return conn


def init_db(db_path: str) -> None:
    """テーブルおよびインデックスを初期化する"""
    with get_db_connection(db_path) as conn:
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
        conn.commit()


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
    import time
    now = time.time()
    with get_db_connection(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("""
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
        """, (path, title, mtime, size, sha256, text, embedding, now))
        row = cursor.fetchone()
        doc_id = row[0] if row else 0
        conn.commit()
        return doc_id


def insert_chunks(db_path: str, document_id: int, chunks_data: List[Dict[str, Any]]) -> None:
    """チャンクリストを一括登録する。既存チャンクは削除する"""
    with get_db_connection(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM chunks WHERE document_id = ?", (document_id,))
        if chunks_data:
            cursor.executemany("""
            INSERT INTO chunks (document_id, chunk_index, text, embedding, embedding_dim)
            VALUES (?, ?, ?, ?, ?)
            """, [
                (document_id, c["chunk_index"], c["text"], c["embedding"], c["embedding_dim"])
                for c in chunks_data
            ])
        conn.commit()


def delete_document(db_path: str, path: str) -> None:
    """指定パスのドキュメント（およびCASCADEでチャンク）を削除する"""
    with get_db_connection(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM documents WHERE path = ?", (path,))
        conn.commit()


def clear_all_data(db_path: str) -> None:
    """全ドキュメントおよび全チャンクを削除する"""
    with get_db_connection(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM chunks;")
        cursor.execute("DELETE FROM documents;")
        conn.commit()


def get_all_documents_metadata(db_path: str) -> Dict[str, Dict[str, Any]]:
    """差分比較用に全ドキュメントのメタデータ（path, mtime, size, sha256）を辞書で返す"""
    with get_db_connection(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, path, mtime, size, sha256 FROM documents")
        rows = cursor.fetchall()
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


def get_chunk_with_context(db_path: str, chunk_id: int) -> Optional[Dict[str, Any]]:
    """チャンクIDから、ヒットチャンクおよび同一文書内の直前・直後チャンクのテキストを取得する"""
    with get_db_connection(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("""
        SELECT c.id, c.document_id, c.chunk_index, c.text, d.path, d.title
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE c.id = ?
        """, (chunk_id,))
        row = cursor.fetchone()
        if not row:
            return None

        doc_id = row["document_id"]
        c_idx = row["chunk_index"]

        # 前のチャンク
        cursor.execute("""
        SELECT text FROM chunks
        WHERE document_id = ? AND chunk_index = ?
        """, (doc_id, c_idx - 1))
        prev_row = cursor.fetchone()

        # 次のチャンク
        cursor.execute("""
        SELECT text FROM chunks
        WHERE document_id = ? AND chunk_index = ?
        """, (doc_id, c_idx + 1))
        next_row = cursor.fetchone()

        return {
            "chunk_id": row["id"],
            "document_id": doc_id,
            "chunk_index": c_idx,
            "path": row["path"],
            "title": row["title"],
            "hit_text": row["text"],
            "prev_text": prev_row["text"] if prev_row else None,
            "next_text": next_row["text"] if next_row else None,
        }


def get_all_chunk_embeddings(db_path: str) -> Tuple[List[int], np.ndarray]:
    """FAISSインデックス構築用に全チャンクのIDとEmbedding行列を取得する"""
    with get_db_connection(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, embedding, embedding_dim FROM chunks ORDER BY id ASC")
        rows = cursor.fetchall()
        if not rows:
            return [], np.empty((0, 0), dtype=np.float32)

        ids = [r["id"] for r in rows]
        dim = rows[0]["embedding_dim"]
        emb_list = [np.frombuffer(r["embedding"], dtype=np.float32) for r in rows]
        return ids, np.vstack(emb_list)


def get_all_document_embeddings(db_path: str) -> Tuple[List[int], np.ndarray]:
    """FAISSインデックス構築用に全ドキュメントのIDとEmbedding行列を取得する"""
    with get_db_connection(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, embedding FROM documents WHERE embedding IS NOT NULL ORDER BY id ASC")
        rows = cursor.fetchall()
        if not rows:
            return [], np.empty((0, 0), dtype=np.float32)

        ids = [r["id"] for r in rows]
        emb_list = [np.frombuffer(r["embedding"], dtype=np.float32) for r in rows]
        return ids, np.vstack(emb_list)


def get_document_by_id(db_path: str, doc_id: int) -> Optional[Dict[str, Any]]:
    """IDからドキュメントを取得する"""
    with get_db_connection(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM documents WHERE id = ?", (doc_id,))
        row = cursor.fetchone()
        return dict(row) if row else None


def get_db_stats(db_path: str) -> Dict[str, Any]:
    """データベースの統計情報を取得する（未初期化DBでも安全に0件を返す）"""
    if not Path(db_path).exists():
        return {
            "document_count": 0,
            "chunk_count": 0,
            "db_size_bytes": 0,
            "db_size_mb": 0.0,
        }

    try:
        with get_db_connection(db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='documents'")
            if cursor.fetchone()[0] == 0:
                size_b = Path(db_path).stat().st_size
                return {
                    "document_count": 0,
                    "chunk_count": 0,
                    "db_size_bytes": size_b,
                    "db_size_mb": round(size_b / (1024 * 1024), 2),
                }

            cursor.execute("SELECT COUNT(*) FROM documents")
            doc_count = cursor.fetchone()[0]

            cursor.execute("SELECT COUNT(*) FROM chunks")
            chunk_count = cursor.fetchone()[0]

        size_bytes = Path(db_path).stat().st_size
        return {
            "document_count": doc_count,
            "chunk_count": chunk_count,
            "db_size_bytes": size_bytes,
            "db_size_mb": round(size_bytes / (1024 * 1024), 2),
        }
    except Exception:
        size_b = Path(db_path).stat().st_size if Path(db_path).exists() else 0
        return {
            "document_count": 0,
            "chunk_count": 0,
            "db_size_bytes": size_b,
            "db_size_mb": round(size_b / (1024 * 1024), 2),
        }
