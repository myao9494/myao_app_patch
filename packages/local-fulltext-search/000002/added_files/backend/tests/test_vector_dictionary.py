"""
専門用語辞書（GlossaryDictionary）の単体テスト。
用語検知、表記揺れ吸収、同義語展開を検証する。
"""

import pytest
from pathlib import Path
from app.vector.dictionary import GlossaryDictionary, normalize_term_key


def test_normalize_term_key() -> None:
    """用語キーの正規化（全角半角、小文字、記号除去）を検証する"""
    assert normalize_term_key("ＰＪ－Ｘ") == "pjx"
    assert normalize_term_key("PJ-X") == "pjx"
    assert normalize_term_key("プロジェクト X") == "プロジェクトx"


def test_dictionary_detect_terms(tmp_path: Path) -> None:
    """CSVから辞書を読み込み、テキストから専門用語が検出されることを検証する"""
    csv_file = tmp_path / "glossary.csv"
    csv_file.write_text("専門用語,意味・解説\nPJ-X,極秘の次世代開発プロジェクト\nLLM,大規模言語モデル\n", encoding="utf-8")

    glossary = GlossaryDictionary(file_path=str(csv_file))
    assert len(glossary.entries) == 2

    text = "今回のpj-x会議では最新のLLMを活用します。"
    detected = glossary.detect_terms(text)
    assert len(detected) == 2

    terms = [d["term"] for d in detected]
    assert "PJ-X" in terms
    assert "LLM" in terms


def test_save_to_excel_and_reload(tmp_path: Path) -> None:
    """save_to_excel でExcelファイルを出力し、GlossaryDictionaryで再読込できることを検証する"""
    excel_path = tmp_path / "glossary.xlsx"
    entries = [
        {"terms": "PJ-X, プロジェクトX", "description": "極秘プロジェクト"},
        {"terms": "ポチッと君", "description": "経費精算システム"},
    ]
    GlossaryDictionary.save_to_excel(str(excel_path), entries)
    assert excel_path.exists()

    g = GlossaryDictionary(file_path=str(excel_path))
    assert len(g.entries) == 2
    detected = g.detect_terms("プロジェクトXでポチッと君を改修する")
    assert len(detected) == 2

