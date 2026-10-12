"""
セキュリティ対策のテスト

- 外部サイトからの書き込み系リクエスト（CSRF）とターミナル WebSocket 接続を拒否する
- 同一オリジン・localhost・設定で許可したオリジンは許可する
- Origin ヘッダーのない（ブラウザ以外の）リクエストは従来どおり許可する
- DNSリバインディング対策として、未知のホスト名（Hostヘッダー）を拒否する
- CORS は許可したオリジンにだけ応答ヘッダーを返す
- /quick/ と SPA の静的配信で配信フォルダの外のファイルを返さない
"""
import pytest
from starlette.websockets import WebSocketDisconnect

from app import security


@pytest.fixture
def target(tmp_path):
    folder = tmp_path / "work"
    folder.mkdir()
    return folder


def create_folder(client, target, **headers):
    return client.post(
        "/api/create-folder", json={"path": str(target), "name": "new"}, headers=headers
    )


class TestOriginGuard:
    def test_rejects_cross_site_write_request(self, client, target):
        response = create_folder(client, target, origin="https://evil.example.com")

        assert response.status_code == 403
        assert not (target / "new").exists()

    def test_rejects_null_origin(self, client, target):
        response = create_folder(client, target, origin="null")

        assert response.status_code == 403

    def test_allows_same_origin(self, client, target):
        response = create_folder(client, target, origin="http://testserver")

        assert response.status_code == 200
        assert (target / "new").is_dir()

    @pytest.mark.parametrize("origin", ["http://localhost:5173", "http://127.0.0.1:8001", "http://[::1]:3000"])
    def test_allows_localhost_origins(self, client, target, origin):
        assert create_folder(client, target, origin=origin).status_code == 200

    def test_allows_configured_origin(self, client, target, monkeypatch):
        from app import config

        monkeypatch.setattr(config.settings, "allowed_origins", "http://mypc.taild3cb7c.ts.net:8001, https://x.example")

        response = create_folder(client, target, origin="http://mypc.taild3cb7c.ts.net:8001")

        assert response.status_code == 200

    def test_allows_requests_without_origin(self, client, target):
        """curl やスクリプトなどブラウザ以外からの呼び出しは従来どおり"""
        assert create_folder(client, target).status_code == 200

    def test_read_requests_are_not_blocked_by_origin(self, client, target):
        response = client.get("/api/files", params={"path": str(target)}, headers={"origin": "https://evil.example.com"})

        assert response.status_code == 200
        assert "access-control-allow-origin" not in response.headers

    def test_rejects_cross_site_terminal_websocket(self, client):
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/api/terminal/ws", headers={"origin": "https://evil.example.com"}):
                pass
        assert exc.value.code == 1008


class TestHostGuard:
    @pytest.mark.parametrize("host", ["evil.example.com", "evil.example.com:8001", "rebind.attacker.net"])
    def test_rejects_unknown_host_names(self, client, target, host):
        response = client.get("/api/files", params={"path": str(target)}, headers={"host": host})

        assert response.status_code == 403
        assert "FILE_MANAGER_ALLOWED_HOSTS" in response.json()["detail"]

    @pytest.mark.parametrize(
        "host",
        ["localhost:8001", "127.0.0.1:8001", "[::1]:8001", "192.168.1.20:8001", "mypc.taild3cb7c.ts.net:8001", "testserver"],
    )
    def test_allows_local_ip_and_tailscale_hosts(self, client, target, host):
        response = client.get("/api/files", params={"path": str(target)}, headers={"host": host})

        assert response.status_code == 200

    def test_allows_machine_hostname(self, client, target, monkeypatch):
        monkeypatch.setattr(security, "_machine_host_names", lambda: {"my-pc", "my-pc.corp.local"})

        response = client.get("/api/files", params={"path": str(target)}, headers={"host": "MY-PC.corp.local:8001"})

        assert response.status_code == 200

    def test_allows_configured_host_and_wildcard(self, client, target, monkeypatch):
        from app import config

        monkeypatch.setattr(config.settings, "allowed_hosts", "files.corp.example")
        assert client.get("/api/files", params={"path": str(target)}, headers={"host": "files.corp.example"}).status_code == 200

        monkeypatch.setattr(config.settings, "allowed_hosts", "*")
        assert client.get("/api/files", params={"path": str(target)}, headers={"host": "anything.example"}).status_code == 200


class TestCors:
    def test_cors_headers_only_for_allowed_origins(self, client, target):
        allowed = client.options(
            "/api/create-folder",
            headers={"origin": "http://localhost:5173", "access-control-request-method": "POST"},
        )
        denied = client.options(
            "/api/create-folder",
            headers={"origin": "https://evil.example.com", "access-control-request-method": "POST"},
        )

        assert allowed.headers.get("access-control-allow-origin") == "http://localhost:5173"
        assert "access-control-allow-origin" not in denied.headers


class TestStaticServingContainment:
    def test_quick_does_not_serve_files_outside_dist(self, client, tmp_path, monkeypatch):
        from app import main

        dist = tmp_path / "quick-dist"
        dist.mkdir()
        (dist / "index.html").write_text("<html>quick</html>")
        (tmp_path / "secret.txt").write_text("SECRET")
        monkeypatch.setattr(main, "QUICK_DIST_DIR", dist)

        response = client.get("/quick/..%2fsecret.txt")

        assert "SECRET" not in response.text

    def test_static_file_helper_rejects_traversal(self, tmp_path):
        from app import main

        dist = tmp_path / "dist"
        dist.mkdir()
        (dist / "app.js").write_text("ok")
        (tmp_path / "secret.txt").write_text("SECRET")

        assert main.resolve_static_file(dist, "app.js") == dist / "app.js"
        assert main.resolve_static_file(dist, "../secret.txt") is None
        assert main.resolve_static_file(dist, "") is None
