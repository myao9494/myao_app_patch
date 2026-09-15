"""
ベクトル検索管理APIルーター。
仕様:
- モデルロードおよびステータス確認。
- ベクトルインデックス作成・差分更新の非同期実行、進捗・統計の取得。
- 単一ファイル差分更新ベンチマークエンドポイント。
- 専門用語辞書（Glossary）の状態取得・エントリ更新。
"""

import asyncio
import logging
from pathlib import Path
from sqlite3 import Connection
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

from app.api.deps import get_db_connection
from app.config import PROJECT_ROOT_DIR, settings
from app.vector.db import get_db_stats, get_model_db_path, get_model_identifier
from app.vector.embedder import get_device_info
from app.vector.faiss_index import HAS_FAISS
from app.vector.indexer import SingleFileUpdateResult, VectorIndexManager
from app.vector.state import vector_state

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/vector", tags=["vector"])


class ModelLoadRequest(BaseModel):
    model_path: Optional[str] = None
    use_mock: bool = False
    mock_dim: int = 256


class IndexStartRequest(BaseModel):
    force_reindex: bool = False
    clean_deleted_files: bool = False
    target_folders: Optional[List[str]] = None
    model_path: Optional[str] = None


class PendingDeletionsRequest(BaseModel):
    target_folders: Optional[List[str]] = None
    model_path: Optional[str] = None


class SingleFileUpdateRequest(BaseModel):
    file_path: str


class GlossaryEntryModel(BaseModel):
    term: str
    synonyms: List[str] = []
    description: str = ""


class GlossarySaveRequest(BaseModel):
    entries: List[GlossaryEntryModel]


