"""
ブラウザ経由の攻撃を防ぐためのリクエスト検証（ASGIミドルウェア）

本アプリはファイル操作・プログラム実行・ターミナルを提供するため、
利用者がブラウザで開いた別のWebサイトから操作されないようにする。

1. Origin 検証（CSRF / WebSocket ハイジャック対策）
   - 書き込み系メソッド（POST/PUT/PATCH/DELETE）とターミナル等の WebSocket が対象
   - Origin ヘッダーが付いている場合、次のいずれかでなければ 403（WebSocketは1008で切断）
       - 同一オリジン（Origin のホスト:ポート == Host ヘッダー）
       - localhost / 127.0.0.1 / [::1]（任意のポート。Vite開発サーバー等）
       - 環境変数 FILE_MANAGER_ALLOWED_ORIGINS（カンマ区切り）に列挙したオリジン
   - Origin ヘッダーがないリクエスト（curl・スクリプト等、ブラウザ以外）は従来どおり許可

2. Host 検証（DNSリバインディング対策）
   - すべてのリクエストが対象。Host ヘッダーが次のいずれかでなければ 403
       - localhost、IPアドレス（LAN・Tailscale IP を含む）
       - *.ts.net（Tailscale MagicDNS）
       - このPCのホスト名（hostname / FQDN / hostname.local）
       - 環境変数 FILE_MANAGER_ALLOWED_HOSTS（カンマ区切り、"*" で検証無効）

外部ツールからの GET /api/fullpath 等のリンク遷移は Origin 検証の対象外のため影響しない。
"""
from __future__ import annotations

import ipaddress
import json
import re
import socket
from functools import lru_cache
from urllib.parse import urlsplit

from app import config

UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
LOCALHOST_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"
_LOCALHOST_ORIGIN_RE = re.compile(LOCALHOST_ORIGIN_REGEX, re.IGNORECASE)
_TEST_HOSTS = frozenset({"testserver"})  # Starlette TestClient


def _split_csv(value: str) -> list[str]:
    return [item.strip() for item in (value or "").split(",") if item.strip()]


def configured_origins() -> list[str]:
    """環境変数 FILE_MANAGER_ALLOWED_ORIGINS で許可されたオリジン（末尾スラッシュなし）"""
    return [origin.rstrip("/") for origin in _split_csv(config.settings.allowed_origins)]


@lru_cache(maxsize=1)
def _machine_host_names() -> set[str]:
    names: set[str] = set()
    try:
        hostname = socket.gethostname()
        if hostname:
            names.update({hostname, f"{hostname}.local"})
        fqdn = socket.getfqdn()
        if fqdn:
            names.add(fqdn)
    except OSError:
        pass
    return {name.lower() for name in names}


def _strip_port(host: str) -> str:
    host = host.strip().lower()
    if host.startswith("["):  # [::1]:8001
        return host[1:].split("]", 1)[0]
    if host.count(":") == 1:
        return host.rsplit(":", 1)[0]
    return host


def is_host_allowed(host_header: str | None) -> bool:
    """Host ヘッダーが許可されたホスト名か（DNSリバインディング対策）"""
    allowed = [h.lower() for h in _split_csv(config.settings.allowed_hosts)]
    if "*" in allowed:
        return True
    if not host_header:
        return True  # HTTP/1.0 等。ブラウザは必ず Host を送るため攻撃経路にならない
    host = _strip_port(host_header)
    if host in ("localhost", *_TEST_HOSTS) or host.endswith(".localhost"):
        return True
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    if host.endswith(".ts.net"):
        return True
    return host in _machine_host_names() or host in allowed


def is_origin_allowed(origin: str, host_header: str | None) -> bool:
    """Origin が同一オリジン・localhost・設定済みのいずれかか"""
    if not origin or origin == "null":
        return False
    if _LOCALHOST_ORIGIN_RE.match(origin):
        return True
    if origin.rstrip("/") in configured_origins():
        return True
    netloc = urlsplit(origin).netloc.lower()
    return bool(host_header) and netloc == host_header.strip().lower()


def cors_origin_regex() -> str:
    """CORS で許可するオリジンの正規表現（localhost + 設定済みオリジン）"""
    patterns = [LOCALHOST_ORIGIN_REGEX[1:-1]] + [re.escape(o) for o in configured_origins()]
    return "^(" + "|".join(patterns) + ")$"


class OriginGuardMiddleware:
    """Host / Origin を検証する ASGI ミドルウェア"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        host = headers.get("host")

        if not is_host_allowed(host):
            await self._reject(
                scope, receive, send,
                f"ホスト名 {host} からのアクセスは許可されていません。"
                "backend/.env の FILE_MANAGER_ALLOWED_HOSTS に追加してください。",
            )
            return

        needs_origin_check = scope["type"] == "websocket" or scope.get("method", "GET").upper() in UNSAFE_METHODS
        origin = headers.get("origin")
        if needs_origin_check and origin is not None and not is_origin_allowed(origin, host):
            await self._reject(
                scope, receive, send,
                f"オリジン {origin} からの操作は許可されていません。"
                "必要な場合は backend/.env の FILE_MANAGER_ALLOWED_ORIGINS に追加してください。",
            )
            return

        await self.app(scope, receive, send)

    @staticmethod
    async def _reject(scope, receive, send, detail: str) -> None:
        if scope["type"] == "websocket":
            await receive()  # websocket.connect
            await send({"type": "websocket.close", "code": 1008, "reason": "origin not allowed"})
            return
        body = json.dumps({"detail": detail}, ensure_ascii=False).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": 403,
            "headers": [(b"content-type", b"application/json; charset=utf-8"), (b"content-length", str(len(body)).encode())],
        })
        await send({"type": "http.response.body", "body": body})
