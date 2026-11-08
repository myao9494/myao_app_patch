"""
エコシステム API の名乗り（ハーネスの LLM や、ほかの自作アプリから使う共通の入口）

GET /api/ecosystem が返す内容を作る。共通の形は、ハーネス（opencode）の docs/apps.md の「エコシステム API 1」。
- links.open は、人がブラウザで図を開く画面の URL のひな形（{path} は、呼ぶ側が URL エンコードして埋める）
- operations に載せるのは、読み取りの file-info だけ。図の中身を読むのは、ハーネスのスキル diagram-reader
  （ファイルを直接読む。load-file の大きな JSON を LLM に渡さない）
- コマンドの実行（run-command）・保存・移動・OS のアプリ起動は、外の LLM に使わせないので載せない
"""
import json
from pathlib import Path

ECOSYSTEM_VERSION = 1
APP_ID = "draw"
APP_TITLE = "Excalidraw（図の編集）"
PACKAGE_JSON = Path(__file__).resolve().parent.parent / "package.json"

OPERATIONS = [
    {"id": "file_info", "method": "GET", "path": "/api/file-info", "effect": "read"},
]
LINKS = {"home": "/", "open": "/?filepath={path}"}


def app_version() -> str:
    """package.json の version（読めなければ unknown）。"""
    try:
        return str(json.loads(PACKAGE_JSON.read_text(encoding="utf-8")).get("version") or "unknown")
    except (OSError, ValueError):
        return "unknown"


def build_manifest(base_url: str) -> dict:
    """アプリの名乗り（エコシステム API 1 の共通の形）。"""
    return {
        "ecosystem": ECOSYSTEM_VERSION,
        "app": APP_ID,
        "title": APP_TITLE,
        "version": app_version(),
        "base_url": base_url.rstrip("/"),
        "links": LINKS,
        "operations": OPERATIONS,
    }
