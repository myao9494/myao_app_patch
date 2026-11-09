"""
ランチャーから既存 FastAPI バックエンドを呼び出す同期 API クライアント。
"""

from collections.abc import Callable
import json
import logging
import platform
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import ProxyHandler, Request, build_opener

from launcher_app.models import SearchResponse, SearchResultItem
from launcher_app.slash_commands import SlashCommand, parse_commands

UrlOpen = Callable[..., Any]
logger = logging.getLogger(__name__)
_proxyless_opener = build_opener(ProxyHandler({}))


def default_urlopen(request: Request, *, timeout: float) -> Any:
    """
    ランチャーのローカル API 通信では社内プロキシ環境変数を無視して直結する。
    """
    return _proxyless_opener.open(request, timeout=timeout)


class LauncherApiError(RuntimeError):
    """
    ランチャー UI に表示できるバックエンド通信エラー。
    """


class LauncherApiClient:
    """
    既存検索 API にランチャー向けの軽量な既定値を付けてアクセスする。
    """

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8079",
        *,
        gantt_api_base_url: str = "http://localhost:8000/api",
        timeout: float = 15.0,
        urlopen: UrlOpen = default_urlopen,
    ) -> None:
        self.base_url = base_url.rstrip("/") + "/"
        self.gantt_api_base_url = gantt_api_base_url.rstrip("/") + "/"
        self.timeout = timeout
        self._urlopen = urlopen

    def search(
        self,
        query: str,
        *,
        limit: int = 8,
        include_gantt_tasks: bool = False,
        types: str = "",
        search_type: str | None = None,
        include_path_in_filename: bool = True,
    ) -> SearchResponse:
        """
        gantt 選択時は通常検索に gantt タスク結果も追加する。
        search_type が指定された場合はハイブリッド / ベクトル / キーワード検索をディスパッチする。
        include_path_in_filename が真（既定）のときは、ファイル名検索でフォルダ名も対象にする。
        """
        is_mac = platform.system() == "Darwin"
        normalized_types = types.strip()
        effective_search_type = search_type or "hybrid"
        
        if include_gantt_tasks and not is_mac:
            endpoint = "/api/search"
            payload = {
                "q": query,
                "full_path": "",
                "search_all_enabled": True,
                "skip_refresh": True,
                "source_type": "local",
                "refresh_window_minutes": 0,
                "search_target": "all",
                "sort_by": "default",
                "sort_order": "desc",
                "limit": limit,
                "offset": 0,
                "include_snippets": True,
                "include_gantt_tasks": True,
            }
            if search_type is not None:
                payload["search_type"] = search_type
        elif is_mac:
            # macOS: 検索時に登録済みフォルダのインデックス更新を走らせる
            endpoint = "/api/search"
            payload = {
                "q": query,
                "full_path": "",
                "search_all_enabled": False,  # 登録済みフォルダを順次更新して検索するトリガー
                "skip_refresh": False,        # 更新を許可
                "refresh_window_minutes": 0,
                "search_target": "all",
                "sort_by": "default",
                "sort_order": "desc",
                "limit": limit,
                "offset": 0,
                "include_snippets": True,
            }
            if include_gantt_tasks:
                payload["include_gantt_tasks"] = True
            if search_type is not None:
                payload["search_type"] = search_type
        else:
            # 他 OS: 既存インデックスのみを使用して高速にレスポンスを返す
            endpoint = "/api/search/indexed"
            payload = {
                "q": query,
                "folder_path": "",            # 空文字で DB 全体を対象（既存インデックスのみ）
                "limit": limit,
                "offset": 0,
            }
            if search_type is not None:
                payload["search_type"] = search_type

        payload["include_path_in_filename"] = include_path_in_filename
        if normalized_types:
            payload["types"] = normalized_types
        response = self._request_json(endpoint, payload)
        return SearchResponse(
            total=int(response.get("total", 0)),
            has_more=bool(response.get("has_more", False)),
            items=[_parse_search_item(item) for item in response.get("items", [])],
        )

    def record_click(self, file_id: int, query: str = "") -> int:
        """
        選択された結果のアクセス数をバックエンドへ記録する。
        """
        response = self._request_json("/api/search/click", {"file_id": file_id, "query": query})
        return int(response.get("click_count", 0))

    def open_location(self, path: str) -> None:
        """
        バックエンドの OS 連携 API でファイル位置を開く。
        """
        self._request_json("/api/files/open-location", {"path": path})

    def open_gantt_task_input(self, task_id: int) -> None:
        """
        gantt タスクの入力画面表示をバックエンド経由で依頼する。
        """
        self._request_json(f"/api/gantt/tasks/{task_id}/open-input", {})

    def create_gantt_task(self, payload: dict[str, object]) -> dict[str, Any]:
        """
        ランチャーのメモ画面から gantt API へタスク作成リクエストを送る。
        """
        return self._request_json_to_base(self.gantt_api_base_url, "/tasks", payload)

    def get_app_settings(self) -> dict[str, Any]:
        """
        Web 設定ドロワーで保存した共有設定を取得する。
        """
        return self._request_json_get("/api/index/settings")

    def save_opencode_working_dir(self, path: str) -> str:
        """
        opencode 実行フォルダだけを共有設定の PUT（/api/index/settings）で保存し、保存後のフォルダを返す。
        送るのはこのキーだけで、他の設定はバックエンド側で据え置かれる。空文字ならバックエンドの既定フォルダが補われる。
        """
        saved = self._request_json("/api/index/settings", {"opencode_working_dir": str(path or "")}, method="PUT")
        return str(saved.get("opencode_working_dir") or "").strip()

    def save_launcher_memo(self, memo: str) -> dict[str, Any]:
        """
        ランチャーの常時保持メモだけを /api/index/settings/launcher-memo へ PUT で保存する。
        共有設定の一括保存（/api/index/settings）は使わない（他の設定ファイルを書き直さないため）。
        """
        return self._request_json("/api/index/settings/launcher-memo", {"launcher_memo": str(memo or "")}, method="PUT")

    def get_slash_commands(self) -> list[SlashCommand]:
        """OpenCode ペインの独自スラッシュコマンド一覧を /api/index/settings/launcher-slash-commands から読む。"""
        return parse_commands(self._request_json_get("/api/index/settings/launcher-slash-commands"))

    def save_slash_commands(self, commands: list[SlashCommand]) -> list[SlashCommand]:
        """独自スラッシュコマンドの一覧を丸ごと PUT で保存し、保存後の一覧を返す。"""
        payload = {"commands": [command.to_payload() for command in commands]}
        return parse_commands(self._request_json("/api/index/settings/launcher-slash-commands", payload, method="PUT"))

    def _request_json(self, path: str, payload: dict[str, object], *, method: str = "POST") -> dict[str, Any]:
        """
        JSON POST を実行し、エラー時は detail を抽出して例外へ変換する。
        """
        return self._request_json_to_base(self.base_url, path, payload, method=method)

    def _request_json_to_base(self, base_url: str, path: str, payload: dict[str, object], *, method: str = "POST") -> dict[str, Any]:
        """
        指定 base URL に対して JSON POST を実行する。
        """
        body = json.dumps(payload).encode("utf-8")
        url = urljoin(base_url, path.lstrip("/"))
        request = Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method=method,
        )
        logger.info("Launcher API request: method=%s url=%s timeout=%.1fs payload_keys=%s", method, url, self.timeout, sorted(payload.keys()))
        return self._send_json_request(request, url)

    def _request_json_get(self, path: str) -> dict[str, Any]:
        """
        ランチャー接続先 API へ JSON GET を実行する。
        """
        url = urljoin(self.base_url, path.lstrip("/"))
        request = Request(url, headers={"Content-Type": "application/json"}, method="GET")
        logger.info("Launcher API request: method=GET url=%s timeout=%.1fs", url, self.timeout)
        return self._send_json_request(request, url)

    def _send_json_request(self, request: Request, url: str) -> dict[str, Any]:
        """
        urllib リクエストを実行し、JSON レスポンスか API エラーへ変換する。
        """
        try:
            with self._open(request) as response:
                status = getattr(response, "status", None) or getattr(response, "code", None)
                raw_body = response.read().decode("utf-8")
                logger.info("Launcher API response: url=%s status=%s bytes=%d", url, status or "unknown", len(raw_body))
                return json.loads(raw_body)
        except HTTPError as error:
            message = _read_error_message(error)
            logger.warning("Launcher API HTTP error: url=%s status=%s reason=%s message=%s", url, error.code, error.reason, message)
            raise LauncherApiError(message) from error
        except URLError as error:
            message = f"APIに接続できません: {error.reason}"
            logger.warning("Launcher API connection error: url=%s reason=%s", url, error.reason)
            raise LauncherApiError(message) from error
        except (OSError, TypeError, ValueError, json.JSONDecodeError) as error:
            logger.exception("Launcher API unexpected error: url=%s", url)
            raise LauncherApiError(str(error)) from error

    def _open(self, request: Request) -> Any:
        """
        urlopen に timeout を渡してリクエストを実行する。
        """
        return self._urlopen(request, timeout=self.timeout)


