"""
エコシステム API（ハーネスの LLM や、ほかの自作アプリから使う共通の入口）。
共通の形は、ハーネス（opencode）の docs/apps.md の「エコシステム API 1」。

GET /api/ecosystem: アプリの名乗り。版、人が開く深いリンクのひな形、外から使ってよい操作の一覧を返す。
- version は frontend/package.json の値（読めなければ unknown）
- links は、人がブラウザで開く検索画面の URL のひな形（{q}・{folder} は、呼ぶ側が URL エンコードして埋める）
- operations に載せるのは読み取りだけ（検索・索引の状態・検索対象の一覧）。
  索引の初期化・削除・ランチャーの操作・書き出し・OS で場所を開く操作は、外の LLM に使わせないので載せない
"""

import json
from pathlib import Path

from fastapi import APIRouter, Request

router = APIRouter(prefix="/api", tags=["ecosystem"])

ECOSYSTEM_VERSION = 1
APP_ID = "search"
APP_TITLE = "Local Fulltext Search（全文検索）"
FRONTEND_PACKAGE = Path(__file__).resolve().parents[3] / "frontend" / "package.json"

OPERATIONS = [
    {"id": "search", "method": "GET", "path": "/api/search", "effect": "read"},
    {"id": "index.status", "method": "GET", "path": "/api/index/status", "effect": "read"},
    {"id": "index.targets", "method": "GET", "path": "/api/index/targets", "effect": "read"},
]
LINKS = {"home": "/", "search": "/?q={q}&search_all=1", "search_in": "/?q={q}&full_path={folder}"}


def app_version() -> str:
    """frontend/package.json の version を返す（読めなければ unknown）。"""
    try:
        return str(json.loads(FRONTEND_PACKAGE.read_text(encoding="utf-8")).get("version") or "unknown")
    except (OSError, ValueError):
        return "unknown"


@router.get("/ecosystem")
def ecosystem_manifest(request: Request) -> dict:
    """アプリの名乗り（エコシステム API 1 の共通の形）を返す。"""
    return {
        "ecosystem": ECOSYSTEM_VERSION,
        "app": APP_ID,
        "title": APP_TITLE,
        "version": app_version(),
        "base_url": str(request.base_url).rstrip("/"),
        "links": LINKS,
        "operations": OPERATIONS,
    }
