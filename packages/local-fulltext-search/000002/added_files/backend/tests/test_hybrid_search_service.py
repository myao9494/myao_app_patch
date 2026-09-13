"""
ハイブリッド検索サービス（HybridSearchService）の単体テスト。
RRF融合、一致理由バッジ（both/vector_only/keyword_only）、スコア計算を検証する。
"""

import pytest
from app.services.hybrid_search_service import (
    HybridSearchResultItem,
    normalize_path_key,
    reciprocal_rank_fusion,
)
from app.vector.searcher import SearchResultItem


def test_reciprocal_rank_fusion() -> None:
    """両方にヒットしたドキュメントが上位に来ること、および一致バッジが正しく付与されること"""
    vector_items = [
        SearchResultItem(
            document_id=1,
            path="/docs/file_both.md",
            title="両方一致ファイル",
            score=0.92,
            full_path="/docs/file_both.md",
            hit_text="ベクトル本文",
            salient_sentence="核心文",
        ),
        SearchResultItem(
            document_id=2,
            path="/docs/file_vector_only.md",
            title="ベクトルのみファイル",
            score=0.85,
            full_path="/docs/file_vector_only.md",
            hit_text="ベクトルのみ本文",
        ),
    ]

    keyword_items = [
        {
            "full_path": "/docs/file_both.md",
            "file_name": "file_both.md",
            "snippet": "キーワードスニペット",
        },
        {
            "full_path": "/docs/file_keyword_only.md",
            "file_name": "file_keyword_only.md",
            "snippet": "キーワードのみスニペット",
        },
    ]

    results = reciprocal_rank_fusion(
        vector_items=vector_items,
        keyword_items=keyword_items,
        vector_weight=0.5,
        keyword_weight=0.5,
        k=60,
    )

    assert len(results) == 3
    # 1位は両方にヒットしたもの
    top = results[0]
    assert top.path == "/docs/file_both.md"
    assert top.match_type == "both"
    assert top.vector_rank == 1
    assert top.keyword_rank == 1
    assert top.hybrid_score > results[1].hybrid_score

    # 残りの2件の match_type
    paths = {r.path: r.match_type for r in results}
    assert paths["/docs/file_both.md"] == "both"
    assert paths["/docs/file_vector_only.md"] == "vector_only"
    assert paths["/docs/file_keyword_only.md"] == "keyword_only"
