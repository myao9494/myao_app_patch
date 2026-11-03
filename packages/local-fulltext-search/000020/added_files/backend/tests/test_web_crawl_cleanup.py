"""
Web 巡回のあとの削除判定のテスト。

仕様:
- 巡回で到達しなかったページを削除するのは、範囲を辿り切ったときだけ。
- 次の場合は「ページが消えた」と判断できないので、何も削除しない。
  - 階層の制限で、辿っていないリンクが残った。
  - 巡回ページ数の上限で打ち切った。
  - 取得に失敗したページがある（その先のリンクも分からない）。
- HTML 以外のリンク（PDF など）は失敗ではないので、削除を止めない。
"""

import sqlite3
from pathlib import Path

import pytest

from app.db.schema import initialize_schema
from app.services import web_pages, web_target_indexer
from app.services.indexed_file_store import IndexedFileStore
from app.services.web_pages import UnsupportedWebContentTypeError
from app.services.web_target_indexer import WebTargetIndexer

ROOT = "https://example.com/docs/"
HOME = ROOT
GUIDE = f"{ROOT}guide.html"
DETAIL = f"{ROOT}detail.html"


class NoCancel:
    def raise_if_cancel_requested(self) -> None:
        return None


def _page(title: str, *links: str) -> str:
    anchors = "".join(f'<a href="{link}">{link}</a>' for link in links)
    return f"<html><head><title>{title}</title></head><body><main>{title} body {anchors}</main></body></html>"


@pytest.fixture
def crawl(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """site（URL → HTML または送出する例外）を巡回し、DB に残った URL を返す関数を作る。"""
    connection = sqlite3.connect(tmp_path / "search.db")
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)

    def run(site: dict[str, object], *, index_depth: int = 5) -> list[str]:
        def fetch(url: str) -> str:
            page = site.get(url, ValueError("HTTP 404"))
            if isinstance(page, Exception):
                raise page
            return str(page)

        monkeypatch.setattr(web_pages, "fetch_web_page", fetch)
        indexer = WebTargetIndexer(IndexedFileStore(connection), NoCancel())
        indexer.index({"full_path": HOME}, "", index_depth=index_depth, fetch_mode="http")
        rows = connection.execute("SELECT normalized_path FROM files ORDER BY normalized_path").fetchall()
        return [str(row["normalized_path"]) for row in rows]

    try:
        yield run
    finally:
        connection.close()


def _full_site() -> dict[str, object]:
    return {
        HOME: _page("Home", GUIDE),
        GUIDE: _page("Guide", DETAIL),
        DETAIL: _page("Detail"),
    }


def test_page_no_longer_linked_is_removed_after_a_complete_crawl(crawl) -> None:
    crawl(_full_site())

    remaining = crawl({HOME: _page("Home", GUIDE), GUIDE: _page("Guide")})

    assert remaining == sorted([HOME, GUIDE])


def test_shallower_crawl_keeps_pages_it_did_not_reach(crawl) -> None:
    crawl(_full_site())

    remaining = crawl(_full_site(), index_depth=0)

    assert remaining == sorted([HOME, GUIDE, DETAIL])


def test_failed_page_and_the_pages_behind_it_are_kept(crawl) -> None:
    crawl(_full_site())

    site = _full_site()
    site[GUIDE] = ValueError("timed out")
    remaining = crawl(site)

    assert remaining == sorted([HOME, GUIDE, DETAIL])


def test_crawl_stopped_by_the_page_limit_keeps_the_rest(crawl, monkeypatch: pytest.MonkeyPatch) -> None:
    crawl(_full_site())

    monkeypatch.setattr(web_target_indexer, "MAX_PAGES_PER_CRAWL", 1)
    remaining = crawl(_full_site())

    assert remaining == sorted([HOME, GUIDE, DETAIL])


def test_non_html_link_does_not_stop_the_cleanup(crawl) -> None:
    pdf = f"{ROOT}manual.pdf"
    crawl(_full_site())

    remaining = crawl(
        {
            HOME: _page("Home", GUIDE, pdf),
            GUIDE: _page("Guide"),
            pdf: UnsupportedWebContentTypeError("Unsupported content type: application/pdf"),
        }
    )

    assert remaining == sorted([HOME, GUIDE])
