"""
ハイブリッド融合検索サービス (HybridSearchService)
仕様:
- ベクトル類似度検索 (VectorSearcher) と SQLite 全文検索 (SearchService) を直接統合。
- RRF (Reciprocal Rank Fusion) アルゴリズムによる順位融合:
  Score(d) = (w_v / (k + rank_v) + w_k / (k + rank_k)) / S_max  (0.0〜1.0 に正規化)
- 一致理由バッジ（🌟両方一致: both, 🔮意味一致: vector_only, 🏷️キーワード一致: keyword_only）を付与。
- ベクトルモデル未ロード時やキーワード検索結果なし時の安全な自動フォールバック。
- 統合結果からの RAG コンテキスト (XML / Markdown) 生成。
"""

import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

from app.vector.searcher import (
    SearchMode,
    SearchResultItem,
    VectorSearcher,
    generate_rag_contexts,
)

logger = logging.getLogger(__name__)


@dataclass
class HybridSearchResultItem:
    """ハイブリッド検索結果の1件分のデータ"""
    document_id: Optional[int]
    path: str
    title: str
    full_path: str
    hybrid_score: float
    match_type: Literal["both", "vector_only", "keyword_only"]
    vector_rank: Optional[int] = None
    vector_score: Optional[float] = None
    keyword_rank: Optional[int] = None
    keyword_score: Optional[float] = None
    chunk_id: Optional[int] = None
    chunk_index: Optional[int] = None
    hit_text: Optional[str] = None
    preview: Optional[str] = None
    snippet: Optional[str] = None
    context: Optional[Dict[str, Any]] = None
    salient_sentence: Optional[str] = None


@dataclass
class HybridSearchResponse:
    """ハイブリッド検索レスポンス"""
    query: str
    mode: str
    hybrid_results: List[HybridSearchResultItem]
    vector_results: List[Dict[str, Any]]
    keyword_results: List[Dict[str, Any]]
    extracted_keywords: List[str]
    keyword_query: str
    fusion_method: str
    vector_weight: float
    keyword_weight: float
    metrics: Dict[str, float]
    keyword_api_status: Dict[str, Any]
    rag_context_xml: str = ""
    rag_context_markdown: str = ""
    detected_terms: List[Dict[str, Any]] = field(default_factory=list)


def normalize_path_key(path_str: str) -> str:
    """パスの比較用キー（小文字化・スラッシュ統一）を生成"""
    if not path_str:
        return ""
    return Path(path_str).as_posix().lower()


def reciprocal_rank_fusion(
    vector_items: List[SearchResultItem],
    keyword_items: List[Dict[str, Any]],
    vector_weight: float = 0.5,
    keyword_weight: float = 0.5,
    k: int = 60,
) -> List[HybridSearchResultItem]:
    """
    RRF (Reciprocal Rank Fusion) アルゴリズムにより、
    ベクトル検索とキーワード検索の結果を順位ベースで融合する。
    """
    doc_map: Dict[str, Dict[str, Any]] = {}

    # 1. ベクトル検索結果の登録
    for rank, item in enumerate(vector_items, start=1):
        key = normalize_path_key(item.full_path or item.path)
        if not key:
            continue
        doc_map[key] = {
            "path": item.path,
            "title": item.title,
            "full_path": item.full_path or item.path,
            "document_id": item.document_id,
            "chunk_id": item.chunk_id,
            "chunk_index": item.chunk_index,
            "hit_text": item.hit_text,
            "preview": item.preview,
            "snippet": item.hit_text,
            "context": item.context,
            "salient_sentence": item.salient_sentence,
            "vector_rank": rank,
            "vector_score": item.score,
            "keyword_rank": None,
            "keyword_score": None,
        }

    # 2. キーワード検索結果の登録 / マージ
    for rank, item in enumerate(keyword_items, start=1):
        raw_path = item.get("full_path") or item.get("path") or ""
        key = normalize_path_key(raw_path)
        if not key:
            continue

        raw_score = item.get("rank_score") or item.get("score") or (1.0 / rank)

        if key in doc_map:
            doc_map[key]["keyword_rank"] = rank
            doc_map[key]["keyword_score"] = float(raw_score)
            if item.get("snippet") and not doc_map[key].get("salient_sentence"):
                doc_map[key]["snippet"] = item.get("snippet")
        else:
            doc_map[key] = {
                "path": raw_path,
                "title": item.get("file_name") or Path(raw_path).name,
                "full_path": raw_path,
                "document_id": item.get("id"),
                "chunk_id": None,
                "chunk_index": None,
                "hit_text": item.get("snippet"),
                "preview": item.get("snippet"),
                "snippet": item.get("snippet"),
                "context": None,
                "salient_sentence": item.get("snippet"),
                "vector_rank": None,
                "vector_score": None,
                "keyword_rank": rank,
                "keyword_score": float(raw_score),
            }

    # 3. RRF スコア計算と match_type 判定
    # 理論上の最高スコア（両方1位の場合）を算出して正規化（0.0〜1.0）
    max_theoretical_score = (vector_weight / (k + 1)) + (keyword_weight / (k + 1))
    if max_theoretical_score <= 0.0:
        max_theoretical_score = 1.0

    fused_items: List[HybridSearchResultItem] = []
    for key, data in doc_map.items():
        v_rank = data["vector_rank"]
        k_rank = data["keyword_rank"]

        score_v = (vector_weight * (1.0 / (k + v_rank))) if v_rank is not None else 0.0
        score_k = (keyword_weight * (1.0 / (k + k_rank))) if k_rank is not None else 0.0
        total_score = score_v + score_k
        normalized_score = min(max(total_score / max_theoretical_score, 0.0), 1.0)

        if v_rank is not None and k_rank is not None:
            match_type: Literal["both", "vector_only", "keyword_only"] = "both"
        elif v_rank is not None:
            match_type = "vector_only"
        else:
            match_type = "keyword_only"

        fused_items.append(HybridSearchResultItem(
            document_id=data["document_id"],
            path=data["path"],
            title=data["title"],
            full_path=data["full_path"],
            hybrid_score=float(round(normalized_score, 6)),
            match_type=match_type,
            vector_rank=v_rank,
            vector_score=data["vector_score"],
            keyword_rank=k_rank,
            keyword_score=data["keyword_score"],
            chunk_id=data["chunk_id"],
            chunk_index=data["chunk_index"],
            hit_text=data["hit_text"],
            preview=data["preview"],
            snippet=data["snippet"],
            context=data["context"],
            salient_sentence=data["salient_sentence"],
        ))

    # スコア降順ソート
    fused_items.sort(key=lambda x: x.hybrid_score, reverse=True)
    return fused_items
