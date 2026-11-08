"""
エコシステム API（ハーネスの LLM や、ほかの自作アプリから使う共通の入口）を検証する。
GET /api/ecosystem: アプリの名乗り（共通の形。版、人が開く深いリンク、外から使ってよい操作）。
索引の初期化・削除・ランチャーの操作・書き出しは、外の LLM に使わせないので載せない。
"""

import json
from pathlib import Path
import sys

from fastapi.testclient import TestClient
from starlette.routing import Match

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings
from app.main import create_app

FRONTEND_PACKAGE = Path(__file__).resolve().parents[2] / "frontend" / "package.json"


def test_manifest_has_common_shape() -> None:
    # lifespan（索引の監視・モデルの読み込み）を動かさないよう、with を使わずに呼ぶ
    client = TestClient(create_app())
    response = client.get("/api/ecosystem")
    assert response.status_code == 200
    body = response.json()
    assert body["ecosystem"] == 1
    assert body["app"] == "search"
    assert body["title"]
    assert body["version"] == json.loads(FRONTEND_PACKAGE.read_text(encoding="utf-8"))["version"]
    assert body["base_url"] == "http://testserver"
    assert body["links"]["search"] == "/?q={q}&search_all=1"
    assert body["links"]["search_in"] == "/?q={q}&full_path={folder}"
    operations = {op["id"]: op for op in body["operations"]}
    assert operations["search"] == {"id": "search", "method": "GET", "path": "/api/search", "effect": "read"}
    assert all(op["effect"] in {"read", "write", "open"} for op in body["operations"])


def test_dangerous_operations_are_not_listed() -> None:
    listed = {(op["method"], op["path"]) for op in TestClient(create_app()).get("/api/ecosystem").json()["operations"]}
    forbidden = {
        ("POST", "/api/index/reset"), ("DELETE", "/api/index/targets"), ("DELETE", "/api/files/{file_id}"),
        ("POST", "/api/launcher/stop"), ("POST", "/api/export/ai-html/save"), ("POST", "/api/files/open-location"),
    }
    assert not listed & forbidden
    assert all(method == "GET" for method, _ in listed), "載せるのは読み取りだけ"


def test_ecosystem_route_takes_precedence_over_spa_catch_all(tmp_path: Path, monkeypatch) -> None:
    frontend_dist = tmp_path / "dist"
    frontend_dist.mkdir()
    (frontend_dist / "index.html").write_text("<!doctype html>", encoding="utf-8")
    monkeypatch.setattr(settings, "frontend_dist_dir", frontend_dist)

    app = create_app()
    scope = {"type": "http", "path": "/api/ecosystem", "method": "GET"}
    first_full_match = next(route for route in app.router.routes if route.matches(scope)[0] == Match.FULL)
    assert first_full_match.path == "/api/ecosystem"