@router.post("/model/load")
def load_model_endpoint(req: ModelLoadRequest) -> Dict[str, Any]:
    """モデルをロードする"""
    try:
        return vector_state.load_model(
            model_path=req.model_path,
            use_mock=req.use_mock,
            mock_dim=req.mock_dim,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/model/status")
def get_model_status_endpoint() -> Dict[str, Any]:
    """現在のモデルロード状態を取得する"""
    dev_info = get_device_info()
    current_device = getattr(vector_state.embedder, "device", dev_info["device"])
    return {
        "loaded": vector_state.is_loaded,
        "model_path": vector_state.model_path,
        "current_model": Path(vector_state.model_path).name if vector_state.model_path else None,
        "saved_model_path": vector_state.get_saved_model_path(),
        "dim": vector_state.embedder.embedding_dim if vector_state.embedder else 0,
        "is_mock": getattr(vector_state.embedder, "model_path", None) == "mock_model",
        "default_light_path": vector_state.default_light_path,
        "default_standard_path": vector_state.default_standard_path,
        "light_available": Path(vector_state.default_light_path).exists(),
        "standard_available": Path(vector_state.default_standard_path).exists(),
        "device": current_device,
        "device_name": dev_info["device_name"],
        "cuda_available": dev_info["cuda_available"],
        "mps_available": dev_info["mps_available"],
        "has_faiss": HAS_FAISS,
    }


def _run_vector_indexing(folders: List[str], force: bool, clean_deleted_files: bool = False, model_path: Optional[str] = None) -> None:
    try:
        if model_path and (not vector_state.is_loaded or vector_state.model_path != model_path):
            logger.info("VectorState: loading requested model %s before indexing", model_path)
            vector_state.load_model(model_path=model_path)
        from app.services.index_service import IndexService
        idx_svc = IndexService()
        app_cfg = idx_svc.get_app_settings()
        vector_state.sync_index(
            target_folders=folders,
            force=force,
            clean_deleted_files=clean_deleted_files,
            exclude_keywords=app_cfg.exclude_keywords,
        )
    except Exception as e:
        logger.error("Vector indexing failed: %s", e, exc_info=True)


@router.post("/index/pending-deletions")
def get_pending_deletions_endpoint(
    req: PendingDeletionsRequest,
    connection: Connection = Depends(get_db_connection),
) -> Dict[str, Any]:
    """差分更新時に削除対象となるファイル一覧を事前に取得する"""
    folders = req.target_folders
    if not folders:
        cursor = connection.cursor()
        cursor.execute("SELECT full_path FROM targets WHERE is_search_target_enabled = 1 AND source_type = 'local'")
        rows = cursor.fetchall()
        folders = [r["full_path"] for r in rows]

    deletions = vector_state.get_pending_deletions(target_folders=folders, model_path=req.model_path)
    return {
        "pending_deletions": deletions,
        "count": len(deletions),
    }


@router.post("/index/start")
def start_vector_indexing(
    req: IndexStartRequest,
    background_tasks: BackgroundTasks,
    connection: Connection = Depends(get_db_connection),
) -> Dict[str, Any]:
    """ベクトルインデックス作成をバックグラウンドで開始する"""
    if vector_state.is_indexing:
        raise HTTPException(status_code=409, detail="既にインデックス処理が実行中です")

    # ターゲットフォルダの解決
    folders = req.target_folders
    if not folders:
        # DBから有効なローカルターゲットを取得
        cursor = connection.cursor()
        cursor.execute("SELECT full_path FROM targets WHERE is_search_target_enabled = 1 AND source_type = 'local'")
        rows = cursor.fetchall()
        folders = [r["full_path"] for r in rows]

    if not folders:
        raise HTTPException(status_code=400, detail="インデックス対象のフォルダが登録されていません")

    background_tasks.add_task(_run_vector_indexing, folders, req.force_reindex, req.clean_deleted_files, req.model_path)
    return {"message": "インデックス処理を開始しました", "target_folders": folders}


@router.get("/index/progress")
def get_vector_index_progress() -> Dict[str, Any]:
    """現在のインデックス進捗を取得する"""
    prog = vector_state.current_progress
    last = vector_state.last_result
    return {
        "is_indexing": vector_state.is_indexing,
        "progress": {
            "processed_files": prog.processed_files,
            "total_files": prog.total_files,
            "progress_pct": prog.progress_pct,
            "current_file": prog.current_file,
            "elapsed_sec": prog.elapsed_sec,
            "estimated_remaining_sec": prog.estimated_remaining_sec,
        } if prog else None,
        "last_result": {
            "total_files": last.total_files,
            "new_count": last.new_count,
            "updated_count": last.updated_count,
            "skipped_count": last.skipped_count,
            "deleted_count": last.deleted_count,
            "document_count": last.document_count,
            "chunk_count": last.chunk_count,
            "indexing_time_sec": last.indexing_time_sec,
            "embedding_time_sec": last.embedding_time_sec,
            "db_size_mb": last.db_size_mb,
        } if last else None,
    }


@router.get("/index/stats")
def get_vector_index_stats() -> Dict[str, Any]:
    """ベクトルDBの統計情報を取得する（現在モデルおよび各登録モデル別）"""
    ident = get_model_identifier(vector_state.model_path, vector_state.embedder)
    db_path = get_model_db_path(ident, data_dir=vector_state.data_dir)
    stats = get_db_stats(db_path)
    stats["model_identifier"] = ident
    stats["db_path"] = db_path

    # モデル別の統計情報を集計
    models_stats: Dict[str, Any] = {}
    known_models = ["ruri-v3-30m", "ruri-v3-310m"]
    # data_dir 内の全 vector_index_*.db も探索
    for f in vector_state.data_dir.glob("vector_index_*.db"):
        m_name = f.stem.replace("vector_index_", "")
        if m_name and m_name not in known_models and m_name != "default" and m_name != "mock":
            known_models.append(m_name)

    for m in known_models:
        m_db_path = get_model_db_path(m, data_dir=vector_state.data_dir)
        models_stats[m] = get_db_stats(m_db_path)
    stats["models"] = models_stats

    return stats


@router.post("/index/update-file")
def update_single_file_endpoint(req: SingleFileUpdateRequest) -> Dict[str, Any]:
    """単一ファイルの差分更新ベンチマークを実行する"""
    if not vector_state.ensure_model_loaded():
        raise HTTPException(status_code=400, detail="モデルがロードされていません")

    ident = get_model_identifier(vector_state.model_path, vector_state.embedder)
    db_path = get_model_db_path(ident, data_dir=vector_state.data_dir)

    manager = VectorIndexManager(
        target_folders=[],
        db_path=db_path,
        embedder=vector_state.embedder,
        glossary=vector_state.glossary,
    )
    res = manager.update_single_file(req.file_path)
    if vector_state.searcher:
        vector_state.searcher.reset_index()

    return {
        "relative_path": res.relative_path,
        "status": res.status,
        "chunk_count": res.chunk_count,
        "io_hash_time_ms": res.io_hash_time_ms,
        "chunking_time_ms": res.chunking_time_ms,
        "embedding_time_ms": res.embedding_time_ms,
        "db_time_ms": res.db_time_ms,
        "total_time_ms": res.total_time_ms,
    }


class DictionarySaveRequest(BaseModel):
    entries: List[Dict[str, Any]]
    file_name: Optional[str] = "glossary.xlsx"


@router.get("/dictionary/status")
def get_dictionary_status() -> Dict[str, Any]:
    """専門用語辞書の状態とエントリを取得する"""
    g = vector_state.glossary
    if not g:
        return {"loaded": False, "entries": [], "total_terms": 0}
    return {
        "loaded": True,
        "file_path": g.file_path,
        "total_terms": len(g.entries),
        "entries": g.entries,
    }


@router.post("/dictionary/save")
def save_dictionary(req: DictionarySaveRequest) -> Dict[str, Any]:
    """専門用語辞書をExcelファイルへ保存し、即座に再読み込みする"""
    from app.vector.dictionary import GlossaryDictionary

    target_dir = Path("backend/data")
    if not target_dir.exists():
        target_dir = Path("data")
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / (req.file_name or "glossary.xlsx")

    GlossaryDictionary.save_to_excel(str(target_path), req.entries)

    # 即座にリロードして適用
    new_glossary = GlossaryDictionary(str(target_path))
    vector_state.set_glossary(new_glossary)

    return {
        "success": True,
        "file_name": req.file_name,
        "total_entries": len(new_glossary.entries),
    }

