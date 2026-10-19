"""
検索方式（keyword / vector / hybrid）ごとの実行と結果整形を担うディスパッチャ。

仕様:
- keyword: FTS5 全文検索の結果をそのまま返す。
- vector: ベクトル検索の結果を、除外キーワード・拡張子・除外語・有効ターゲット・実在性で絞り込んで返す。
- hybrid（既定）: キーワード検索とベクトル検索を RRF で融合する。ベクトル検索が使えない、
  または結果 0 件のときはキーワード検索結果だけを返す。
- ベクトル検索由来の結果の file_id は、全文検索DB（files テーブル）の ID へ解決する。
  files に存在しない文書は、どの files.id とも衝突しない負の合成 ID を割り当てる
  （ベクトルDBの documents.id を files.id として扱うと、クリック記録や削除が別ファイルへ作用するため）。
- hybrid の全体順位は「先頭 1 ページ分のキーワード結果とベクトル結果を RRF 融合した部分」に、
  残りのキーワード結果を元の順位のまま続けたものとする。1 ページ目は融合結果の上位 limit 件で、
  2 ページ目以降もこの全体順位から切り出すため、ページをまたいでベクトル結果が重複しない。
- hybrid の total は、キーワード検索とベクトル検索のどちらかに一致したファイルの数（重複なし）とする。
  先頭ページでは「ベクトルのみ」に見える結果が、後ろのページのキーワード結果でもある場合は 1 件として数える。
- 検索 1 回ごとに、キーワード検索・ベクトル検索・全体の所要時間を INFO ログ（Search timing）へ出す。
  遅い環境で、どの段階に時間がかかっているかを切り分けるため。
"""

from __future__ import annotations

import logging
import sqlite3
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from app.extractors.text_extractor import parse_extension_filter
from app.models.search import IndexedSearchRequest, SearchQueryParams, SearchResponse, SearchResultItem
from app.services import exclude_rules, search_query
from app.services.hybrid_search_service import (
    HybridSearchResultItem,
    normalize_path_key,
    reciprocal_rank_fusion,
)
from app.services.path_service import matches_exclude_keyword, normalize_path, normalize_path_str
from app.services.search_service import SearchService
from app.vector.searcher import SearchResponse as VectorSearchResponse
from app.vector.searcher import SearchResultItem as VectorItem
from app.vector.state import vector_state

logger = logging.getLogger(__name__)

SearchParams = SearchQueryParams | IndexedSearchRequest
FileExistsChecker = Callable[[str], bool]
StageTimings = dict[str, float]

# files テーブルに存在しないベクトル文書へ割り当てる合成 ID の基点（負数側・フォルダ/gantt の負 ID と重ならない帯域）
VECTOR_ONLY_FILE_ID_BASE = 1_000_000_000
RRF_K = 60
RRF_VECTOR_WEIGHT = 0.5
RRF_KEYWORD_WEIGHT = 0.5
_SQLITE_IN_CHUNK_SIZE = 500


def is_existing_local_file(path: str) -> bool:
    """ローカルファイルが実在するかを返す。到達不能なパスは存在しないものとして扱う。"""
    try:
        return Path(path).is_file()
    except OSError:
        return False


def resolve_vector_only_file_id(document_id: int | None) -> int:
    """files テーブルに無いベクトル文書用の、files.id と衝突しない合成 ID を返す。"""
    return -(VECTOR_ONLY_FILE_ID_BASE + int(document_id or 0))


def _is_path_descendant(path: str, root: str) -> bool:
    """パスが指定ルート自身またはその配下に属するかを、区切り文字と大文字小文字を無視して判定する。"""
    normalized_path = path.replace("\\", "/").rstrip("/").lower()
    normalized_root = root.replace("\\", "/").rstrip("/").lower()
    if normalized_path == normalized_root:
        return True
    return normalized_path.startswith(f"{normalized_root}/")


def _is_url(path: str) -> bool:
    return "://" in path


