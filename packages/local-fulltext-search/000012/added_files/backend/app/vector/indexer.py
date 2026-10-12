"""
ベクトルインデックス管理モジュール (VectorIndexManager)
仕様:
- 指定された全フォルダー（または targets テーブルの登録フォルダー）を再帰走査し、
  全選択拡張子のファイルを対象に差分インデックスを作成する。
  走査は全文インデックスと同じ関数（services/file_walker）で行い、対象範囲（除外キーワード・階層数・拡張子）を一致させる。
- Markdownファイルは chunk_markdown で見出しパンくず・メタデータ保持・描画データ除去を行い、
  Office/PDF/TXT/JSON等の本文抽出可能ファイルは extract_text ＋ chunk_text で分割。
  画像や音声等の本文なしファイルはファイル名をチャンクテキストとしてベクトル化する。
- path, mtime, size, sha256 による高速差分検知（変更なしはEmbeddingスキップ）。
- 除外キーワード（絶対パス・フォルダ名・単語境界）による厳格な走査除外（全文インデックスと同じ判定を共用）。
- 文書ベクトルとチャンクベクトルは 1 回のバッチ推論で生成し、文書とチャンクを 1 トランザクションで保存する。
- 削除または除外されたファイルのレコードは、明示的に許可された場合だけクリーンアップする。
  到達不能な対象フォルダ（未接続のネットワークドライブ等）配下の文書は削除候補にしない。
- 全件再作成（force_reindex）は、既存の文書を残したまま全ファイルを作り直し、最後まで終わったときだけ
  存在しなくなった文書を消す（途中で止まっても検索できる状態が残る）。
- 中止要求（should_cancel）はファイルごとに確認し、そこまでに保存した文書を残して終了する。
- 進捗コールバック（処理件数/全件数、残り時間推定等）および単一ファイル差分更新機能を提供。
"""

import hashlib
import logging
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from app.extractors.text_extractor import (
    extract_text,
    get_content_extensions,
    normalize_extension_filter,
    resolve_supported_extension,
)
from app.services import exclude_rules
from app.services.file_walker import walk_indexable_files
from app.vector.chunker import chunk_markdown, chunk_text
from app.vector.db import (
    delete_document,
    delete_documents,
    get_all_documents_metadata,
    get_db_stats,
    init_db,
    open_db,
    save_document_with_chunks,
)
from app.vector.dictionary import GlossaryDictionary
from app.vector.embedder import BaseEmbedder

logger = logging.getLogger(__name__)

# 階層数の指定が無い対象フォルダは、配下をすべて走査する
UNLIMITED_FOLDER_DEPTH = 99999
DOCUMENT_EMBEDDING_TEXT_LIMIT = 1000


