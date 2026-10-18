"""Outlook宛先作成アプリ用の軽量バックエンド（HTTPサーバーと起動処理）。

Windows + Outlook + pywin32 がある環境ではOutlookから実データを取得し、
それ以外の環境では明示的なエラーを返す。CSVとSQLiteを同時に更新する。
`python backend/server.py` でも `python -m backend.server` でも起動できる。
"""
from __future__ import annotations

import json
import os
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from collections.abc import Callable
from urllib.parse import parse_qs, urlparse

if not __package__:  # python backend/server.py で直接起動された場合
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import config, db, scheduler, services  # noqa: E402
from backend.config import LOGGER  # noqa: E402


MAX_BODY_BYTES = 1_000_000
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}
# main() が実際のバインド先で更新する。ループバック以外へ公開する場合のみHostヘッダー検証を省く。
BIND_HOST = "127.0.0.1"


class HttpError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def is_allowed_browser_origin(origin: str | None, host: str | None) -> bool:
    if not origin:
        return True
    if not host:
        return False
    try:
        parsed = urlparse(origin)
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and parsed.netloc.lower() == host.lower()


def is_allowed_host(host_header: str | None, bind_host: str) -> bool:
    """ループバックで待ち受けている間は、Hostヘッダーがローカル名であることを要求する（DNSリバインディング対策）。"""
    if bind_host.lower() not in LOOPBACK_HOSTS:
        return True
    if not host_header:
        return False
    name = host_header.strip().lower()
    if name.startswith("["):
        name = name.split("]", 1)[0] + "]"
    elif name.count(":") == 1:
        name = name.split(":", 1)[0]
    return name in LOOPBACK_HOSTS


JsonObject = dict[str, Any]
GetRoute = Callable[[dict[str, list[str]]], JsonObject]
BodyRoute = Callable[[JsonObject], JsonObject]


def _health(_query: dict[str, list[str]]) -> JsonObject:
    return {"ok": True, "settings": db.get_settings(), "jobs": db.list_job_runs()}


def _keyword_matches(query: dict[str, list[str]]) -> JsonObject:
    return {
        "matches": db.list_keyword_matches(
            new_only=query.get("new_only") == ["1"],
            unconfirmed_only=query.get("unconfirmed") == ["1"],
        )
    }


def _confirm_matches(payload: JsonObject) -> JsonObject:
    ids = payload.get("ids", [])
    if not isinstance(ids, list):
        raise ValueError("ids must be an array")
    return db.confirm_keyword_matches([int(item) for item in ids])


def _add_favorite(payload: JsonObject) -> JsonObject:
    favorite = db.add_favorite(payload)
    return {"favorite": favorite, "favorites": db.list_favorites()}


def _seed_dummy_data(_payload: JsonObject) -> JsonObject:
    return {"inserted": services.seed_dummy_data(), "database": db.list_database()}


def _delete_database_records(payload: JsonObject) -> JsonObject:
    keys = payload.get("keys", [])
    if not isinstance(keys, list):
        raise ValueError("keys must be an array")
    result = db.delete_database_records(str(payload.get("table") or ""), [str(key) for key in keys])
    return {"result": result, "database": db.list_database()}


GET_ROUTES: dict[str, GetRoute] = {
    "/api/health": _health,
    "/api/settings": lambda _query: db.get_settings(),
    "/api/favorites": lambda _query: {"favorites": db.list_favorites()},
    "/api/keyword-matches": _keyword_matches,
    "/api/database": lambda _query: db.list_database(),
}

POST_ROUTES: dict[str, BodyRoute] = {
    "/api/keyword-matches/confirm": _confirm_matches,
    "/api/refresh-addresses": lambda payload: services.refresh_addresses(int(payload.get("limit", 150))),
    "/api/check-keywords": lambda payload: services.check_keywords(int(payload.get("limit", 500))),
    "/api/parse-schedule": services.parse_schedule,
    "/api/add-schedule": services.add_schedule,
    "/api/seed-dummy-data": _seed_dummy_data,
    "/api/favorites/add": _add_favorite,
    "/api/database/delete": _delete_database_records,
}