class VectorCandidateFilter:
    """ベクトル検索結果を、キーワード検索と同じ条件（除外・拡張子・対象フォルダ・実在性）で絞り込む。"""

    def __init__(
        self,
        *,
        service: SearchService,
        excluded_keywords: list[str],
        include_extensions: tuple[str, ...],
        exclude_extensions: tuple[str, ...],
        query_exclude_terms: list[str],
        target_folder: str,
        enabled_targets: list[str],
        file_exists: FileExistsChecker,
    ) -> None:
        self._service = service
        self._excluded_keywords = [keyword.strip() for keyword in excluded_keywords if keyword.strip()]
        self._include_extensions = include_extensions
        self._exclude_extensions = exclude_extensions
        self._query_exclude_terms = [term.lower() for term in query_exclude_terms]
        self._target_folder = target_folder
        self._enabled_targets = enabled_targets
        self._file_exists = file_exists

    def accepts(self, item: VectorItem) -> bool:
        path = item.full_path or item.path
        return (
            not self.is_excluded_by_keywords(path)
            and self._matches_extension_filter(path)
            and not self._matches_query_exclude_terms(path, f"{item.hit_text or ''} {item.preview or ''}")
            and self._is_within_search_scope(path)
        )

    def is_excluded_by_keywords(self, path: str) -> bool:
        """除外キーワードは本文ではなく、ファイル名・ステム・パス構成要素に対して判定する。"""
        if not path or not self._excluded_keywords:
            return False
        if path.startswith(("http://", "https://")):
            lowered = path.lower()
            return any(keyword.lower() in lowered for keyword in self._excluded_keywords)
        normalized = normalize_path(path)
        for keyword in self._excluded_keywords:
            if "/" in keyword or "\\" in keyword:
                continue
            if matches_exclude_keyword(normalized.name, keyword) or matches_exclude_keyword(normalized.stem, keyword):
                return True
        return exclude_rules.should_exclude_path(normalized, self._excluded_keywords)

    def _matches_extension_filter(self, path: str) -> bool:
        lowered = path.lower()
        if self._exclude_extensions and any(lowered.endswith(ext) for ext in self._exclude_extensions):
            return False
        if self._include_extensions and not any(lowered.endswith(ext) for ext in self._include_extensions):
            return False
        return True

    def _matches_query_exclude_terms(self, path: str, text: str) -> bool:
        if not self._query_exclude_terms:
            return False
        lowered_path = path.lower()
        lowered_text = text.lower()
        return any(term in lowered_path or term in lowered_text for term in self._query_exclude_terms)

    def _is_within_search_scope(self, path: str) -> bool:
        """現在有効な検索対象フォルダ配下にあり、ローカルファイルなら実在することを検証する。"""
        if not path:
            return False
        if self._target_folder:
            if not _is_path_descendant(path, self._target_folder):
                return False
        elif self._enabled_targets and not any(_is_path_descendant(path, target) for target in self._enabled_targets):
            return False
        if _is_url(path):
            return True
        return self._file_exists(path)


def dispatch_search(
    params: SearchParams,
    service: SearchService,
    *,
    file_exists: FileExistsChecker = is_existing_local_file,
) -> SearchResponse:
    """検索方式に応じて検索を実行し、統一レスポンスを返す。段階ごとの所要時間をログへ出す。"""
    started = time.perf_counter()
    timings: StageTimings = {}
    if params.search_type == "keyword":
        with _measure(timings, "keyword"):
            keyword_response = _run_keyword_search(params, service)
        response = _mark_keyword_only(keyword_response, search_type="keyword")
    elif params.search_type == "vector":
        response = _search_vector(params, service, file_exists=file_exists, timings=timings)
    else:
        response = _search_hybrid(params, service, file_exists=file_exists, timings=timings)
    logger.info(
        "Search timing: type=%s keyword=%.3fs vector=%.3fs total=%.3fs items=%d existing_index_only=%s",
        params.search_type,
        timings.get("keyword", 0.0),
        timings.get("vector", 0.0),
        time.perf_counter() - started,
        len(response.items),
        isinstance(params, IndexedSearchRequest),
    )
    return response