@dataclass
class SingleFileUpdateResult:
    """単一ファイル差分更新およびプロファイリング結果"""
    relative_path: str
    status: str  # "created", "updated", "skipped", "deleted", "measured"（本文だけの測定。保存なし）
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
    # 中止要求で途中終了したか
    cancelled: bool = False


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
        folder_depths: Optional[Mapping[str, int]] = None,
    ):
        self.target_folders = [str(Path(p).resolve()) for p in target_folders]
        # 対象フォルダごとの階層数（全文インデックスの index_depth と同じ数え方）。無いフォルダは無制限。
        self.folder_depths = {
            str(Path(folder).resolve()): int(depth) for folder, depth in (folder_depths or {}).items()
        }
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
        """登録フォルダ以下の対象ファイルを、全文インデックスと同じ条件で収集する"""
        collected: List[Path] = []
        seen_paths: Set[str] = set()
        raw_keywords = exclude_rules.parse_exclude_keywords(self.exclude_keywords.replace(",", "\n"))
        keyword_set, substring_keywords, excluded_path_prefixes = exclude_rules.compile_exclude_keywords(raw_keywords)
        allowed_extensions = normalize_extension_filter(
            "\n".join(sorted(self.selected_set)) if self.selected_set else None,
            extra_content_extensions=self.custom_content_extensions,
            extra_filename_extensions=self.custom_filename_extensions,
        )
        sorted_allowed_extensions = tuple(sorted(allowed_extensions, key=len, reverse=True))

        for folder_str in self.target_folders:
            folder_path = Path(folder_str)
            if not folder_path.is_dir():
                continue
            for file_path in walk_indexable_files(
                folder_path,
                keyword_set,
                substring_keywords,
                excluded_path_prefixes=excluded_path_prefixes,
                auto_excluded_paths=set(),
                allowed_extensions=allowed_extensions,
                sorted_allowed_extensions=sorted_allowed_extensions,
                max_depth=self.folder_depths.get(folder_str, UNLIMITED_FOLDER_DEPTH),
            ):
                abs_posix = file_path.resolve().as_posix()
                if abs_posix not in seen_paths:
                    seen_paths.add(abs_posix)
                    collected.append(file_path)

        return collected

    def _resolve_deletion_candidates(self, existing_paths: Sequence[str], seen_paths: Set[str]) -> List[str]:
        """
        DB に登録済みで今回の走査では見つからなかった文書のうち、削除してよいものを返す。
        到達不能な対象フォルダ配下の文書は「消えた」のではなく「今は見えない」だけなので候補から外す
        （未接続のネットワークドライブ等で、長時間かけて作成したインデックスを失わないため）。
        """
        unreachable_roots = [
            Path(folder).as_posix().rstrip("/").lower()
            for folder in self.target_folders
            if not Path(folder).is_dir()
        ]

        def is_under_unreachable_root(path: str) -> bool:
            normalized = Path(path).as_posix().lower()
            return any(normalized == root or normalized.startswith(f"{root}/") for root in unreachable_roots)

        return sorted(
            path for path in existing_paths if path not in seen_paths and not is_under_unreachable_root(path)
        )

    def get_pending_deletions(self) -> list[str]:
        """
        現在のベクトルDBに登録されているが、ファイル走査で見つからなくなった削除候補のファイルパス一覧を取得する。
        """
        existing_meta = get_all_documents_metadata(self.db_path)
        if not existing_meta:
            return []
        current_seen_paths = {str(file_path.resolve()) for file_path in self.scan_files()}
        return self._resolve_deletion_candidates(list(existing_meta.keys()), current_seen_paths)

    def _embed_and_save(
        self,
        conn: sqlite3.Connection,
        file_path: Path,
        *,
        abs_path: str,
        mtime: float,
        size: int,
        sha256: str,
    ) -> Tuple[int, float, float, float]:
        """
        1 ファイルを抽出・チャンク化・ベクトル化して保存する。
        (チャンク数, チャンク化秒, 推論秒, DB書き込み秒) を返す。
        """
        chunk_start = time.perf_counter()
        chunks, full_text = self._process_file_chunks(file_path)
        chunk_seconds = time.perf_counter() - chunk_start

        embedding_start = time.perf_counter()
        doc_vec_bytes: Optional[bytes] = None
        chunks_data: List[Dict[str, Any]] = []
        if self.embedder:
            dim = self.embedder.embedding_dim
            # 文書単位ベクトルとチャンク単位ベクトルを 1 回のバッチ推論にまとめる
            texts: List[str] = []
            if full_text:
                texts.append(full_text[:DOCUMENT_EMBEDDING_TEXT_LIMIT])
            texts.extend(chunk.text for chunk in chunks)
            vectors = self.embedder.encode_batch(texts, is_query=False) if texts else []
            chunk_vectors = vectors
            if full_text:
                doc_vec_bytes = vectors[0].tobytes()
                chunk_vectors = vectors[1:]
            for chunk, vector in zip(chunks, chunk_vectors):
                chunks_data.append({
                    "chunk_index": chunk.chunk_index,
                    "text": chunk.text,
                    "embedding": vector.tobytes(),
                    "embedding_dim": dim,
                })
        embedding_seconds = time.perf_counter() - embedding_start

        db_start = time.perf_counter()
        save_document_with_chunks(
            conn,
            path=abs_path,
            title=file_path.stem,
            mtime=mtime,
            size=size,
            sha256=sha256,
            text=full_text,
            embedding=doc_vec_bytes,
            chunks_data=chunks_data,
        )
        db_seconds = time.perf_counter() - db_start
        return len(chunks_data), chunk_seconds, embedding_seconds, db_seconds

    def index_all(
        self,
        force_reindex: bool = False,
        clean_deleted_files: bool = False,
        progress_callback: Optional[Callable[[IndexProgress], None]] = None,
        should_cancel: Optional[Callable[[], bool]] = None,
    ) -> IndexResult:
        """
        全対象フォルダを走査して差分または全件インデックスを作成する。
        force_reindex=True のときは変更の有無に関係なく全ファイルを作り直す（既存の文書は置き換わるまで残す）。
        """
        start_time = time.perf_counter()
        embedding_total_sec = 0.0
        cancelled = False
        existing_meta: Dict[str, Dict[str, Any]] = get_all_documents_metadata(self.db_path)

        all_files = self.scan_files()
        total_files = len(all_files)

        new_count = 0
        updated_count = 0
        skipped_count = 0
        deleted_count = 0
        failed_count = 0
        current_seen_paths: Set[str] = set()

        with open_db(self.db_path) as conn:
            for idx, file_path in enumerate(all_files, start=1):
                if should_cancel is not None and should_cancel():
                    cancelled = True
                    break
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

                    _, chunk_seconds, embedding_seconds, _ = self._embed_and_save(
                        conn, file_path, abs_path=abs_path, mtime=mtime, size=size, sha256=sha
                    )
                    embedding_total_sec += chunk_seconds + embedding_seconds

                    if meta:
                        updated_count += 1
                    else:
                        new_count += 1

                except Exception as error:
                    # 1 ファイルの失敗で全体を止めない。未登録のまま残るため次回の差分更新で再試行される。
                    failed_count += 1
                    logger.warning("Vector indexing failed for %s: %s", abs_path, error)
                    continue

        if failed_count:
            logger.warning("Vector indexing finished with %d failed file(s).", failed_count)

        if cancelled:
            logger.info("Vector indexing was cancelled after %d of %d file(s).", len(current_seen_paths), total_files)

        # 削除されたファイルのクリーンアップ（明示的に許可された場合のみ削除し、許可がなければ既存インデックスを保護）。
        # 全件再作成は「作り直し」の指示なので、最後まで終わったときに存在しなくなった文書を消す。
        # 中止したときは走査が途中までなので、何も消さない。
        if (clean_deleted_files or force_reindex) and not cancelled:
            deleted_count = delete_documents(
                self.db_path,
                self._resolve_deletion_candidates(list(existing_meta.keys()), current_seen_paths),
            )

        # 完了統計の集計
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
            cancelled=cancelled,
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
                logger.warning("Failed to chunk a markdown file; indexing it by file name only: %s", file_path, exc_info=True)

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
                logger.warning("Failed to extract text; indexing it by file name only: %s", file_path, exc_info=True)

        # ファイル名のみ（画像、音声等）またはテキストが空の場合
        fn_text = f"ファイル名: {file_path.name}\nパス: {file_path.as_posix()}"
        chunks = chunk_text(fn_text, chunk_size=self.chunk_size)
        return chunks, fn_text

    def measure_text(self, name: str, text: str) -> SingleFileUpdateResult:
        """
        渡された本文を Markdown としてチャンク化・ベクトル化し、かかった時間だけを返す。
        ファイルもインデックスも変更しない（画面で作った検証用の本文で、処理時間と頑健さを確かめるため）。
        """
        t0 = time.perf_counter()
        chunk_start = time.perf_counter()
        chunks = chunk_markdown(
            text,
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
            glossary=self.glossary,
        )
        chunk_seconds = time.perf_counter() - chunk_start

        embedding_start = time.perf_counter()
        if self.embedder:
            texts = [text[:DOCUMENT_EMBEDDING_TEXT_LIMIT]] if text else []
            texts.extend(chunk.text for chunk in chunks)
            if texts:
                self.embedder.encode_batch(texts, is_query=False)
        embedding_seconds = time.perf_counter() - embedding_start

        return SingleFileUpdateResult(
            relative_path=name,
            status="measured",
            chunk_count=len(chunks),
            io_hash_time_ms=0.0,
            chunking_time_ms=round(chunk_seconds * 1000, 2),
            embedding_time_ms=round(embedding_seconds * 1000, 2),
            db_time_ms=0.0,
            total_time_ms=round((time.perf_counter() - t0) * 1000, 2),
        )

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
        if ext is None or (self.selected_set and ext not in self.selected_set):
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

        with open_db(self.db_path) as conn:
            chunk_count, chunk_seconds, embedding_seconds, db_seconds = self._embed_and_save(
                conn, path, abs_path=str(path), mtime=mtime, size=size, sha256=sha
            )

        t_tot = (time.perf_counter() - t0) * 1000
        return SingleFileUpdateResult(
            relative_path=path.name,
            status="updated" if existing else "created",
            chunk_count=chunk_count,
            io_hash_time_ms=round(t_io, 2),
            chunking_time_ms=round(chunk_seconds * 1000, 2),
            embedding_time_ms=round(embedding_seconds * 1000, 2),
            db_time_ms=round(db_seconds * 1000, 2),
            total_time_ms=round(t_tot, 2),
        )
