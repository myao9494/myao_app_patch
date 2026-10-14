"""
Web ページ検索用の取得・解析ユーティリティ。

仕様:
- 検索対象として登録できるのは http / https の URL だけ。URL はフラグメントを除き、スキームとホストを小文字へ正規化する。
- HTML からタイトル・本文テキスト・リンク・パンくず（breadcrumb 属性、JSON-LD の BreadcrumbList）を抽出する。
- クロール範囲（スコープ）は、パンくずから求めた祖先 URL、無ければ対象 URL の親階層とし、その配下のリンクだけを辿る。
- HTML 以外のコンテンツタイプは UnsupportedWebContentTypeError として扱い、失敗ファイルには記録しない。
- ここには DB に依存しない処理だけを置く。クロールの進行は web_target_indexer、保存は indexed_file_store が担う。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import PurePosixPath
from urllib.error import HTTPError, URLError
from urllib.parse import urldefrag, urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen

from fastapi import HTTPException, status


@dataclass(frozen=True)
class ExtractedWebPage:
    """
    HTML から取り出したタイトル・本文・リンク一覧。
    """

    title: str
    content: str
    links: tuple[str, ...]
    breadcrumb_links: tuple[str, ...]
    json_ld_blocks: tuple[str, ...]


class UnsupportedWebContentTypeError(ValueError):
    """
    Web クロール中に HTML ではないリンクを見つけたことを表す。
    """


class WebPageParser(HTMLParser):
    """
    Web ページ検索用に、HTML からタイトル・本文テキスト・リンクを抽出する。
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.body_parts: list[str] = []
        self.links: list[str] = []
        self.breadcrumb_links: list[str] = []
        self.json_ld_blocks: list[str] = []
        self._tag_stack: list[str] = []
        self._ignored_depth = 0
        self._breadcrumb_depth = 0
        self._json_ld_depth = 0
        self._json_ld_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized_tag = tag.lower()
        attr_map = {name.lower(): value or "" for name, value in attrs}
        self._tag_stack.append(normalized_tag)
        if normalized_tag in {"script", "style", "noscript", "svg"}:
            self._ignored_depth += 1
        if normalized_tag == "script" and "ld+json" in attr_map.get("type", "").lower():
            self._json_ld_depth += 1
            self._json_ld_parts = []
        if normalized_tag == "nav" and self._is_breadcrumb_attrs(attr_map):
            self._breadcrumb_depth += 1
        if normalized_tag == "a":
            href = attr_map.get("href")
            if href:
                self.links.append(href)
                if self._breadcrumb_depth > 0 or self._is_breadcrumb_attrs(attr_map):
                    self.breadcrumb_links.append(href)

    def handle_endtag(self, tag: str) -> None:
        normalized_tag = tag.lower()
        if normalized_tag == "script" and self._json_ld_depth > 0:
            self.json_ld_blocks.append("".join(self._json_ld_parts))
            self._json_ld_parts = []
            self._json_ld_depth -= 1
        if normalized_tag in {"script", "style", "noscript", "svg"} and self._ignored_depth > 0:
            self._ignored_depth -= 1
        if normalized_tag == "nav" and self._breadcrumb_depth > 0:
            self._breadcrumb_depth -= 1
        if self._tag_stack:
            self._tag_stack.pop()

    def handle_data(self, data: str) -> None:
        if self._json_ld_depth > 0:
            self._json_ld_parts.append(data)
            return
        text = " ".join(data.split())
        if not text or self._ignored_depth > 0:
            return
        if self._tag_stack and self._tag_stack[-1] == "title":
            self.title_parts.append(text)
            return
        self.body_parts.append(text)

    def extract(self) -> ExtractedWebPage:
        title = " ".join(self.title_parts).strip()
        content = " ".join(self.body_parts).strip()
        return ExtractedWebPage(
            title=title,
            content=content,
            links=tuple(self.links),
            breadcrumb_links=tuple(self.breadcrumb_links),
            json_ld_blocks=tuple(self.json_ld_blocks),
        )

    def _is_breadcrumb_attrs(self, attrs: dict[str, str]) -> bool:
        """
        HTML のパンくず領域らしい属性かどうかを判定する。
        """
        haystack = " ".join([attrs.get("aria-label", ""), attrs.get("class", ""), attrs.get("id", "")]).lower()
        return "breadcrumb" in haystack or "bread-crumb" in haystack or "パンくず" in haystack


