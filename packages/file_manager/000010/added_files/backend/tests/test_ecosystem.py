"""
エコシステム API（ハーネスの LLM や、ほかの自作アプリから使う共通の入口）のテスト。
GET /api/ecosystem: アプリの名乗り（共通の形。版、人が開く深いリンク、外から使ってよい操作）。
OS のアプリを起動する操作（open/*・fullpath・open-path）、削除・実行・端末は載せない。
"""


class TestEcosystemManifest:
    def test_common_shape(self, client):
        response = client.get("/api/ecosystem")
        assert response.status_code == 200
        body = response.json()
        assert body["ecosystem"] == 1
        assert body["app"] == "files"
        assert body["title"]
        assert body["version"] == "2.0.0"
        assert body["base_url"] == "http://testserver"
        assert body["links"]["folder"] == "/?path={path}"
        operations = {op["id"]: op for op in body["operations"]}
        assert operations["files.list"] == {"id": "files.list", "method": "GET", "path": "/api/files", "effect": "read"}
        assert operations["history"]["path"] == "/api/history"
        assert all(op["effect"] in {"read", "write", "open"} for op in body["operations"])

    def test_dangerous_operations_are_not_listed(self, client):
        paths = {op["path"] for op in client.get("/api/ecosystem").json()["operations"]}
        for forbidden in ("/api/delete", "/api/delete/batch", "/api/open/execute", "/api/terminal/ws", "/api/fullpath", "/api/open-path", "/api/open/default"):
            assert forbidden not in paths

    def test_is_json_not_spa(self, client):
        assert client.get("/api/ecosystem").headers["content-type"].startswith("application/json")
