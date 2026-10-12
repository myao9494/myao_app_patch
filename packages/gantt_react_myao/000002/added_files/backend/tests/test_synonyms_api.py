"""
同義語API（/api/synonyms）のテスト。外部の同義語APIへの通信はモックする。
"""
import httpx
import pytest

from config import synonym_api_url
from routers import synonyms


@pytest.fixture
def upstream(monkeypatch):
    """外部APIの応答（JSON、または送出する例外）を差し替える。"""
    def _set(payload=None, error: Exception | None = None):
        class MockResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return payload

        class MockAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return None

            async def get(self, url):
                assert url == synonym_api_url()
                if error:
                    raise error
                return MockResponse()

        monkeypatch.setattr(synonyms.httpx, "AsyncClient", MockAsyncClient)

    return _set


def test_get_synonyms_proxies_external_service(client, upstream):
    upstream({"groups": [["PC", "パソコン"], ["AI", "人工知能"]]})

    response = client.get("/api/synonyms")

    assert response.status_code == 200
    assert response.json() == {"groups": [["PC", "パソコン"], ["AI", "人工知能"]]}


def test_get_synonyms_drops_blank_words_and_malformed_groups(client, upstream):
    upstream({"groups": [[" PC ", "", "パソコン"], "not-a-list", ["  "], [123]]})

    assert client.get("/api/synonyms").json() == {"groups": [["PC", "パソコン"], ["123"]]}


def test_get_synonyms_returns_bad_gateway_on_upstream_error(client, upstream):
    upstream(error=httpx.ConnectError("boom", request=httpx.Request("GET", synonym_api_url())))

    response = client.get("/api/synonyms")

    assert response.status_code == 502
    assert response.json()["detail"] == "failed to fetch synonyms"


def test_get_synonyms_returns_bad_gateway_on_invalid_payload(client, upstream):
    upstream({"groups": "oops"})

    assert client.get("/api/synonyms").status_code == 502
