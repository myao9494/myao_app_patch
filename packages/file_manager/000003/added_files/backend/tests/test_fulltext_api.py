"""
全文検索プロキシAPIのテスト
Index(L) / Index(R) から利用する検索APIが外部全文検索サービスへ正しく中継されることを検証する
"""
from datetime import datetime, UTC


class _MockResponse:
    """httpx.Response 互換の最小モック。"""

    def __init__(self, payload, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP error: {self.status_code}")


class _MockAsyncClient:
    """テスト用の httpx.AsyncClient モック。"""

    def __init__(self, *, get_payload=None, post_payload=None, calls=None, **_kwargs):
        self._get_payload = get_payload
        self._post_payload = post_payload
        self._calls = calls if calls is not None else []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url, *, params=None, timeout=None):
        self._calls.append(("get", url, params, timeout))
        return _MockResponse(self._get_payload)

    async def post(self, url, *, json=None, timeout=None):
        self._calls.append(("post", url, json, timeout))
        return _MockResponse(self._post_payload)


class TestFulltextStatus:
    """GET /api/fulltext-search/status のテスト。"""

    def test_status_returns_ready_when_service_is_reachable(self, client, monkeypatch):
        """外部全文検索サービスの status を UI 向け形式へ変換できる。"""
        from app.routers import fulltext

        calls = []
        monkeypatch.setattr(
            fulltext.httpx,
            "AsyncClient",
            lambda **kwargs: _MockAsyncClient(
                get_payload={
                    "total_files": 123,
                    "is_running": False,
                    "last_error": None,
                },
                calls=calls,
                **kwargs,
            ),
        )

        response = client.get("/api/fulltext-search/status")

        assert response.status_code == 200
        assert response.json() == {
            "ready": True,
            "total_indexed": 123,
            "is_running": False,
            "last_error": None,
        }
        assert calls[0][0] == "get"
        assert calls[0][1].endswith("/api/index/status")


