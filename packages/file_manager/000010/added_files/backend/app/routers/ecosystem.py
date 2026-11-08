"""
エコシステム API ルーター（ハーネスの LLM や、ほかの自作アプリから使う共通の入口）
- GET /api/ecosystem: アプリの名乗り。版、人が開く深いリンクのひな形、外から使ってよい操作の一覧
  共通の形は、ハーネス（opencode）の docs/apps.md の「エコシステム API 1」
- operations に載せるのは、読み取りだけ（一覧・パスの情報・最近のフォルダ）。
  OS のアプリを起動する操作（open/*・fullpath・open-path。実行ファイルを開くと実行される）、
  削除・実行・端末は、外の LLM から使わせないので載せない
- links は、人がブラウザで開く画面の URL のひな形（{path} は、呼ぶ側が URL エンコードして埋める）
"""
from fastapi import APIRouter, Request

router = APIRouter()

ECOSYSTEM_VERSION = 1
APP_ID = "files"
APP_TITLE = "File Manager（ファイルとフォルダ）"

OPERATIONS = [
    {"id": "files.list", "method": "GET", "path": "/api/files", "effect": "read"},
    {"id": "files.path_info", "method": "GET", "path": "/api/path-info", "effect": "read"},
    {"id": "history", "method": "GET", "path": "/api/history", "effect": "read"},
]
LINKS = {"home": "/", "folder": "/?path={path}"}


@router.get("/ecosystem")
def ecosystem_manifest(request: Request) -> dict:
    """アプリの名乗り（エコシステム API 1 の共通の形）"""
    return {
        "ecosystem": ECOSYSTEM_VERSION,
        "app": APP_ID,
        "title": APP_TITLE,
        "version": request.app.version,
        "base_url": str(request.base_url).rstrip("/"),
        "links": LINKS,
        "operations": OPERATIONS,
    }