def _parse_search_item(raw_item: object) -> SearchResultItem:
    """
    API の辞書レスポンスをランチャー内部モデルへ変換する。
    """
    item = raw_item if isinstance(raw_item, dict) else {}
    return SearchResultItem(
        file_id=int(item.get("file_id", 0)),
        result_kind=str(item.get("result_kind", "file")),
        source_type=str(item.get("source_type", "local")),
        target_path=str(item.get("target_path", "")),
        file_name=str(item.get("file_name", "")),
        full_path=str(item.get("full_path", "")),
        file_ext=str(item.get("file_ext", "")),
        created_at=str(item.get("created_at", "")),
        mtime=str(item.get("mtime", "")),
        click_count=int(item.get("click_count", 0)),
        snippet=str(item.get("snippet", "")),
        gantt_link=str(item.get("gantt_link") or "") or None,
        match_source=str(item.get("match_source") or "") or None,
        salient_sentence=str(item.get("salient_sentence") or "") or None,
        hybrid_score=float(item["hybrid_score"]) if item.get("hybrid_score") is not None else None,
        vector_score=float(item["vector_score"]) if item.get("vector_score") is not None else None,
    )


def _read_error_message(error: HTTPError) -> str:
    """
    FastAPI の detail 形式を優先してユーザー向け文言を取り出す。
    """
    status_prefix = f"HTTP {error.code} {error.reason}".strip()
    try:
        raw_body = error.read().decode("utf-8", errors="replace")
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return status_prefix
    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError:
        body = raw_body.strip()
        return f"{status_prefix}: {body}" if body else status_prefix
    detail = payload.get("detail") if isinstance(payload, dict) else None
    if isinstance(detail, str) and detail:
        return f"{status_prefix}: {detail}"
    if isinstance(detail, list) and detail:
        messages = [str(item.get("msg", "")) for item in detail if isinstance(item, dict)]
        detail_message = " ".join(message for message in messages if message)
        return f"{status_prefix}: {detail_message}" if detail_message else status_prefix
    return status_prefix
