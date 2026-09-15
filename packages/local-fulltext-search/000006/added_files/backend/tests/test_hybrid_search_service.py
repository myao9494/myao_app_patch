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
    # 1位は両方にヒットしたもの（正規化により理論最大値で 1.0 になること）
    top = results[0]
    assert top.path == "/docs/file_both.md"
    assert top.match_type == "both"
    assert top.vector_rank == 1
    assert top.keyword_rank == 1
    assert top.hybrid_score == pytest.approx(1.0, rel=1e-3)
    assert top.hybrid_score > results[1].hybrid_score

    # 片方のみヒットしたものは順位に応じた正規化スコアになること（rank 2 なので (0.5/62)/(1.0/61) ≈ 0.4919）
    vector_only = [r for r in results if r.path == "/docs/file_vector_only.md"][0]
    keyword_only = [r for r in results if r.path == "/docs/file_keyword_only.md"][0]
    expected_rank2_score = (0.5 / 62) / (1.0 / 61)
    assert keyword_only.hybrid_score == pytest.approx(expected_rank2_score, rel=1e-3)
    assert vector_only.hybrid_score == pytest.approx(expected_rank2_score, rel=1e-3)

    # 残りの2件の match_type
    paths = {r.path: r.match_type for r in results}
    assert paths["/docs/file_both.md"] == "both"
    assert paths["/docs/file_vector_only.md"] == "vector_only"
    assert paths["/docs/file_keyword_only.md"] == "keyword_only"


def test_reciprocal_rank_fusion_single_source_rank1_normalized_to_half() -> None:
    """片方のみで1位の場合は理論最大値の半分（0.5）に正規化されること"""
    vector_items = [
        SearchResultItem(
            document_id=1,
            path="/docs/file_v1.md",
            title="ベクトル1位",
            score=0.95,
            full_path="/docs/file_v1.md",
        ),
    ]
    keyword_items = [
        {
            "full_path": "/docs/file_k1.md",
            "file_name": "file_k1.md",
            "snippet": "キーワード1位",
        },
    ]

    results = reciprocal_rank_fusion(
        vector_items=vector_items,
        keyword_items=keyword_items,
        vector_weight=0.5,
        keyword_weight=0.5,
        k=60,
    )

    assert len(results) == 2
    # 重み0.5同士で両方とも各側の1位なので、それぞれ 0.5 になること
    for item in results:
        assert item.hybrid_score == pytest.approx(0.5, rel=1e-3)


