"""
macOS ネイティブランチャーの検索方式切替およびバッジ表示を検証する。
"""

from typing import Any
import pytest

pytest.importorskip("AppKit")

from launcher_app.config import LauncherConfig
from launcher_app.models import SearchResultItem
from launcher_app.ui.native_mac import LauncherDelegate


class SpyMacClient:
    def __init__(self) -> None:
        self.last_search_query: str = ""
        self.last_search_options: dict[str, Any] = {}

    def get_app_settings(self) -> dict[str, Any]:
        return {}

    def search(self, query: str, **kwargs: Any) -> Any:
        self.last_search_query = query
        self.last_search_options = kwargs
        return type("Resp", (), {"items": [], "total": 0, "has_more": False})()


def test_native_mac_search_type_default_and_change() -> None:
    """
    初期検索方式は 'hybrid' であり、セグメント変更時に 'vector', 'keyword' へ切り替えられる。
    """
    client = SpyMacClient()
    config = LauncherConfig()
    delegate = LauncherDelegate.alloc().initWithClient_config_(client, config)

    assert getattr(delegate, "search_type", None) == "hybrid"

    # changeSearchType: にセグメントインデックス1（ベクトル）を渡す
    segmented_mock = type("Segmented", (), {"selectedSegment": lambda self: 1})()
    delegate.changeSearchType_(segmented_mock)
    assert delegate.search_type == "vector"

    # セグメントインデックス2（通常検索）
    segmented_mock_kw = type("Segmented", (), {"selectedSegment": lambda self: 2})()
    delegate.changeSearchType_(segmented_mock_kw)
    assert delegate.search_type == "keyword"


def test_native_mac_search_passes_search_type() -> None:
    """
    _search 呼び出し時に現在の search_type が client.search に伝搬される。
    """
    client = SpyMacClient()
    config = LauncherConfig()
    delegate = LauncherDelegate.alloc().initWithClient_config_(client, config)
    delegate.extension_filter = type("TextField", (), {"stringValue": lambda self: ""})()

    delegate.search_type = "vector"
    delegate._search("テスト", 1)

    assert client.last_search_query == "テスト"
    assert client.last_search_options.get("search_type") == "vector"


def test_native_mac_make_result_card_renders_badge_and_salient() -> None:
    """
    検索結果カードで match_source バッジおよび salient_sentence がラベルに反映されることを検証する。
    """
    client = SpyMacClient()
    config = LauncherConfig()
    delegate = LauncherDelegate.alloc().initWithClient_config_(client, config)

    item = SearchResultItem(
        file_id=10,
        result_kind="file",
        source_type="local",
        target_path="/test/memo.md",
        file_name="memo.md",
        full_path="/test/memo.md",
        file_ext=".md",
        created_at="2026-01-01T00:00:00",
        mtime="2026-01-01T00:00:00",
        click_count=0,
        snippet="<p>通常の抜粋です</p>",
        match_source="both",
        salient_sentence="これが重要な核心文です。",
    )

    card = delegate._make_result_card(item, 0, False)
    subviews = card.subviews()
    # subview 0: title_label, subview 1: path_label, subview 2: snippet_label
    title_text = str(subviews[0].stringValue())
    snippet_text = str(subviews[2].stringValue())

    assert "memo.md" in title_text
    assert "🌟両方一致" in title_text
    assert "💡 これが重要な核心文です。" in snippet_text