@contextmanager
def _measure(timings: StageTimings, stage: str) -> Iterator[None]:
    """ブロックの所要時間（秒）を timings[stage] へ加算する。"""
    started = time.perf_counter()
    try:
        yield
    finally:
        timings[stage] = timings.get(stage, 0.0) + time.perf_counter() - started


def _run_keyword_search(params: SearchParams, service: SearchService) -> SearchResponse:
    if isinstance(params, IndexedSearchRequest):
        return service.search_existing_index(params)
    return service.search(params)


def _mark_keyword_only(response: SearchResponse, *, search_type: str) -> SearchResponse:
    response.search_type = search_type
    for item in response.items:
        item.match_type = "keyword_only"
    return response


def _resolve_excluded_keywords(params: SearchParams, service: SearchService) -> list[str]:
    """リクエスト指定があればそれを、無ければ保存済みの除外キーワード（Web は Web 用）を使う。"""
    index_service = service.index_service
    app_settings = index_service.get_app_settings()
    default_keywords = app_settings.web_exclude_keywords if params.source_type == "web" else app_settings.exclude_keywords
    requested_keywords = getattr(params, "exclude_keywords", None)
    return exclude_rules.parse_exclude_keywords(requested_keywords if requested_keywords is not None else default_keywords)


def _list_enabled_targets(connection: sqlite3.Connection) -> list[str]:
    try:
        rows = connection.execute("SELECT full_path FROM targets WHERE is_search_target_enabled = 1").fetchall()
    except sqlite3.Error as error:
        logger.debug("Failed to query enabled targets: %s", error)
        return []
    return [str(row["full_path"]) for row in rows]


def _build_vector_query_and_filter(
    params: SearchParams,
    service: SearchService,
    *,
    file_exists: FileExistsChecker,
) -> tuple[str, VectorCandidateFilter]:
    """ベクトル検索へ渡すポジティブ語だけのクエリと、結果の絞り込み条件を組み立てる。"""
    include_term_groups, query_exclude_terms = search_query.split_search_terms(params.q)
    vector_query = " ".join(term for group in include_term_groups for term in group if term).strip()
    include_extensions, exclude_extensions = parse_extension_filter(
        params.types or params.extensions or params.index_types
    )
    target_folder = params.folder_path if isinstance(params, IndexedSearchRequest) else params.full_path
    candidate_filter = VectorCandidateFilter(
        service=service,
        excluded_keywords=_resolve_excluded_keywords(params, service),
        include_extensions=tuple(include_extensions),
        exclude_extensions=tuple(exclude_extensions),
        query_exclude_terms=query_exclude_terms,
        target_folder=(target_folder or "").strip(),
        enabled_targets=_list_enabled_targets(service.connection),
        file_exists=file_exists,
    )
    return vector_query, candidate_filter


def _run_vector_search(
    searcher,
    vector_query: str,
    *,
    limit: int,
    candidate_filter: VectorCandidateFilter,
) -> tuple[VectorSearchResponse | None, list[VectorItem]]:
    """ベクトル検索を実行して絞り込む。失敗時は検索全体を止めず、結果なしとして扱う。"""
    try:
        vector_response = searcher.search(query=vector_query, top_k=max(limit * 2, 40))
    except Exception as error:
        logger.warning("Vector search failed: %s", error, exc_info=True)
        return None, []
    return vector_response, [item for item in vector_response.results if candidate_filter.accepts(item)]