def is_web_url(value: str) -> bool:
    """
    HTTP/HTTPS URL かどうかを判定する。
    """
    parsed = urlparse(value.strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def normalize_web_url(value: str) -> str:
    """
    Web ページ検索で使う URL をフラグメントなし・安定表記へ正規化する。
    """
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Web target must be an http or https URL.")
    path = parsed.path or "/"
    normalized = parsed._replace(
        scheme=parsed.scheme.lower(),
        netloc=parsed.netloc.lower(),
        path=path,
        params="",
        fragment="",
    )
    return urlunparse(normalized)


def fetch_web_page(url: str) -> str:
    """
    HTML ページを短いタイムアウトで取得する。
    """
    request = Request(url, headers={"User-Agent": "LocalFulltextSearch/1.0"})
    try:
        with urlopen(request, timeout=10) as response:
            content_type = response.headers.get("Content-Type", "")
            if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
                raise UnsupportedWebContentTypeError(f"Unsupported content type: {content_type or 'unknown'}")
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read(2_000_000).decode(charset, errors="replace")
    except HTTPError as error:
        raise ValueError(f"HTTP {error.code}") from error
    except URLError as error:
        raise ValueError(str(error.reason)) from error


def extract_web_page(html: str) -> ExtractedWebPage:
    """
    HTML 文字列から検索用本文とリンクを取り出す。
    """
    parser = WebPageParser()
    parser.feed(html)
    return parser.extract()


def resolve_web_scope_url(base_url: str, extracted: ExtractedWebPage) -> str:
    """
    Web クロール範囲のルートを、構造化パンくず・HTMLパンくず・URL構造の順で決める。
    """
    structured_candidates = extract_breadcrumb_urls_from_json_ld(base_url, extracted.json_ld_blocks)
    scope_url = select_breadcrumb_scope_url(base_url, structured_candidates)
    if scope_url is not None:
        return scope_url

    html_candidates = [normalize_breadcrumb_candidate_url(base_url, link) for link in extracted.breadcrumb_links]
    scope_url = select_breadcrumb_scope_url(base_url, [url for url in html_candidates if url is not None])
    if scope_url is not None:
        return scope_url

    return resolve_url_parent_scope(base_url)


def extract_breadcrumb_urls_from_json_ld(base_url: str, blocks: tuple[str, ...]) -> list[str]:
    """
    JSON-LD の BreadcrumbList から URL 候補を抽出する。
    """
    urls: list[str] = []
    for block in blocks:
        try:
            parsed = json.loads(block)
        except json.JSONDecodeError:
            continue
        for item in iter_json_ld_nodes(parsed):
            if not isinstance(item, dict):
                continue
            node_type = item.get("@type")
            node_types = node_type if isinstance(node_type, list) else [node_type]
            if "BreadcrumbList" not in node_types:
                continue
            elements = item.get("itemListElement")
            if not isinstance(elements, list):
                continue
            for element in elements:
                url = extract_url_from_breadcrumb_element(element)
                normalized_url = normalize_breadcrumb_candidate_url(base_url, url) if url else None
                if normalized_url is not None:
                    urls.append(normalized_url)
    return urls


def iter_json_ld_nodes(value):
    """
    JSON-LD の @graph や配列をたどってノードを列挙する。
    """
    if isinstance(value, list):
        for item in value:
            yield from iter_json_ld_nodes(item)
        return
    if not isinstance(value, dict):
        return
    yield value
    graph = value.get("@graph")
    if isinstance(graph, list):
        for item in graph:
            yield from iter_json_ld_nodes(item)


def extract_url_from_breadcrumb_element(element) -> str | None:
    """
    BreadcrumbList の要素から URL 文字列を取り出す。
    """
    if isinstance(element, str):
        return element
    if not isinstance(element, dict):
        return None
    item = element.get("item")
    if isinstance(item, str):
        return item
    if isinstance(item, dict):
        for key in ("@id", "id", "url"):
            value = item.get(key)
            if isinstance(value, str):
                return value
    for key in ("@id", "id", "url"):
        value = element.get(key)
        if isinstance(value, str):
            return value
    return None


def normalize_breadcrumb_candidate_url(base_url: str, value: str | None) -> str | None:
    """
    パンくずから得た URL 候補を絶対 URL へ正規化する。
    """
    if not value:
        return None
    joined_url, _ = urldefrag(urljoin(base_url, value))
    if not is_web_url(joined_url):
        return None
    return normalize_web_url(joined_url)


def select_breadcrumb_scope_url(base_url: str, candidates: list[str]) -> str | None:
    """
    パンくず候補から、ベース URL を包含する最も深い親階層を選ぶ。
    """
    normalized_base = normalize_web_url(base_url)
    ancestors = [
        candidate
        for candidate in candidates
        if candidate != normalized_base and is_web_scope_ancestor(candidate, normalized_base)
    ]
    if not ancestors:
        return None
    return max(ancestors, key=lambda url: len(urlparse(url).path))


def resolve_url_parent_scope(base_url: str) -> str:
    """
    パンくずがない場合、URL パスの親階層をクロール範囲にする。
    """
    parsed = urlparse(base_url)
    if parsed.path.endswith("/"):
        return normalize_web_url(base_url)
    parent_path = parsed.path.rsplit("/", 1)[0] + "/"
    if parent_path == "//":
        parent_path = "/"
    return normalize_web_url(urlunparse(parsed._replace(path=parent_path, params="", query="", fragment="")))


def is_web_scope_ancestor(scope_url: str, candidate_url: str) -> bool:
    """
    scope_url が candidate_url と同一ホストで、パス階層上の祖先かどうかを返す。
    """
    scope = urlparse(scope_url)
    candidate = urlparse(candidate_url)
    if scope.scheme != candidate.scheme or scope.netloc != candidate.netloc:
        return False
    scope_path = scope.path or "/"
    candidate_path = candidate.path or "/"
    if scope_path == candidate_path:
        return True
    prefix = scope_path if scope_path.endswith("/") else f"{scope_path}/"
    return candidate_path.startswith(prefix)


def normalize_linked_web_url(raw_link: str, *, base_url: str, root_url: str) -> str | None:
    """
    ページ内リンクを絶対 URL にし、同一ホスト・同一階層だけ返す。
    """
    joined_url, _ = urldefrag(urljoin(base_url, raw_link))
    if not is_web_url(joined_url):
        return None
    normalized_url = normalize_web_url(joined_url)
    root = urlparse(root_url)
    parsed = urlparse(normalized_url)
    if parsed.scheme != root.scheme or parsed.netloc != root.netloc:
        return None
    root_path = root.path or "/"
    if not parsed.path.startswith(root_path):
        return None
    return normalized_url


def should_exclude_web_url(url: str, keywords: list[str]) -> bool:
    """
    URL 文字列に除外キーワードが含まれる場合はクロールしない。
    """
    lowered_url = url.lower()
    return any(keyword.lower() in lowered_url for keyword in keywords)


def resolve_web_file_name(url: str) -> str:
    """
    タイトルがないページの表示名を URL 末尾から作る。
    """
    parsed = urlparse(url)
    return PurePosixPath(parsed.path.rstrip("/") or parsed.netloc).name or parsed.netloc