PUT_ROUTES: dict[str, BodyRoute] = {
    "/api/settings": db.save_settings,
    "/api/favorites": lambda payload: {"favorites": db.save_favorites(payload)},
}


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(config.BASE_DIR / "dist"), **kwargs)

    def cache_control(self) -> str:
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            return "no-store"
        if path.startswith("/assets/"):  # Viteがファイル名にハッシュを付けるため長期キャッシュできる
            return "public, max-age=31536000, immutable"
        return "no-cache"

    def end_headers(self) -> None:
        origin = self.headers.get("Origin")
        if origin and self.is_allowed_origin():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", self.cache_control())
        super().end_headers()

    def is_allowed_origin(self) -> bool:
        return is_allowed_browser_origin(self.headers.get("Origin"), self.headers.get("Host"))

    def ensure_allowed_request(self) -> bool:
        if not is_allowed_host(self.headers.get("Host"), BIND_HOST):
            LOGGER.warning("Rejected request with disallowed Host: %s", self.headers.get("Host"))
            self.write_json({"error": "forbidden host"}, status=403)
            return False
        if not self.is_allowed_origin():
            LOGGER.warning("Rejected request from disallowed Origin: %s", self.headers.get("Origin"))
            self.write_json({"error": "forbidden origin"}, status=403)
            return False
        return True

    def do_OPTIONS(self) -> None:
        if not self.ensure_allowed_request():
            return
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if not self.ensure_allowed_request():
            return
        if parsed.path.startswith("/api/"):
            self.dispatch(GET_ROUTES.get(parsed.path), lambda: parse_qs(parsed.query))
        else:
            super().do_GET()

    def do_POST(self) -> None:
        if self.ensure_allowed_request():
            self.dispatch(POST_ROUTES.get(urlparse(self.path).path), self.read_json)

    def do_PUT(self) -> None:
        if self.ensure_allowed_request():
            self.dispatch(PUT_ROUTES.get(urlparse(self.path).path), self.read_json)

    def dispatch(self, route: Callable[[Any], JsonObject] | None, read_argument: Callable[[], Any]) -> None:
        if route is None:
            self.write_json({"error": "not found"}, status=404)
            return
        try:
            self.write_json(route(read_argument()))
        except HttpError as exc:
            self.write_json({"error": exc.message}, status=exc.status)
        except (ValueError, TypeError, KeyError) as exc:  # 入力不備はクライアントの誤りとして扱う
            LOGGER.warning("%s %s rejected: %s", self.command, self.path, exc)
            self.write_json({"error": str(exc)}, status=400)
        except Exception as exc:  # noqa: BLE001 - Outlook COMなどの失敗をUIへ表示する
            LOGGER.exception("%s %s failed", self.command, self.path)
            self.write_json({"error": str(exc)}, status=500)

    def log_message(self, format: str, *args: Any) -> None:
        LOGGER.info("%s - %s", self.address_string(), format % args)

    def read_json(self) -> JsonObject:
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            raise HttpError(400, "Content-Lengthが正しくありません") from None
        if length < 0:
            raise HttpError(400, "Content-Lengthが正しくありません")
        if length > MAX_BODY_BYTES:
            raise HttpError(413, "リクエストが大きすぎます")
        if length == 0:
            return {}
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise HttpError(400, "リクエストのJSONが正しくありません") from None
        if not isinstance(payload, dict):
            raise HttpError(400, "リクエストはJSONオブジェクトで指定してください")
        return payload

    def write_json(self, payload: JsonObject, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    global BIND_HOST
    config.setup_logging()
    db.ensure_db()
    LOGGER.info(
        "Starting backend: base_dir=%s db_path=%s log_path=%s", config.BASE_DIR, config.DB_PATH, config.LOG_PATH
    )
    if os.environ.get("OUTLOOK_ADDRESS_DISABLE_SCHEDULER") != "1":
        threading.Thread(target=scheduler.scheduler_loop, daemon=True).start()
        LOGGER.info("Scheduler enabled")
    else:
        LOGGER.info("Scheduler disabled by OUTLOOK_ADDRESS_DISABLE_SCHEDULER")
    BIND_HOST = os.environ.get("OUTLOOK_ADDRESS_HOST", "127.0.0.1")
    port = int(os.environ.get("OUTLOOK_ADDRESS_PORT", "8765"))
    server = ThreadingHTTPServer((BIND_HOST, port), AppHandler)
    print(f"Serving Outlook address maker on http://{BIND_HOST}:{port}", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