class TestFulltextSearch:
    """GET /api/fulltext-search のテスト。"""

    def test_search_proxies_to_fulltext_service_and_maps_response(self, client, monkeypatch):
        """全文検索サービスの検索結果を file_manager 用レスポンスへ変換できる。"""
        from app.routers import fulltext

        calls = []
        indexed_at = datetime(2026, 4, 14, 9, 30, tzinfo=UTC).isoformat()
        monkeypatch.setattr(
            fulltext.httpx,
            "AsyncClient",
            lambda **kwargs: _MockAsyncClient(
                post_payload={
                    "total": 1,
                    "items": [
                        {
                            "file_id": 10,
                            "target_path": "/tmp/docs",
                            "file_name": "sushi.md",
                            "full_path": "/tmp/docs/sushi.md",
                            "file_ext": ".md",
                            "mtime": indexed_at,
                            "snippet": "今日は<mark>寿司</mark>が食べたい",
                        }
                    ],
                },
                calls=calls,
                **kwargs,
            ),
        )

        response = client.get(
            "/api/fulltext-search",
            params={
                "search": "寿司",
                "path": "/tmp/docs",
                "depth": 2,
                "count": 200,
                "offset": 10,
                "file_type": "file",
            },
        )

        assert response.status_code == 200
        assert response.json() == {
            "totalResults": 1,
            "results": [
                {
                    "name": "sushi.md",
                    "path": "/tmp/docs/sushi.md",
                    "type": "file",
                    "size": None,
                    "date_modified": datetime.fromisoformat(indexed_at).timestamp(),
                    "snippet": "今日は<mark>寿司</mark>が食べたい",
                }
            ],
        }

        method, url, payload, timeout = calls[0]
        assert method == "post"
        assert url.endswith("/api/search")
        assert payload == {
            "q": "寿司",
            "full_path": "/tmp/docs",
            "index_depth": 2,
            "refresh_window_minutes": 60,
            "regex_enabled": False,
            "limit": 200,
            "offset": 10,
        }
        assert timeout == fulltext.TIMEOUT

    def test_search_with_depth_zero_converts_to_unlimited_depth(self, client, monkeypatch):
        """depth=0 (無制限階層) が指定された場合、全文検索サービスへは index_depth: 20 を送る。"""
        from app.routers import fulltext

        calls = []
        monkeypatch.setattr(
            fulltext.httpx,
            "AsyncClient",
            lambda **kwargs: _MockAsyncClient(
                post_payload={"total": 0, "items": []},
                calls=calls,
                **kwargs,
            ),
        )

        response = client.get(
            "/api/fulltext-search",
            params={
                "search": "テスト",
                "path": "/tmp/docs",
                "depth": 0,
            },
        )

        assert response.status_code == 200
        _method, _url, payload, _timeout = calls[0]
        assert payload["index_depth"] == 20

    def test_search_returns_empty_when_directory_filter_is_requested(self, client, monkeypatch):
        """全文検索はディレクトリ本文を持たないため directory 指定時は空結果を返す。"""
        from app.routers import fulltext

        calls = []
        monkeypatch.setattr(
            fulltext.httpx,
            "AsyncClient",
            lambda **kwargs: _MockAsyncClient(calls=calls, **kwargs),
        )

        response = client.get(
            "/api/fulltext-search",
            params={
                "search": "project",
                "path": "/tmp/docs",
                "depth": 1,
                "file_type": "directory",
            },
        )

        assert response.status_code == 200
        assert response.json() == {"totalResults": 0, "results": []}
        assert calls == []

    def test_search_retries_with_legacy_limit_when_fulltext_service_rejects_1000(self, client, monkeypatch):
        """古い全文検索サーバーが limit<=100 の場合でも、自動リトライで検索できる。"""
        from app.routers import fulltext

        calls = []
        indexed_at = datetime(2026, 4, 14, 9, 30, tzinfo=UTC).isoformat()

        class _RetryingAsyncClient(_MockAsyncClient):
            async def post(self, url, *, json=None, timeout=None):
                self._calls.append(("post", url, json, timeout))
                if len(self._calls) == 1:
                    return _MockResponse(
                        {
                            "detail": [
                                {
                                    "type": "less_than_equal",
                                    "loc": ["body", "limit"],
                                    "msg": "Input should be less than or equal to 100",
                                    "input": 1000,
                                    "ctx": {"le": 100},
                                }
                            ]
                        },
                        status_code=422,
                    )
                return _MockResponse(
                    {
                        "total": 1,
                        "items": [
                            {
                                "file_id": 10,
                                "target_path": "/tmp/docs",
                                "file_name": "legacy.md",
                                "full_path": "/tmp/docs/legacy.md",
                                "file_ext": ".md",
                                "mtime": indexed_at,
                                "snippet": "legacy",
                            }
                        ],
                    }
                )

        monkeypatch.setattr(
            fulltext.httpx,
            "AsyncClient",
            lambda **kwargs: _RetryingAsyncClient(calls=calls, **kwargs),
        )

        response = client.get(
            "/api/fulltext-search",
            params={
                "search": "legacy",
                "path": "/tmp/docs",
                "depth": 2,
                "count": 1000,
            },
        )

        assert response.status_code == 200
        assert response.json()["totalResults"] == 1
        assert calls[0][2]["limit"] == 1000
        assert calls[1][2]["limit"] == 100
        assert response.json()["results"][0]["snippet"] == "legacy"

    def test_search_allows_omitting_path_for_global_search(self, client, monkeypatch):
        """path 未指定時は全文検索サービスへフォルダ条件なしで中継する。"""
        from app.routers import fulltext

        calls = []
        monkeypatch.setattr(
            fulltext.httpx,
            "AsyncClient",
            lambda **kwargs: _MockAsyncClient(
                post_payload={"total": 0, "items": []},
                calls=calls,
                **kwargs,
            ),
        )

        response = client.get(
            "/api/fulltext-search",
            params={
                "search": "横断検索",
                "depth": 1,
            },
        )

        assert response.status_code == 200
        assert response.json() == {"totalResults": 0, "results": []}
        assert calls[0][2]["full_path"] == ""
