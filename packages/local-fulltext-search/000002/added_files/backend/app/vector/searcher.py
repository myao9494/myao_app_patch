"""
ベクトル検索エンジンモジュール (VectorSearcher)
仕様:
- FAISS (faiss.IndexFlatIP) を用いた高速コサイン類似度検索。
- スコアキャリブレーション (Dense + Lexical Hybrid) による 0.0〜0.98 の滑らかなグラデーション生成。
- Document検索モード（文書単位）および Chunk検索モード（チャンク単位 + 前後文脈）。
- 反応文特定 (Salient Sentence Extraction) による最もクエリに合致した核心文の抽出。
- LLM/ChatAI 投入用 RAG コンテキスト (XML / Markdown) の自動生成。
- 専門用語辞書 (GlossaryDictionary) との連携によるクエリ補強。
"""

import enum
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import numpy as np

from app.vector.db import (
    get_all_chunk_embeddings,
    get_all_document_embeddings,
    get_chunk_with_context,
    get_document_by_id,
)
from app.vector.dictionary import GlossaryDictionary
from app.vector.embedder import BaseEmbedder
from app.vector.faiss_index import FaissVectorIndex


class SearchMode(str, enum.Enum):
    DOCUMENT = "document"
    CHUNK = "chunk"


@dataclass
class SearchResultItem:
    """検索結果の1件分のデータ"""
    document_id: int
    path: str
    title: str
    score: float
    full_path: str = ""
    chunk_id: Optional[int] = None
    chunk_index: Optional[int] = None
    hit_text: Optional[str] = None
    preview: Optional[str] = None
    context: Optional[Dict[str, Any]] = None
    salient_sentence: Optional[str] = None


@dataclass
class SearchResponse:
    """検索レスポンス"""
    query: str
    mode: SearchMode
    results: List[SearchResultItem]
    total_candidates: int
    query_embedding_time_ms: float
    search_time_ms: float
    total_time_ms: float
    extracted_keywords: List[str] = field(default_factory=list)
    keyword_query: str = ""
    rag_context_xml: str = ""
    rag_context_markdown: str = ""
    detected_terms: List[Dict[str, Any]] = field(default_factory=list)


def generate_rag_contexts(results: List[SearchResultItem], query: str) -> Tuple[str, str]:
    """検索結果から標準RAGコンテキスト（XMLおよびMarkdown）を生成する"""
    if not results:
        xml_empty = f'<context query="{query}">\n  <!-- 関連コンテキストは見つかりませんでした -->\n</context>'
        md_empty = f"## 参考コンテキスト (クエリ: {query})\n*関連するコンテキストは見つかりませんでした。*"
        return xml_empty, md_empty

    xml_lines = [f'<context query="{query}">']
    for idx, item in enumerate(results[:5], start=1):
        content = (item.hit_text or item.preview or "").strip()
        xml_lines.append(f'  <document index="{idx}" title="{item.title}" path="{item.path}" score="{item.score:.4f}">')
        for line in content.splitlines():
            xml_lines.append(f"    {line}")
        xml_lines.append('  </document>')
    xml_lines.append('</context>')
    rag_xml = "\n".join(xml_lines)

    md_lines = [f"## 参考コンテキスト\nユーザーの質問: `{query}`\n"]
    for idx, item in enumerate(results[:5], start=1):
        content = (item.hit_text or item.preview or "").strip()
        md_lines.append(f"### [{idx}] {item.title} (Score: {item.score:.4f}, Path: `{item.path}`)")
        for line in content.splitlines():
            md_lines.append(f"> {line}" if line else ">")
        md_lines.append("")
    rag_md = "\n".join(md_lines).strip()

    return rag_xml, rag_md


def extract_salient_sentence(text: str, query: str, query_vec: Optional[np.ndarray] = None, embedder: Optional[BaseEmbedder] = None) -> Optional[str]:
    """テキスト内から最もクエリと関連の深い核心文（1〜2文）を抽出する"""
    if not text:
        return None
    sentences = [s.strip() for s in re.split(r"[。\n]+", text) if len(s.strip()) > 6]
    if not sentences:
        return text[:120].strip()

    query_words = [w.lower() for w in re.split(r"[\s,]+", query) if len(w.strip()) > 1]
    best_sent = sentences[0]
    best_overlap = -1

    for s in sentences:
        s_low = s.lower()
        overlap = sum(1 for w in query_words if w in s_low)
        if overlap > best_overlap:
            best_overlap = overlap
            best_sent = s

    return best_sent.strip()


def extract_keywords_from_query(query: str) -> List[str]:
    """クエリから重要単語を抽出する"""
    tokens = re.split(r"[\s　,]+", query.strip())
    stopwords = {"の", "に", "は", "を", "た", "が", "で", "て", "と", "し", "れ", "さ", "ある", "いる", "も", "する", "から", "な", "こと", "として"}
    keywords = []
    for t in tokens:
        cleaned = re.sub(r"^[^\w]+|[^\w]+$", "", t)
        if len(cleaned) >= 2 and cleaned.lower() not in stopwords:
            keywords.append(cleaned)
    return keywords


