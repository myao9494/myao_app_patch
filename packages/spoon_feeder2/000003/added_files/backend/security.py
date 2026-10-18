"""
ローカル実行ツールとしての安全策モジュール (security.py)

仕様:
1. Git差分コマンド（ユーザー編集可能）をシェルを介さずに実行できる引数リストへ検証・変換する。
   読み取り専用のサブコマンドだけを許可し、ファイル出力や外部コマンド実行につながるオプションは拒否する。
2. ターミナルWebSocketの接続元Originを検証し、別サイトのWebページからのシェル操作（CSWSH）を防ぐ。
   Originなし（非ブラウザクライアント）とローカルホストは許可し、LAN公開時は同一Host、
   SPOONFEEDER_ALLOWED_ORIGINS（カンマ区切り）に列挙したOriginだけを追加で許可する。
3. Hostヘッダーを検証し、DNSリバインディング（攻撃者のドメインを127.0.0.1へ向けて同一オリジン扱いでAPIを呼ぶ手口）を防ぐ。
   ローカルホスト待受（既定）ではlocalhost / 127.0.0.1 / [::1] と SPOONFEEDER_ALLOWED_HOSTS（カンマ区切り）のみ許可し、
   LAN公開（SPOONFEEDER_HOSTがローカルホスト以外）を明示した場合は任意のHostを許可する。
"""

from __future__ import annotations

import os
import shlex
from urllib.parse import urlsplit

DEFAULT_GIT_DIFF_COMMAND = "git diff HEAD -- *.py"
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
READ_ONLY_GIT_SUBCOMMANDS = {"diff", "log", "show", "status", "ls-files", "rev-parse", "blame", "describe", "shortlog"}
FORBIDDEN_GIT_OPTION_PREFIXES = ("--output", "--ext-diff", "--textconv", "--open-files-in-pager", "--exec-path", "--upload-pack", "--receive-pack")


class UnsafeCommandError(ValueError):
    """許可されないGitコマンドが指定されたことを表す。"""


def parse_git_command(command: str) -> list[str]:
    """Gitコマンド文字列を、シェルを使わずに実行できる引数リストへ変換する。

    `;` `&&` `|` `$(...)` などのシェル構文は解釈されず、gitへの単なる引数として渡る。
    """
    text = (command or "").strip() or DEFAULT_GIT_DIFF_COMMAND
    try:
        args = shlex.split(text, posix=os.name != "nt")
    except ValueError as exc:
        raise UnsafeCommandError(f"コマンドを解析できません: {exc}") from exc
    if os.name == "nt":
        args = [arg[1:-1] if len(arg) >= 2 and arg[0] == arg[-1] and arg[0] in "\"'" else arg for arg in args]
    if not args or args[0] != "git":
        raise UnsafeCommandError("gitコマンドのみ実行可能です。")
    if len(args) < 2 or args[1] not in READ_ONLY_GIT_SUBCOMMANDS:
        allowed = ", ".join(sorted(READ_ONLY_GIT_SUBCOMMANDS))
        raise UnsafeCommandError(f"読み取り専用のgitサブコマンドのみ実行可能です（{allowed}）。")
    for arg in args[2:]:
        if arg == "--":
            break
        if arg.startswith(FORBIDDEN_GIT_OPTION_PREFIXES):
            raise UnsafeCommandError(f"許可されないオプションです: {arg}")
    if args[1] in {"diff", "log", "show"}:
        # リポジトリ内 .git/config の diff.external による外部コマンド実行を無効化する。
        args.insert(2, "--no-ext-diff")
    return args


def _origin_host(origin: str) -> str:
    try:
        return (urlsplit(origin).hostname or "").lower()
    except ValueError:
        return ""


def _is_loopback_bind() -> bool:
    return os.environ.get("SPOONFEEDER_HOST", "127.0.0.1").strip() in LOOPBACK_HOSTS


def is_allowed_websocket_origin(origin: str | None, host_header: str | None) -> bool:
    """WebSocket接続元Originを許可するか判定する。ブラウザは必ずOriginを付与する。"""
    if not origin:
        return True
    host = _origin_host(origin)
    if not host:
        return False
    if host in LOOPBACK_HOSTS:
        return True
    allowed = {item.strip().rstrip("/").lower() for item in os.environ.get("SPOONFEEDER_ALLOWED_ORIGINS", "").split(",") if item.strip()}
    if origin.rstrip("/").lower() in allowed:
        return True
    if not _is_loopback_bind() and host_header:
        # LAN公開を明示した場合のみ、同一Host（自分自身が配信したページ）からの接続を許可する。
        return urlsplit(origin).netloc.lower() == host_header.strip().lower()
    return False


def _host_name(host_header: str) -> str:
    """Hostヘッダー値からポートを除いたホスト名を小文字で返す（IPv6は角括弧を除く）。"""
    value = host_header.strip().lower()
    if value.startswith("["):
        return value[1:].split("]", 1)[0]
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


def is_allowed_host(host_header: str | None) -> bool:
    """Hostヘッダーを許可するか判定する。"""
    if not _is_loopback_bind():
        return True
    if not host_header:
        return False
    allowed = LOOPBACK_HOSTS | {item.strip().lower() for item in os.environ.get("SPOONFEEDER_ALLOWED_HOSTS", "").split(",") if item.strip()}
    return _host_name(host_header) in allowed


class HostGuardMiddleware:
    """許可されないHostのHTTP/WebSocketリクエストを拒否するASGIミドルウェア。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in {"http", "websocket"}:
            host = next((value.decode("latin-1") for key, value in scope.get("headers", []) if key == b"host"), None)
            if not is_allowed_host(host):
                if scope["type"] == "websocket":
                    await receive()  # websocket.connect
                    await send({"type": "websocket.close", "code": 1008})
                else:
                    body = b"Invalid Host header"
                    await send({"type": "http.response.start", "status": 403, "headers": [(b"content-type", b"text/plain; charset=utf-8"), (b"content-length", str(len(body)).encode())]})
                    await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)