def _lookup_indexed_files(connection: sqlite3.Connection, paths: list[str]) -> dict[str, sqlite3.Row]:
    """ベクトル結果のパスに対応する files 行を、パス比較キーで引けるようまとめて取得する。"""
    normalized_paths = sorted({normalize_path_str(path) for path in paths if path and not _is_url(path)})
    found: dict[str, sqlite3.Row] = {}
    for start in range(0, len(normalized_paths), _SQLITE_IN_CHUNK_SIZE):
        chunk = normalized_paths[start : start + _SQLITE_IN_CHUNK_SIZE]
        placeholders = ",".join("?" * len(chunk))
        try:
            rows = connection.execute(
                f"""
                SELECT id, normalized_path, click_count, has_obsidian_top_tag
                FROM files
                WHERE normalized_path IN ({placeholders})
                """,
                chunk,
            ).fetchall()
        except sqlite3.Error as error:
            logger.debug("Failed to look up indexed files: %s", error)
            return found
        for row in rows:
            found[normalize_path_key(str(row["normalized_path"]))] = row
    return found


def _build_item_from_vector_path(
    *,
    path: str,
    document_id: int | None,
    indexed_files: dict[str, sqlite3.Row],
    snippet: str,
    match_type: str,
    vector_score: float | None,
    salient_sentence: str | None,
    hybrid_score: float | None = None,
    keyword_score: float | None = None,
) -> SearchResultItem:
    """ベクトル検索由来の結果を SearchResultItem へ変換する。"""
    file_path = Path(path)
    now = datetime.now(timezone.utc)
    try:
        stat = file_path.stat()
        mtime = datetime.fromtimestamp(stat.st_mtime, timezone.utc)
        created_at = datetime.fromtimestamp(stat.st_ctime, timezone.utc)
    except OSError:
        mtime = now
        created_at = now

    indexed_file = indexed_files.get(normalize_path_key(normalize_path_str(path))) if not _is_url(path) else None
    return SearchResultItem(
        file_id=int(indexed_file["id"]) if indexed_file is not None else resolve_vector_only_file_id(document_id),
        result_kind="file",
        source_type="local",
        target_path=str(file_path.parent),
        file_name=file_path.name,
        full_path=str(file_path),
        file_ext=file_path.suffix.lower(),
        created_at=created_at,
        mtime=mtime,
        click_count=int(indexed_file["click_count"]) if indexed_file is not None else 0,
        has_obsidian_top_tag=bool(indexed_file["has_obsidian_top_tag"]) if indexed_file is not None else False,
        snippet=snippet,
        match_type=match_type,
        hybrid_score=hybrid_score,
        vector_score=vector_score,
        keyword_score=keyword_score,
        salient_sentence=salient_sentence,
    )


def _search_vector(
    params: SearchParams,
    service: SearchService,
    *,
    file_exists: FileExistsChecker,
    timings: StageTimings,
) -> SearchResponse:
    empty_response = SearchResponse(total=0, items=[], has_more=False, search_type="vector")
    searcher = vector_state.get_searcher()
    if not searcher:
        return empty_response
    vector_query, candidate_filter = _build_vector_query_and_filter(params, service, file_exists=file_exists)
    if not vector_query:
        return empty_response
    with _measure(timings, "vector"):
        vector_response, vector_items = _run_vector_search(
            searcher, vector_query, limit=params.limit, candidate_filter=candidate_filter
        )
    if vector_response is None:
        return empty_response

    page_items = vector_items[: params.limit]
    indexed_files = _lookup_indexed_files(service.connection, [item.full_path or item.path for item in page_items])
    items = [
        _build_item_from_vector_path(
            path=item.full_path or item.path,
            document_id=item.document_id,
            indexed_files=indexed_files,
            snippet=item.hit_text or item.preview or "",
            match_type="vector_only",
            vector_score=item.score,
            salient_sentence=item.salient_sentence,
        )
        for item in page_items
    ]
    return SearchResponse(
        total=len(items),
        items=items,
        has_more=False,
        search_type="vector",
        rag_context_xml=vector_response.rag_context_xml,
        rag_context_markdown=vector_response.rag_context_markdown,
        detected_terms=vector_response.detected_terms,
    )


