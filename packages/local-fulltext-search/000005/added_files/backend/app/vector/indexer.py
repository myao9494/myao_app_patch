"""
ベクトルインデックス管理モジュール (VectorIndexManager)
仕様:
- 指定された全フォルダー（または targets テーブルの登録フォルダー）を再帰走査し、
  全選択拡張子のファイルを対象に差分インデックスを作成する。
- Markdownファイルは chunk_markdown で見出しパンくず・メタデータ保持・描画データ除去を行い、
  Office/PDF/TXT/JSON等の本文抽出可能ファイルは extract_text ＋ chunk_text で分割。
  画像や音声等の本文なしファイルはファイル名をチャンクテキストとしてベクトル化する。
- path, mtime, size, sha256 による高速差分検知（変更なしはEmbeddingスキップ）。
- 除外キーワード（絶対パス・フォルダ名・単語境界）による厳格な走査除外。
- 削除または除外されたファイルのレコードをクリーンアップ。
- 進捗コールバック（処理件数/全件数、残り時間推定等）および単一ファイル差分更新機能を提供。
"""

import hashlib
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Set

from app.extractors.text_extractor import (
    CONTENT_EXTENSIONS,
    FILENAME_ONLY_EXTENSIONS,
    SUPPORTED_EXTENSIONS,
    extract_text,
    get_content_extensions,
    resolve_supported_extension,
)
from app.vector.chunker import chunk_markdown, chunk_text
from app.vector.db import (
    clear_all_data,
    delete_document,
    get_all_documents_metadata,
    init_db,
    insert_chunks,
    upsert_document,
)
from app.vector.dictionary import GlossaryDictionary
from app.vector.embedder import BaseEmbedder


@dataclass
class SingleFileUpdateResult:
    """単一ファイル差分更新およびプロファイリング結果"""
    relative_path: str
    status: str  # "created", "updated", "skipped", "deleted", "error"
    chunk_count: int
    io_hash_time_ms: float
    chunking_time_ms: float
    embedding_time_ms: float
    db_time_ms: float
    total_time_ms: float
    error_message: Optional[str] = None


@dataclass
class IndexProgress:
    """インデックス進捗情報"""
    processed_files: int
    total_files: int
    progress_pct: float
    current_file: str
    elapsed_sec: float
    estimated_remaining_sec: float


@dataclass
class IndexResult:
    """インデックス完了結果サマリー"""
    total_files: int
    new_count: int
    updated_count: int
    skipped_count: int
    deleted_count: int
    document_count: int
    chunk_count: int
    indexing_time_sec: float
    embedding_time_sec: float
    db_size_mb: float


def calc_sha256(path: Path) -> str:
    """ファイルのSHA-256ハッシュを計算する"""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


