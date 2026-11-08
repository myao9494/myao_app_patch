"""エコシステム API（ハーネスの LLM や、ほかの自作アプリから使う共通の入口）のテスト

GET /api/ecosystem: アプリの名乗り（共通の形。版、人が開く深いリンク、外から使ってよい操作）。
コマンドの実行（run-command）・保存・移動・OS のアプリ起動は、外の LLM に使わせないので載せない。
"""
import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)


def test_manifest_has_common_shape():
    response = client.get("/api/ecosystem")
    assert response.status_code == 200
    body = response.json()
    assert body["ecosystem"] == 1
    assert body["app"] == "draw"
    assert body["title"]
    package_version = json.loads((Path(__file__).resolve().parents[1] / "package.json").read_text(encoding="utf-8"))["version"]
    assert body["version"] == package_version
    assert body["base_url"] == "http://testserver"
    assert body["links"]["open"] == "/?filepath={path}"
    operations = {op["id"]: op for op in body["operations"]}
    assert operations["file_info"] == {"id": "file_info", "method": "GET", "path": "/api/file-info", "effect": "read"}
    assert all(op["effect"] in {"read", "write", "open"} for op in body["operations"])


def test_dangerous_operations_are_not_listed():
    paths = {op["path"] for op in client.get("/api/ecosystem").json()["operations"]}
    for forbidden in ("/api/run-command", "/api/save-file", "/api/archive-file", "/api/open-file", "/api/open-url", "/api/open-in-editor", "/api/upload-files"):
        assert forbidden not in paths


def test_is_json():
    assert client.get("/api/ecosystem").headers["content-type"].startswith("application/json")
