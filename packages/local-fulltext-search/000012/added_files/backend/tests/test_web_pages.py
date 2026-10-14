"""
Web ページ解析ユーティリティ（app.services.web_pages）のテスト。
DB に依存しない URL の正規化・表示名・除外判定を検証する。
"""

from app.services import web_pages


def test_resolve_web_file_name_uses_last_path_segment() -> None:
    """タイトルの無いページは、URL の最後のパス要素を表示名にする。"""
    assert web_pages.resolve_web_file_name("https://example.com/docs/guide.html") == "guide.html"
    assert web_pages.resolve_web_file_name("https://example.com/docs/guide/") == "guide"


def test_resolve_web_file_name_falls_back_to_host_for_root_url() -> None:
    """パスが無い URL は、ホスト名を表示名にする。"""
    assert web_pages.resolve_web_file_name("https://example.com/") == "example.com"
    assert web_pages.resolve_web_file_name("https://example.com") == "example.com"


def test_normalize_web_url_drops_fragment_and_lowercases_host() -> None:
    """フラグメントを除き、スキームとホストを小文字へそろえる。"""
    assert web_pages.normalize_web_url("HTTPS://Example.COM/Docs/Page#section") == "https://example.com/Docs/Page"


def test_should_exclude_web_url_matches_keyword_case_insensitively() -> None:
    """除外キーワードは URL に対する部分一致（大文字小文字を区別しない）で判定する。"""
    assert web_pages.should_exclude_web_url("https://example.com/Private/page", ["private"]) is True
    assert web_pages.should_exclude_web_url("https://example.com/public/page", ["private"]) is False
