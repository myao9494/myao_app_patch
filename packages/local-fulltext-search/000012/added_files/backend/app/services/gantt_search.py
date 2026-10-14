"""
gantt アプリのタスク検索。

gantt アプリの `/tasks` を検索のたびに取得し、タスクの内容に検索語が含まれるものを検索結果として返す。
インデックスは作らない。file_id は他の結果と衝突しないよう負の値（-タスクID）にする。
リンク項目（hyperlink 等）は検索対象にも除外語の判定にも使わない。
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from html import escape
from urllib.request import Request, urlopen

from fastapi import HTTPException, status

from app.config import settings
from app.models.search import SearchQueryParams, SearchResponse, SearchResultItem
from app.services import search_query, search_result_items

GANTT_LINK_FIELD_NAMES = frozenset({"hyperlink", "link", "url", "href", "input_url", "external_url"})
GANTT_REQUEST_TIMEOUT_SECONDS = 3.0


def search_gantt_tasks(params: SearchQueryParams, *, synonym_groups: str) -> SearchResponse:
    """
    gantt アプリの `/tasks` JSON をオンデマンドで取得し、タスク本文を検索結果として返す。
    """
    tasks = fetch_gantt_tasks()
    include_groups, exclude_terms = search_query.split_search_terms(params.q.strip())
    expanded_include_terms = search_query.expand_include_terms_with_synonyms(include_groups, synonym_groups)
    flat_highlight_terms = search_query.flatten_highlight_terms(expanded_include_terms)
    lowered_exclude_terms = [term.lower() for term in exclude_terms]
    matched_items: list[SearchResultItem] = []
    now = datetime.now(tz=UTC)
    for index, task in enumerate(tasks, start=1):
        task_text = stringify_gantt_task(task)
        haystack = task_text.lower()
        if expanded_include_terms and not all(
            any(term.lower() in haystack for term in group) for group in expanded_include_terms
        ):
            continue
        if lowered_exclude_terms and any(term in haystack for term in lowered_exclude_terms):
            continue
        task_id = extract_gantt_task_id(task, fallback=index)
        task_name = extract_gantt_task_name(task, fallback=f"Task {task_id}")
        task_link = extract_gantt_task_link(task)
        matched_items.append(
            SearchResultItem(
                file_id=-task_id,
                result_kind="file",
                source_type="gantt",
                target_path=settings.gantt_api_base_url.rstrip("/") + "/tasks",
                file_name=task_name,
                full_path=f"gantt://tasks/{task_id}",
                file_ext=".gantt",
                created_at=now,
                mtime=now,
                click_count=0,
                snippet=build_gantt_snippet(task_text, flat_highlight_terms) if params.include_snippets else "",
                gantt_link=task_link,
            )
        )
    return search_result_items.paginate_search_items(matched_items, params)


def fetch_gantt_tasks() -> list[object]:
    """
    gantt API のタスク一覧レスポンスからタスク配列を取り出す。
    """
    url = settings.gantt_api_base_url.rstrip("/") + "/tasks"
    request = Request(url, headers={"Accept": "application/json"})
    try:
        with urlopen(request, timeout=3.0) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"gantt API からタスクを取得できません: {error}") from error
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("tasks", "data", "items"):
            value = payload.get(key)
            if isinstance(value, list):
                return value
    return []


def stringify_gantt_task(task: object) -> str:
    """
    gantt タスクの任意 JSON を検索しやすい平文へ変換する。
    hyperlink などのリンク項目は検索・除外語判定に使わない。
    """
    if isinstance(task, dict):
        parts: list[str] = []
        for key, value in task.items():
            if key.lower() in GANTT_LINK_FIELD_NAMES:
                continue
            if isinstance(value, (dict, list)):
                parts.append(stringify_gantt_task(value))
            elif value is not None:
                parts.append(f"{key}: {value}")
        return " ".join(parts)
    if isinstance(task, list):
        return " ".join(stringify_gantt_task(item) for item in task)
    return str(task)


def extract_gantt_task_id(task: object, *, fallback: int) -> int:
    """
    gantt タスクの代表 ID を整数へ寄せ、なければ表示順を使う。
    """
    if isinstance(task, dict):
        for key in ("id", "task_id", "uid"):
            value = task.get(key)
            try:
                return max(1, int(str(value)))
            except (TypeError, ValueError):
                continue
    return fallback


def extract_gantt_task_name(task: object, *, fallback: str) -> str:
    """
    gantt タスクのタイトル候補を検索結果名として返す。
    """
    if isinstance(task, dict):
        for key in ("text", "title", "name", "label", "content"):
            value = task.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return fallback


def extract_gantt_task_link(task: object) -> str | None:
    """
    gantt タスクに設定された外部リンク候補を取り出す。
    """
    if not isinstance(task, dict):
        return None
    for key in ("hyperlink", "link", "url", "href", "input_url", "external_url"):
        value = task.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def open_gantt_task_input(task_id: int) -> None:
    """
    gantt アプリの入力画面を、開いているガント画面上で表示する。
    """
    url = f"{settings.gantt_api_base_url.rstrip('/')}/tasks/{task_id}/open-input"
    request = Request(url, data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(request, timeout=3.0):
            return
    except OSError as error:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"gantt タスクを開けません: {error}") from error


def build_gantt_snippet(task_text: str, terms: list[str]) -> str:
    """
    gantt タスク本文の先頭付近を、検索語を mark で強調した短いスニペットにする。
    """
    snippet = escape(task_text[:280])
    for term in terms:
        if not term:
            continue
        snippet = re.sub(re.escape(escape(term)), lambda match: f"<mark>{match.group(0)}</mark>", snippet, flags=re.IGNORECASE)
    return snippet
