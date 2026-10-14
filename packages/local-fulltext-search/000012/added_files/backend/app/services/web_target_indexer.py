"""
Web の検索対象を巡回して全文インデックスへ反映する。

ベース URL を取得し、パンくず等から決めた巡回範囲（scope）の中だけをリンクで辿る。
取得方法は設定に従い、通常の HTTP か、正式版 Edge / Chrome（ログインが必要なサイト向け）を使う。
"""

from __future__ import annotations

import time as time_module
from collections.abc import Callable

from app.config import settings
from app.services import exclude_rules, web_pages
from app.services.index_run_state import IndexRunState, TargetIndexResult
from app.services.indexed_file_store import IndexedFileStore, IndexedWebPageCandidate
from app.services.web_browser_fetcher import BrowserWebFetcher
from app.services.web_pages import ExtractedWebPage, UnsupportedWebContentTypeError

# 1 回の巡回で取得するページ数の上限
MAX_PAGES_PER_CRAWL = 500


class WebTargetIndexer:
    """Web の検索対象 1 件分の巡回と DB 反映を行う。"""

    def __init__(self, files: IndexedFileStore, run_state: IndexRunState) -> None:
        self.files = files
        self.run_state = run_state

    def index(
        self,
        target: dict[str, object],
        exclude_keywords: str,
        *,
        index_depth: int,
        fetch_mode: str,
    ) -> TargetIndexResult:
        """
        fetch_mode（http / edge / chrome）に応じた取得方法で、対象 URL の配下を巡回する。
        """
        if fetch_mode == "http":
            return self._crawl(target, exclude_keywords, index_depth=index_depth, fetch_page=web_pages.fetch_web_page)

        channel = "msedge" if fetch_mode == "edge" else "chrome"
        profile_dir = settings.web_browser_profiles_dir / fetch_mode
        with BrowserWebFetcher(channel=channel, profile_dir=profile_dir) as browser_fetcher:
            return self._crawl(target, exclude_keywords, index_depth=index_depth, fetch_page=browser_fetcher.fetch)

    def _crawl(
        self,
        target: dict[str, object],
        exclude_keywords: str,
        *,
        index_depth: int,
        fetch_page: Callable[[str], str],
    ) -> TargetIndexResult:
        """
        指定された取得関数でベース URL の巡回範囲を辿り、本文を検索DBへ登録する。
        ベース URL 以外で HTML 以外の応答（PDF 等）に当たっても失敗としては記録しない。
        """
        base_url = web_pages.normalize_web_url(str(target["full_path"]))
        keywords = exclude_rules.parse_exclude_keywords(exclude_keywords)
        normalized_paths: set[str] = set()
        failed_paths: set[str] = set()
        preloaded_pages: dict[str, tuple[str, ExtractedWebPage]] = {}
        try:
            base_html = fetch_page(base_url)
            base_extracted = web_pages.extract_web_page(base_html)
            preloaded_pages[base_url] = (base_html, base_extracted)
        except Exception as error:
            failed_paths.add(base_url)
            self.files.record_web_error(base_url, error)
            self.files.commit()
            return TargetIndexResult(
                file_count=0,
                error_count=1,
                exclude_keywords=exclude_rules.normalize_keyword_list(keywords),
            )

        scope_url = web_pages.resolve_web_scope_url(base_url, base_extracted)
        existing_files = self.files.load_existing_files(scope_url)
        queue: list[tuple[str, int, bool]] = [(base_url, 0, True)]
        queued_urls = {base_url}
        if scope_url != base_url:
            queue.append((scope_url, 0, False))
            queued_urls.add(scope_url)
        file_count = 0
        error_count = 0

        while queue and len(normalized_paths) < MAX_PAGES_PER_CRAWL:
            self.run_state.raise_if_cancel_requested()
            current_url, current_depth, should_record_failure = queue.pop(0)
            if web_pages.should_exclude_web_url(current_url, keywords):
                continue
            try:
                if current_url in preloaded_pages:
                    html, extracted = preloaded_pages[current_url]
                else:
                    html = fetch_page(current_url)
                    extracted = web_pages.extract_web_page(html)
                title = extracted.title or web_pages.resolve_web_file_name(current_url)
                content = extracted.content
                fetched_at = time_module.time()
                normalized_url = web_pages.normalize_web_url(current_url)
                normalized_paths.add(normalized_url)
                candidate = IndexedWebPageCandidate(
                    url=normalized_url,
                    title=title,
                    content=content,
                    fetched_at=fetched_at,
                    size=len(html.encode("utf-8")),
                    existing_id=int(existing_files[normalized_url]["id"]) if normalized_url in existing_files else None,
                )
                self.files.upsert_web_page(candidate)
                file_count += 1
                if current_depth < index_depth:
                    for raw_link in extracted.links:
                        next_url = web_pages.normalize_linked_web_url(
                            raw_link,
                            base_url=current_url,
                            root_url=scope_url,
                        )
                        if next_url and next_url not in queued_urls:
                            queued_urls.add(next_url)
                            queue.append((next_url, current_depth + 1, True))
            except Exception as error:
                # リンク先が HTML 以外（PDF 等）だっただけなら、失敗として記録しない
                is_non_html_link = isinstance(error, UnsupportedWebContentTypeError) and current_url != base_url
                if should_record_failure and not is_non_html_link:
                    error_count += 1
                    failed_paths.add(current_url)
                    self.files.record_web_error(current_url, error)

            if file_count % 100 == 0:
                self.files.commit()

        self.files.commit()
        self.files.remove_deleted_files(normalized_paths, root_path=scope_url, index_depth=None)
        self.files.clear_resolved_failed_files(root_path=scope_url, failed_paths=failed_paths, index_depth=None)
        return TargetIndexResult(
            file_count=file_count,
            error_count=error_count,
            exclude_keywords=exclude_rules.normalize_keyword_list(keywords),
        )
