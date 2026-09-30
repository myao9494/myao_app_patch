"""
PWA配信時のキャッシュ制御テスト
- index.html と Service Worker は常に再検証させる
- ハッシュ付き静的アセットは長期キャッシュ可能にする
"""
from pathlib import Path


class TestPwaCacheHeaders:
    """PWA静的配信のキャッシュヘッダーテスト"""

    def test_index_html_is_served_with_no_cache(self, client, temp_dir, monkeypatch):
        """index.html は古いシェルを残さないよう no-cache で返す"""
        from app import main

        dist_dir = temp_dir / "dist"
        dist_dir.mkdir()
        (dist_dir / "index.html").write_text("<!doctype html><html></html>", encoding="utf-8")

        monkeypatch.setattr(main, "FRONTEND_DIST_DIR", dist_dir)

        response = client.get("/")

        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-cache, no-store, must-revalidate"

    def test_service_worker_is_served_with_no_cache(self, client, temp_dir, monkeypatch):
        """sw.js は更新検知できるよう no-cache で返す"""
        from app import main

        dist_dir = temp_dir / "dist"
        dist_dir.mkdir()
        (dist_dir / "index.html").write_text("<!doctype html><html></html>", encoding="utf-8")
        (dist_dir / "sw.js").write_text("self.addEventListener('install', () => {})", encoding="utf-8")

        monkeypatch.setattr(main, "FRONTEND_DIST_DIR", dist_dir)

        response = client.get("/sw.js")

        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-cache, no-store, must-revalidate"

    def test_hashed_assets_are_served_as_immutable(self, client, temp_dir, monkeypatch):
        """ハッシュ付きビルドアセットは長期キャッシュ可能にする"""
        from app import main

        dist_dir = temp_dir / "dist"
        assets_dir = dist_dir / "assets"
        assets_dir.mkdir(parents=True)
        (dist_dir / "index.html").write_text("<!doctype html><html></html>", encoding="utf-8")
        (assets_dir / "index-abc123.js").write_text("console.log('ok')", encoding="utf-8")

        monkeypatch.setattr(main, "FRONTEND_DIST_DIR", dist_dir)

        response = client.get("/assets/index-abc123.js")

        assert response.status_code == 200
        assert response.headers["cache-control"] == "public, max-age=31536000, immutable"

    def test_api_routes_do_not_fallback_to_spa_index_html(self, client, temp_dir, monkeypatch):
        """存在しない /api/* ルートへのアクセスは index.html ではなく 404 JSON を返すこと"""
        from app import main

        dist_dir = temp_dir / "dist"
        dist_dir.mkdir()
        (dist_dir / "index.html").write_text("<!doctype html><html>SPA SHELL</html>", encoding="utf-8")

        monkeypatch.setattr(main, "FRONTEND_DIST_DIR", dist_dir)

        response = client.get("/api/non-existent-endpoint")

        assert response.status_code == 404
        assert response.headers.get("content-type", "").startswith("application/json")
        assert "<!doctype html>" not in response.text
        data = response.json()
        assert "detail" in data

