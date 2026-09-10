"""
quickアプリ（frontend-quick）の静的配信テスト
- /quick および /quick/ へのアクセスで frontend-quick/dist/index.html が返されること
- /quick 配下の静的アセットが適切に返されること
- /quick/xxx などのSPAルーティングで index.html へフォールバックすること
- 通常の / アクセス（本体ファイルマネージャー）と干渉しないこと
"""
from pathlib import Path


class TestQuickServing:
    """quickアプリ静的配信テスト"""

    def test_quick_serves_index_html(self, client, temp_dir, monkeypatch):
        """/quick または /quick/ で quick アプリの index.html が返されること"""
        from app import main

        quick_dist = temp_dir / "quick_dist"
        quick_dist.mkdir()
        (quick_dist / "index.html").write_text("<!doctype html><html><head><title>Quick App</title></head></html>", encoding="utf-8")

        monkeypatch.setattr(main, "QUICK_DIST_DIR", quick_dist)

        # /quick へのアクセス（リダイレクトまたは200）
        response_redirect = client.get("/quick", follow_redirects=False)
        assert response_redirect.status_code in (200, 301, 307, 308)

        # /quick/ へのアクセス
        response = client.get("/quick/")
        assert response.status_code == 200
        assert "<title>Quick App</title>" in response.text
        assert response.headers["cache-control"] == "no-cache, no-store, must-revalidate"

    def test_quick_serves_static_assets(self, client, temp_dir, monkeypatch):
        """/quick 配下の静的アセットが返されること"""
        from app import main

        quick_dist = temp_dir / "quick_dist"
        assets_dir = quick_dist / "assets"
        assets_dir.mkdir(parents=True)
        (quick_dist / "index.html").write_text("<!doctype html><html></html>", encoding="utf-8")
        (assets_dir / "quick-bundle-123456.js").write_text("console.log('quick')", encoding="utf-8")

        monkeypatch.setattr(main, "QUICK_DIST_DIR", quick_dist)

        response = client.get("/quick/assets/quick-bundle-123456.js")
        assert response.status_code == 200
        assert response.text == "console.log('quick')"
        assert response.headers["cache-control"] == "public, max-age=31536000, immutable"

    def test_quick_spa_fallback(self, client, temp_dir, monkeypatch):
        """/quick/search などの存在しないサブパスでも index.html にフォールバックすること"""
        from app import main

        quick_dist = temp_dir / "quick_dist"
        quick_dist.mkdir()
        (quick_dist / "index.html").write_text("<!doctype html><html><head><title>Quick SPA</title></head></html>", encoding="utf-8")

        monkeypatch.setattr(main, "QUICK_DIST_DIR", quick_dist)

        response = client.get("/quick/search")
        assert response.status_code == 200
        assert "<title>Quick SPA</title>" in response.text