class VectorSearcher:
    """FAISS ベクトル検索エンジンクラス"""

    def __init__(
        self,
        db_path: str,
        embedder: Optional[BaseEmbedder] = None,
        glossary: Optional[GlossaryDictionary] = None,
    ):
        self.db_path = str(Path(db_path).resolve())
        self.embedder = embedder
        self.glossary = glossary
        self._chunk_index: Optional[FaissVectorIndex] = None
        self._doc_index: Optional[FaissVectorIndex] = None

    def _get_index(self, mode: SearchMode) -> FaissVectorIndex:
        if self.embedder is None:
            raise ValueError("検索を実行するには Embedder が必要です")

        dim = self.embedder.embedding_dim
        if mode == SearchMode.CHUNK:
            if self._chunk_index is None:
                idx = FaissVectorIndex(dim)
                ids, vecs = get_all_chunk_embeddings(self.db_path)
                if len(ids) > 0 and vecs.shape[1] == dim:
                    idx.add_vectors(ids, vecs)
                self._chunk_index = idx
            return self._chunk_index
        else:
            if self._doc_index is None:
                idx = FaissVectorIndex(dim)
                ids, vecs = get_all_document_embeddings(self.db_path)
                if len(ids) > 0 and vecs.shape[1] == dim:
                    idx.add_vectors(ids, vecs)
                self._doc_index = idx
            return self._doc_index

    def reset_index(self) -> None:
        """インデックスキャッシュをクリアする"""
        self._chunk_index = None
        self._doc_index = None

    def search(
        self,
        query: str,
        mode: SearchMode = SearchMode.CHUNK,
        top_k: int = 20,
        min_score: float = 0.0,
        keyword_boost: bool = True,
        boost_weight: float = 0.08,
    ) -> SearchResponse:
        """ベクトル類似度検索を実行する"""
        start_time = time.perf_counter()
        if not query.strip():
            return SearchResponse(
                query=query,
                mode=mode,
                results=[],
                total_candidates=0,
                query_embedding_time_ms=0.0,
                search_time_ms=0.0,
                total_time_ms=0.0,
            )

        # 専門用語の検知
        detected_terms = self.glossary.detect_terms(query) if self.glossary else []
        enriched_query = self.glossary.build_enriched_query(query) if self.glossary else query

        # クエリEmbedding生成
        t0 = time.perf_counter()
        query_vec = self.embedder.encode(enriched_query, is_query=True)
        q_emb_time_ms = (time.perf_counter() - t0) * 1000

        # FAISS検索
        t1 = time.perf_counter()
        faiss_idx = self._get_index(mode)
        raw_matches = faiss_idx.search(query_vec, top_k=max(top_k * 2, 50))
        search_time_ms = (time.perf_counter() - t1) * 1000

        extracted_kw = extract_keywords_from_query(query)
        kw_query = " OR ".join(extracted_kw) if extracted_kw else query

        results: List[SearchResultItem] = []
        seen_doc_ids = set()

        for sqlite_id, raw_score in raw_matches:
            # 異方性スコア補正（0.70未満ノイズフロアカット）
            if raw_score >= 0.98:
                calibrated = 0.98
            elif raw_score >= 0.70:
                ratio = (raw_score - 0.70) / (0.98 - 0.70)
                calibrated = 0.25 + 0.73 * (ratio ** 1.3)
            else:
                ratio = max(0.0, raw_score / 0.70)
                calibrated = 0.25 * (ratio ** 3.0)

            if mode == SearchMode.CHUNK:
                ctx = get_chunk_with_context(self.db_path, sqlite_id)
                if not ctx:
                    continue

                doc_id = ctx["document_id"]
                # 同一ドキュメント内の最高スコアチャンクを優先（重複抑制）
                if doc_id in seen_doc_ids:
                    continue
                seen_doc_ids.add(doc_id)

                hit_text = ctx["hit_text"]
                path = ctx["path"]
                title = ctx["title"] or Path(path).name

                # レキシカルブースト
                final_score = calibrated
                if keyword_boost:
                    text_lower = hit_text.lower()
                    kw_matches = sum(1 for kw in extracted_kw if kw.lower() in text_lower)
                    final_score = min(0.99, calibrated + kw_matches * boost_weight)

                if final_score < min_score:
                    continue

                salient = extract_salient_sentence(hit_text, query)

                results.append(SearchResultItem(
                    document_id=doc_id,
                    path=path,
                    title=title,
                    score=float(round(final_score, 4)),
                    full_path=path,
                    chunk_id=ctx["chunk_id"],
                    chunk_index=ctx["chunk_index"],
                    hit_text=hit_text,
                    preview=hit_text[:200],
                    context=ctx,
                    salient_sentence=salient,
                ))
            else:
                doc = get_document_by_id(self.db_path, sqlite_id)
                if not doc:
                    continue
                path = doc["path"]
                title = doc["title"] or Path(path).name
                body = doc["text"] or ""
                final_score = calibrated
                if final_score < min_score:
                    continue

                salient = extract_salient_sentence(body, query)
                results.append(SearchResultItem(
                    document_id=doc["id"],
                    path=path,
                    title=title,
                    score=float(round(final_score, 4)),
                    full_path=path,
                    hit_text=body[:500],
                    preview=body[:200],
                    salient_sentence=salient,
                ))

            if len(results) >= top_k:
                break

        # スコア降順ソート
        results.sort(key=lambda r: r.score, reverse=True)

        rag_xml, rag_md = generate_rag_contexts(results, query)
        total_time_ms = (time.perf_counter() - start_time) * 1000

        return SearchResponse(
            query=query,
            mode=mode,
            results=results,
            total_candidates=faiss_idx.total_vectors,
            query_embedding_time_ms=round(q_emb_time_ms, 2),
            search_time_ms=round(search_time_ms, 2),
            total_time_ms=round(total_time_ms, 2),
            extracted_keywords=extracted_kw,
            keyword_query=kw_query,
            rag_context_xml=rag_xml,
            rag_context_markdown=rag_md,
            detected_terms=detected_terms,
        )