class VectorIndexManager:
    """ベクトルインデックスの作成・差分更新を統括するマネージャー"""

    def __init__(
        self,
        target_folders: List[str],
        db_path: str,
        embedder: Optional[BaseEmbedder] = None,
        glossary: Optional[GlossaryDictionary] = None,
        chunk_size: int = 500,
        chunk_overlap: int = 80,
        exclude_keywords: str = "",
        selected_extensions: Optional[Sequence[str]] = None,
        custom_content_extensions: Sequence[str] = (),
        custom_filename_extensions: Sequence[str] = (),
    ):
        self.target_folders = [str(Path(p).resolve()) for p in target_folders]
        self.db_path = str(Path(db_path).resolve())
        self.embedder = embedder
        self.glossary = glossary
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.exclude_keywords = exclude_keywords
        self.selected_extensions = selected_extensions
        self.selected_set = {ext.lower().strip() for ext in selected_extensions if ext.strip()} if selected_extensions is not None else None
        self.custom_content_extensions = tuple(ext.lower().strip() for ext in custom_content_extensions if ext.strip())
        self.custom_filename_extensions = tuple(ext.lower().strip() for ext in custom_filename_extensions if ext.strip())
        init_db(self.db_path)

    def scan_files(self) -> List[Path]:
        """登録フォルダ以下の対象ファイルを収集する"""
        import re
        from app.services.index_service import IndexService

        collected: List[Path] = []
        seen_paths: Set[str] = set()
        raw_keywords = [k.strip() for k in re.split(r"[\r\n,]+", self.exclude_keywords) if k.strip()]
        idx_helper = IndexService(connection=None)
        keyword_set, non_ascii_keywords, excluded_path_prefixes = idx_helper._compile_exclude_keywords(raw_keywords)

        for folder_str in self.target_folders:
            folder_path = Path(folder_str)
            if not folder_path.exists():
                continue

            for root, dirs, files in os.walk(folder_path):
                # 隠しフォルダや除外キーワードのディレクトリを除外
                dirs[:] = [
                    d for d in dirs
                    if not d.startswith(".")
                    and d not in {"node_modules", "__pycache__", "dist", "build"}
                    and not idx_helper._is_excluded_name(d, keyword_set, non_ascii_keywords)
                    and not idx_helper._is_excluded_path_prefix(
                        (Path(root) / d).as_posix(), excluded_path_prefixes
                    )
                ]
                for file_name in files:
                    if file_name.startswith("."):
                        continue
                    if idx_helper._is_excluded_name(file_name, keyword_set, non_ascii_keywords):
                        continue
                    file_path = Path(root) / file_name
                    if idx_helper._is_excluded_path_prefix(file_path.as_posix(), excluded_path_prefixes):
                        continue
                    ext = resolve_supported_extension(
                        file_path,
                        extra_content_extensions=self.custom_content_extensions,
                        extra_filename_extensions=self.custom_filename_extensions,
                    )
                    if ext is not None:
                        if self.selected_set is not None and ext not in self.selected_set:
                            continue
                        abs_posix = file_path.resolve().as_posix()
                        if abs_posix not in seen_paths:
                            seen_paths.add(abs_posix)
                            collected.append(file_path)

        return collected


    def index_all(
        self,
        force_reindex: bool = False,
        progress_callback: Optional[Callable[[IndexProgress], None]] = None,
    ) -> IndexResult:
        """全対象フォルダを走査して差分または全件インデックスを作成する"""
        start_time = time.perf_counter()
        embedding_total_sec = 0.0

        if force_reindex:
            clear_all_data(self.db_path)
            existing_meta: Dict[str, Dict[str, Any]] = {}
        else:
            existing_meta = get_all_documents_metadata(self.db_path)

        all_files = self.scan_files()
        total_files = len(all_files)

        new_count = 0
        updated_count = 0
        skipped_count = 0
        deleted_count = 0
        current_seen_paths: Set[str] = set()

        for idx, file_path in enumerate(all_files, start=1):
            abs_path = str(file_path.resolve())
            current_seen_paths.add(abs_path)

            if progress_callback:
                elapsed = time.perf_counter() - start_time
                pct = round((idx / total_files) * 100, 1) if total_files > 0 else 100.0
                rem = (elapsed / idx) * (total_files - idx) if idx > 0 else 0.0
                progress_callback(IndexProgress(
                    processed_files=idx,
                    total_files=total_files,
                    progress_pct=pct,
                    current_file=file_path.name,
                    elapsed_sec=round(elapsed, 1),
                    estimated_remaining_sec=round(rem, 1),
                ))

            try:
                stat = file_path.stat()
                mtime = stat.st_mtime
                size = stat.st_size

                # 差分判定
                meta = existing_meta.get(abs_path)
                if meta and not force_reindex:
                    if meta["mtime"] == mtime and meta["size"] == size:
                        skipped_count += 1
                        continue
                    sha = calc_sha256(file_path)
                    if meta["sha256"] == sha:
                        skipped_count += 1
                        continue
                else:
                    sha = calc_sha256(file_path)

                # テキスト抽出 & チャンキング
                t_emb_start = time.perf_counter()
                chunks, full_text = self._process_file_chunks(file_path)
                
                # Embedding生成
                doc_vec_bytes: Optional[bytes] = None
                chunks_data = []

                if self.embedder:
                    dim = self.embedder.embedding_dim
                    # ドキュメント単位ベクトル
                    if full_text:
                        doc_vec = self.embedder.encode(full_text[:1000], is_query=False)
                        doc_vec_bytes = doc_vec.tobytes()

                    # チャンク単位ベクトル
                    if chunks:
                        chunk_texts = [c.text for c in chunks]
                        chunk_vecs = self.embedder.encode_batch(chunk_texts, is_query=False)
                        for c, v in zip(chunks, chunk_vecs):
                            chunks_data.append({
                                "chunk_index": c.chunk_index,
                                "text": c.text,
                                "embedding": v.tobytes(),
                                "embedding_dim": dim,
                            })
                embedding_total_sec += (time.perf_counter() - t_emb_start)

                # DB登録
                title = file_path.stem
                doc_id = upsert_document(
                    self.db_path,
                    path=abs_path,
                    title=title,
                    mtime=mtime,
                    size=size,
                    sha256=sha,
                    text=full_text,
                    embedding=doc_vec_bytes,
                )
                insert_chunks(self.db_path, doc_id, chunks_data)

                if meta:
                    updated_count += 1
                else:
                    new_count += 1

            except Exception:
                continue

        # 削除されたファイルのクリーンアップ
        for old_path in existing_meta.keys():
            if old_path not in current_seen_paths:
                delete_document(self.db_path, old_path)
                deleted_count += 1

        # 完了統計の集計
        from app.vector.db import get_db_stats
        db_stats = get_db_stats(self.db_path)
        total_time_sec = time.perf_counter() - start_time

        return IndexResult(
            total_files=total_files,
            new_count=new_count,
            updated_count=updated_count,
            skipped_count=skipped_count,
            deleted_count=deleted_count,
            document_count=db_stats["document_count"],
            chunk_count=db_stats["chunk_count"],
            indexing_time_sec=round(total_time_sec, 2),
            embedding_time_sec=round(embedding_total_sec, 2),
            db_size_mb=db_stats["db_size_mb"],
        )

    def _process_file_chunks(self, file_path: Path):
        """ファイル形式に応じたテキスト抽出およびチャンキング"""
        ext = resolve_supported_extension(
            file_path,
            extra_content_extensions=self.custom_content_extensions,
            extra_filename_extensions=self.custom_filename_extensions,
        )
        if ext in {".md", ".excalidraw.md"}:
            try:
                raw = file_path.read_text(encoding="utf-8", errors="ignore")
                chunks = chunk_markdown(
                    raw,
                    chunk_size=self.chunk_size,
                    chunk_overlap=self.chunk_overlap,
                    glossary=self.glossary,
                )
                return chunks, raw
            except Exception:
                pass

        # 本文抽出可能ファイル
        content_exts = get_content_extensions(extra_content_extensions=self.custom_content_extensions)
        if ext in content_exts:
            try:
                text = extract_text(
                    file_path,
                    extra_content_extensions=self.custom_content_extensions,
                    extra_filename_extensions=self.custom_filename_extensions,
                )
                if text:
                    chunks = chunk_text(
                        text,
                        chunk_size=self.chunk_size,
                        chunk_overlap=self.chunk_overlap,
                        header_prefix=f"[{file_path.name}]",
                    )
                    return chunks, text
            except Exception:
                pass

        # ファイル名のみ（画像、音声等）またはテキストが空の場合
        fn_text = f"ファイル名: {file_path.name}\nパス: {file_path.as_posix()}"
        chunks = chunk_text(fn_text, chunk_size=self.chunk_size)
        return chunks, fn_text

    def update_single_file(self, file_path_str: str) -> SingleFileUpdateResult:
        """単一ファイルを差分更新する"""
        t0 = time.perf_counter()
        path = Path(file_path_str).resolve()
        if not path.exists():
            delete_document(self.db_path, str(path))
            t_tot = (time.perf_counter() - t0) * 1000
            return SingleFileUpdateResult(
                relative_path=path.name,
                status="deleted",
                chunk_count=0,
                io_hash_time_ms=0.0,
                chunking_time_ms=0.0,
                embedding_time_ms=0.0,
                db_time_ms=0.0,
                total_time_ms=round(t_tot, 2),
            )

        # 選択拡張子のチェック
        ext = resolve_supported_extension(
            path,
            extra_content_extensions=self.custom_content_extensions,
            extra_filename_extensions=self.custom_filename_extensions,
        )
        if ext is None or (self.selected_set is not None and ext not in self.selected_set):
            delete_document(self.db_path, str(path))
            t_tot = (time.perf_counter() - t0) * 1000
            return SingleFileUpdateResult(
                relative_path=path.name,
                status="skipped",
                chunk_count=0,
                io_hash_time_ms=0.0,
                chunking_time_ms=0.0,
                embedding_time_ms=0.0,
                db_time_ms=0.0,
                total_time_ms=round(t_tot, 2),
            )

        stat = path.stat()
        mtime = stat.st_mtime
        size = stat.st_size

        existing = get_all_documents_metadata(self.db_path).get(str(path))
        t_io0 = time.perf_counter()
        sha = calc_sha256(path)
        t_io = (time.perf_counter() - t_io0) * 1000

        if existing and existing["mtime"] == mtime and existing["sha256"] == sha:
            t_tot = (time.perf_counter() - t0) * 1000
            return SingleFileUpdateResult(
                relative_path=path.name,
                status="skipped",
                chunk_count=0,
                io_hash_time_ms=round(t_io, 2),
                chunking_time_ms=0.0,
                embedding_time_ms=0.0,
                db_time_ms=0.0,
                total_time_ms=round(t_tot, 2),
            )

        t_ch0 = time.perf_counter()
        chunks, full_text = self._process_file_chunks(path)
        t_ch = (time.perf_counter() - t_ch0) * 1000

        t_emb0 = time.perf_counter()
        chunks_data = []
        doc_vec_bytes = None
        if self.embedder:
            dim = self.embedder.embedding_dim
            if full_text:
                doc_vec = self.embedder.encode(full_text[:1000])
                doc_vec_bytes = doc_vec.tobytes()
            if chunks:
                vecs = self.embedder.encode_batch([c.text for c in chunks])
                for c, v in zip(chunks, vecs):
                    chunks_data.append({
                        "chunk_index": c.chunk_index,
                        "text": c.text,
                        "embedding": v.tobytes(),
                        "embedding_dim": dim,
                    })
        t_emb = (time.perf_counter() - t_emb0) * 1000

        t_db0 = time.perf_counter()
        doc_id = upsert_document(
            self.db_path,
            path=str(path),
            title=path.stem,
            mtime=mtime,
            size=size,
            sha256=sha,
            text=full_text,
            embedding=doc_vec_bytes,
        )
        insert_chunks(self.db_path, doc_id, chunks_data)
        t_db = (time.perf_counter() - t_db0) * 1000

        t_tot = (time.perf_counter() - t0) * 1000
        return SingleFileUpdateResult(
            relative_path=path.name,
            status="updated" if existing else "created",
            chunk_count=len(chunks_data),
            io_hash_time_ms=round(t_io, 2),
            chunking_time_ms=round(t_ch, 2),
            embedding_time_ms=round(t_emb, 2),
            db_time_ms=round(t_db, 2),
            total_time_ms=round(t_tot, 2),
        )
