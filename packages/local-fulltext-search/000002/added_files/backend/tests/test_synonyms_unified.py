"""
類似語（同義語）と専門用語辞書の一元管理テスト。
仕様:
- synonym_groups.txt に `用語1,用語2 : 意味・解説` の形式で記述可能。
- 通常検索（IndexService / SearchService）はコロンより前の類似語のみをOR展開に利用し、解説は検索語に含めない。
- 意味検索（GlossaryDictionary）は同じ設定から用語と解説を読み込み、専門用語検知（detect_terms）に利用する。
"""

import pytest
from pathlib import Path
from app.services.index_service import IndexService
from app.vector.dictionary import GlossaryDictionary


def test_parse_synonym_groups_ignores_description():
    """通常検索用のパースではコロン以降の解説が除外され、類似語のみが抽出される"""
    service = IndexService()
    text = (
        "PC,パソコン,コンピュータ : パーソナルコンピュータの略称\n"
        "スマホ, スマートフォン ： 多機能携帯電話\n"
        "AI, 人工知能\n"
    )
    groups = service._parse_synonym_groups(text)
    assert len(groups) == 3
    assert groups[0] == ["PC", "パソコン", "コンピュータ"]
    assert groups[1] == ["スマホ", "スマートフォン"]
    assert groups[2] == ["AI", "人工知能"]


def test_parse_synonym_entries_extracts_terms_and_description():
    """一元管理用のパースでは類似語リストと解説の両方が抽出される"""
    service = IndexService()
    text = (
        "PC,パソコン,コンピュータ : パーソナルコンピュータの略称\n"
        "スマホ, スマートフォン ： 多機能携帯電話\n"
        "AI, 人工知能\n"
    )
    entries = service._parse_synonym_entries(text)
    assert len(entries) == 3
    assert entries[0]["terms"] == ["PC", "パソコン", "コンピュータ"]
    assert entries[0]["description"] == "パーソナルコンピュータの略称"

    assert entries[1]["terms"] == ["スマホ", "スマートフォン"]
    assert entries[1]["description"] == "多機能携帯電話"

    assert entries[2]["terms"] == ["AI", "人工知能"]
    assert entries[2]["description"] == ""


def test_normalize_synonym_groups_preserves_description():
    """正規化処理でコロンと解説文が保持される"""
    service = IndexService()
    text = (
        " PC , パソコン , PC : パーソナルコンピュータの略称 \n"
        "スマホ, スマートフォン ： 多機能携帯電話\n"
    )
    normalized = service._normalize_synonym_groups(text)
    expected = (
        "PC,パソコン:パーソナルコンピュータの略称\n"
        "スマホ,スマートフォン:多機能携帯電話"
    )
    assert normalized == expected


def test_glossary_dictionary_loads_synonym_groups_txt(tmp_path: Path):
    """GlossaryDictionary が synonym_groups.txt を直接読み込んで専門用語として検知できる"""
    txt_file = tmp_path / "synonym_groups.txt"
    txt_file.write_text(
        "RAG,検索拡張生成 : Retrieval-Augmented Generation の略\n"
        "LLM,大規模言語モデル\n",
        encoding="utf-8"
    )
    glossary = GlossaryDictionary(str(txt_file))
    assert len(glossary.entries) == 2

    # 用語検知
    detected = glossary.detect_terms("社内システムでRAGを活用する計画です。")
    assert len(detected) == 1
    assert detected[0]["term"] == "RAG"
    assert detected[0]["description"] == "Retrieval-Augmented Generation の略"
    assert "検索拡張生成" in detected[0]["synonyms"]