def _sort_hybrid_candidates(candidates: list[SearchResultItem], *, sort_by: str, sort_order: str) -> None:
    reverse = sort_order == "desc"
    if sort_by == "vector_score":
        candidates.sort(key=lambda item: (item.vector_score or 0.0, item.file_id), reverse=reverse)
    elif sort_by == "keyword_score":
        candidates.sort(key=lambda item: (item.keyword_score or 0.0, item.file_id), reverse=reverse)
    elif sort_by == "hybrid_score":
        candidates.sort(key=lambda item: (item.hybrid_score or 0.0, item.file_id), reverse=reverse)
    elif sort_by == "click_count":
        candidates.sort(key=lambda item: (item.click_count or 0, item.file_id), reverse=reverse)
    elif sort_by == "created":
        candidates.sort(key=lambda item: (item.created_at.timestamp(), item.file_id), reverse=reverse)
    elif sort_by == "modified":
        candidates.sort(key=lambda item: (item.mtime.timestamp(), item.file_id), reverse=reverse)
    else:
        # 既定はハイブリッド順位（hybrid_score 降順）を最優先する
        candidates.sort(
            key=lambda item: (
                item.hybrid_score or 0.0,
                item.filename_match_level or 0,
                item.mtime.timestamp(),
                item.file_id,
            ),
            reverse=True,
        )


def _build_hybrid_candidates(
    fused_items: list[HybridSearchResultItem],
    keyword_items: list[SearchResultItem],
    *,
    candidate_filter: VectorCandidateFilter,
    connection: sqlite3.Connection,
) -> list[SearchResultItem]:
    """融合結果を、キーワード結果の情報（クリック数・スニペット等）を優先して SearchResultItem へ変換する。"""
    keyword_items_by_key = {normalize_path_key(item.full_path): item for item in keyword_items}
    visible_fused_items = [item for item in fused_items if not candidate_filter.is_excluded_by_keywords(item.full_path)]
    vector_only_paths = [
        item.full_path for item in visible_fused_items if normalize_path_key(item.full_path) not in keyword_items_by_key
    ]
    indexed_files = _lookup_indexed_files(connection, vector_only_paths)

    candidates: list[SearchResultItem] = []
    for fused in visible_fused_items:
        keyword_item = keyword_items_by_key.get(normalize_path_key(fused.full_path))
        if keyword_item is not None:
            candidate = keyword_item.model_copy()
            candidate.match_type = fused.match_type
            candidate.hybrid_score = fused.hybrid_score
            candidate.salient_sentence = fused.salient_sentence
            candidate.vector_score = fused.vector_score
            candidate.keyword_score = fused.keyword_score
            if fused.snippet and not candidate.snippet:
                candidate.snippet = fused.snippet
            candidates.append(candidate)
            continue
        candidates.append(
            _build_item_from_vector_path(
                path=fused.full_path or fused.path,
                document_id=fused.document_id,
                indexed_files=indexed_files,
                snippet=fused.snippet or fused.hit_text or "",
                match_type=fused.match_type,
                vector_score=fused.vector_score,
                salient_sentence=fused.salient_sentence,
                hybrid_score=fused.hybrid_score,
                keyword_score=fused.keyword_score,
            )
        )
    return candidates


def _count_keyword_matches_outside_head(
    vector_only_candidates: list[SearchResultItem],
    keyword_response: SearchResponse,
    params: SearchParams,
    service: SearchService,
) -> int:
    """
    先頭ページの融合では「ベクトルのみ」になった結果のうち、先頭ページの外のキーワード結果でもあるものを数える
    （total に同じファイルを 2 回数えないため）。
    キーワード結果をすべて取得済みならその中から、まだ続きがあるなら DB へ問い合わせて調べる。
    """
    # 負の ID は files に無い文書（合成 ID）なので、キーワード結果にはなり得ない
    indexed_file_ids = [item.file_id for item in vector_only_candidates if item.file_id > 0]
    if not indexed_file_ids:
        return 0
    if keyword_response.total <= len(keyword_response.items):
        fetched_file_ids = {item.file_id for item in keyword_response.items if item.result_kind == "file"}
        return sum(1 for file_id in indexed_file_ids if file_id in fetched_file_ids)
    return len(service.find_matching_file_ids(params, indexed_file_ids))


