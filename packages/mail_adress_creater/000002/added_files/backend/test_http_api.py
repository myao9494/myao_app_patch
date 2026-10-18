"""HTTP層（ルーティング・エラーコード・Origin/Host検証・キャッシュヘッダー）のテスト。

実際に ThreadingHTTPServer を空きポートで起動して検証する。DB・CSV・配信ディレクトリは一時領域を使う。
"""
from __future__ import annotations

import http.client
import json
import tempfile
import threading
import unittest
from typing import Any
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from backend import config, server, services


class HttpApiTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        base = Path(tmp.name)
        (base / "dist" / "assets").mkdir(parents=True)
        (base / "dist" / "index.html").write_text("<!doctype html><title>app</title>", encoding="utf-8")
        (base / "dist" / "sw.js").write_text("// sw", encoding="utf-8")
        (base / "dist" / "assets" / "index-abc123.js").write_text("console.log(1)", encoding="utf-8")
        patches: list[Any] = [
            patch.object(config, "BASE_DIR", base),
            patch.object(config, "DB_PATH", base / "data" / "app.sqlite3"),
            patch.object(config, "PUBLIC_CSV_PATH", base / "public" / "r.csv"),
            patch.object(config, "DIST_CSV_PATH", base / "dist" / "r.csv"),
            patch.object(server, "BIND_HOST", "127.0.0.1"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.AppHandler)
        self.port = self.httpd.server_address[1]
        thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def request(
        self,
        method: str,
        path: str,
        body: object | bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            payload = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
            conn.request(method, path, body=payload, headers=headers or {})
            response = conn.getresponse()
            return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
        finally:
            conn.close()

    def request_json(self, method: str, path: str, body: object | None = None, headers: dict[str, str] | None = None):
        status, response_headers, data = self.request(method, path, body, headers)
        return status, json.loads(data.decode("utf-8")), response_headers


class RoutingAndErrorCodesTest(HttpApiTestCase):
    def test_health_returns_settings_and_jobs(self) -> None:
        status, payload, _ = self.request_json("GET", "/api/health")

        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertIn("keywords", payload["settings"])

    def test_unknown_api_route_is_404_for_every_method(self) -> None:
        self.assertEqual(self.request_json("GET", "/api/nope")[0], 404)
        self.assertEqual(self.request_json("POST", "/api/nope", {})[0], 404)
        self.assertEqual(self.request_json("PUT", "/api/nope", {})[0], 404)

    def test_validation_errors_are_400_with_message(self) -> None:
        status, payload, _ = self.request_json("POST", "/api/parse-schedule", {"text": ""})
        self.assertEqual(status, 400)
        self.assertIn("予定内容", payload["error"])

        status, payload, _ = self.request_json("PUT", "/api/settings", {"keywords": "not-a-list"})
        self.assertEqual(status, 400)
        self.assertIn("keywords", payload["error"])

    def test_invalid_json_body_is_400(self) -> None:
        status, payload, _ = self.request_json(
            "POST", "/api/parse-schedule", b"{broken", {"Content-Type": "application/json"}
        )

        self.assertEqual(status, 400)
        self.assertIn("JSON", payload["error"])

    def test_non_object_json_body_is_400(self) -> None:
        status, _, _ = self.request_json("POST", "/api/parse-schedule", [1, 2, 3])

        self.assertEqual(status, 400)

    def test_invalid_ids_for_confirm_are_400(self) -> None:
        status, _, _ = self.request_json("POST", "/api/keyword-matches/confirm", {"ids": ["abc"]})

        self.assertEqual(status, 400)

    def test_oversized_body_is_413(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.putrequest("POST", "/api/parse-schedule")
            conn.putheader("Content-Length", str(server.MAX_BODY_BYTES + 1))
            conn.endheaders()
            response = conn.getresponse()
            self.assertEqual(response.status, 413)
        finally:
            conn.close()

    def test_malformed_content_length_is_400(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.putrequest("POST", "/api/parse-schedule")
            conn.putheader("Content-Length", "abc")
            conn.endheaders()
            response = conn.getresponse()
            self.assertEqual(response.status, 400)
        finally:
            conn.close()

    def test_unexpected_errors_are_500_and_logged(self) -> None:
        with (
            patch.object(services, "refresh_addresses", side_effect=RuntimeError("Outlookに接続できません")),
            self.assertLogs(config.LOGGER, level="ERROR"),
        ):
            status, payload, _ = self.request_json("POST", "/api/refresh-addresses", {})

        self.assertEqual(status, 500)
        self.assertEqual(payload["error"], "Outlookに接続できません")

    def test_settings_roundtrip(self) -> None:
        body = {"keywords": ["棚卸", "-除外"], "my_email": "a@example.com"}
        status, saved, _ = self.request_json("PUT", "/api/settings", body)
        self.assertEqual(status, 200)
        self.assertEqual(saved["keywords"], ["棚卸", "-除外"])

        status, loaded, _ = self.request_json("GET", "/api/settings")
        self.assertEqual(status, 200)
        self.assertEqual(loaded["my_email"], "a@example.com")


class OriginAndHostTest(HttpApiTestCase):
    def test_cross_origin_requests_are_rejected_without_cors_headers(self) -> None:
        headers = {"Origin": "https://evil.example"}
        requests = (
            ("GET", "/api/settings"),
            ("POST", "/api/parse-schedule"),
            ("PUT", "/api/settings"),
            ("OPTIONS", "/api/settings"),
        )
        for method, path in requests:
            with self.subTest(method=method):
                body: dict[str, Any] | None = {} if method in ("POST", "PUT") else None
                status, _, response_headers = self.request_json(method, path, body, headers)
                self.assertEqual(status, 403)
                self.assertNotIn("access-control-allow-origin", response_headers)

    def test_same_origin_request_gets_matching_cors_header(self) -> None:
        origin = f"http://127.0.0.1:{self.port}"

        status, _, response_headers = self.request_json("GET", "/api/settings", headers={"Origin": origin})

        self.assertEqual(status, 200)
        self.assertEqual(response_headers["access-control-allow-origin"], origin)

    def test_unexpected_host_header_is_rejected_on_loopback_binding(self) -> None:
        status, _, _ = self.request("GET", "/api/settings", headers={"Host": "attacker.example"})
        self.assertEqual(status, 403)

        status, _, _ = self.request("GET", "/", headers={"Host": "attacker.example:8765"})
        self.assertEqual(status, 403)

    def test_localhost_host_header_is_accepted(self) -> None:
        status, _, _ = self.request("GET", "/api/settings", headers={"Host": f"localhost:{self.port}"})

        self.assertEqual(status, 200)


class OriginValidationTest(unittest.TestCase):
    def test_browser_origin_must_match_request_host(self) -> None:
        self.assertTrue(server.is_allowed_browser_origin(None, "127.0.0.1:8765"))
        self.assertTrue(server.is_allowed_browser_origin("http://127.0.0.1:8765", "127.0.0.1:8765"))
        self.assertFalse(server.is_allowed_browser_origin("https://example.com", "127.0.0.1:8765"))
        self.assertFalse(server.is_allowed_browser_origin("null", "127.0.0.1:8765"))
        self.assertFalse(server.is_allowed_browser_origin("http://[::1", "127.0.0.1:8765"))


class HostValidationTest(unittest.TestCase):
    def test_loopback_binding_only_accepts_loopback_names(self) -> None:
        for host in ("127.0.0.1", "127.0.0.1:8765", "localhost:3000", "LOCALHOST", "[::1]", "[::1]:8765"):
            with self.subTest(host=host):
                self.assertTrue(server.is_allowed_host(host, "127.0.0.1"))
        rejected: list[str | None] = [None, "", "evil.example", "evil.example:8765", "127.0.0.1.evil.example"]
        for bad_host in rejected:
            with self.subTest(host=bad_host):
                self.assertFalse(server.is_allowed_host(bad_host, "127.0.0.1"))

    def test_non_loopback_binding_skips_host_validation(self) -> None:
        self.assertTrue(server.is_allowed_host("192.168.0.10:8765", "0.0.0.0"))


class CacheHeaderTest(HttpApiTestCase):
    def test_api_responses_are_not_cacheable(self) -> None:
        _, _, headers = self.request_json("GET", "/api/health")

        self.assertEqual(headers["cache-control"], "no-store")

    def test_hashed_assets_are_immutable(self) -> None:
        status, headers, _ = self.request("GET", "/assets/index-abc123.js")

        self.assertEqual(status, 200)
        self.assertIn("immutable", headers["cache-control"])

    def test_html_and_service_worker_are_revalidated(self) -> None:
        for path in ("/", "/index.html", "/sw.js"):
            with self.subTest(path=path):
                status, headers, _ = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertEqual(headers["cache-control"], "no-cache")


if __name__ == "__main__":
    unittest.main()