def _search_hybrid(
    params: SearchParams,
    service: SearchService,
    *,
    file_exists: FileExistsChecker,
    timings: StageTimings,
) -> SearchResponse:
    # 全体順位からページを切り出せるよう、キーワード結果は常に先頭から offset + limit 件を取得する
    with _measure(timings, "keyword"):
        keyword_response = _run_keyword_search(
            params.model_copy(update={"offset": 0, "limit": params.offset + params.limit}),
            service,
        )

    vector_response: VectorSearchResponse | None = None
    vector_items: list[VectorItem] = []
    candidate_filter: VectorCandidateFilter | None = None
    searcher = vector_state.get_searcher()
    if searcher:
        vector_query, candidate_filter = _build_vector_query_and_filter(params, service, file_exists=file_exists)
        if vector_query:
            with _measure(timings, "vector"):
                vector_response, vector_items = _run_vector_search(
                    searcher, vector_query, limit=params.limit, candidate_filter=candidate_filter
                )

    if not vector_items or candidate_filter is None:
        candidates = list(keyword_response.items)
        total = keyword_response.total
    else:
        # ベクトル結果と融合するのは先頭 1 ページ分のキーワード結果だけに固定する。
        # 融合対象を offset に依存させないことで、ページをまたいでも順位が動かず重複しない。
        head_keyword_items = keyword_response.items[: params.limit]
        fused_items = reciprocal_rank_fusion(
            vector_items=vector_items,
            keyword_items=[item.model_dump() for item in head_keyword_items],
            vector_weight=RRF_VECTOR_WEIGHT,
            keyword_weight=RRF_KEYWORD_WEIGHT,
            k=RRF_K,
        )
        head_candidates = _build_hybrid_candidates(
            fused_items,
            head_keyword_items,
            candidate_filter=candidate_filter,
            connection=service.connection,
        )
        if isinstance(params, SearchQueryParams):
            _sort_hybrid_candidates(head_candidates, sort_by=params.sort_by, sort_order=params.sort_order)
        else:
            _sort_hybrid_candidates(head_candidates, sort_by="default", sort_order="desc")

        # 2 ページ目以降は、融合済みの先頭部分に続けて残りのキーワード結果を元の順位のまま並べる
        head_keys = {normalize_path_key(item.full_path) for item in head_candidates}
        tail_candidates = [
            item
            for item in keyword_response.items[params.limit :]
            if normalize_path_key(item.full_path) not in head_keys
            and not candidate_filter.is_excluded_by_keywords(item.full_path)
        ]
        candidates = [*head_candidates, *tail_candidates]
        vector_only_candidates = [item for item in head_candidates if item.match_type == "vector_only"]
        total = (
            keyword_response.total
            + len(vector_only_candidates)
            - _count_keyword_matches_outside_head(vector_only_candidates, keyword_response, params, service)
        )

    for item in candidates:
        if item.match_type is None:
            item.match_type = "keyword_only"

    page_items = candidates[params.offset : params.offset + params.limit]
    has_more = bool(page_items) and (
        params.offset + len(page_items) < len(candidates) or keyword_response.has_more
    )
    has_vector_results = vector_response is not None and bool(vector_items)
    return SearchResponse(
        total=total,
        items=page_items,
        has_more=has_more,
        next_offset=params.offset + len(page_items) if has_more else None,
        used_existing_index=keyword_response.used_existing_index,
        background_refresh_scheduled=keyword_response.background_refresh_scheduled,
        search_type="hybrid",
        rag_context_xml=vector_response.rag_context_xml if has_vector_results else None,
        rag_context_markdown=vector_response.rag_context_markdown if has_vector_results else None,
        detected_terms=vector_response.detected_terms if has_vector_results else None,
    )
