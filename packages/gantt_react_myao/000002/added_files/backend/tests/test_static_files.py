"""
ビルド済みフロントエンド（dist）の静的配信のテスト。
- PWA向けのキャッシュ制御（index.html / Service Worker は常に再検証、ハッシュ付きアセットは長期キャッシュ）
- dist の外のファイルを読ませない（ディレクトリトラバーサル対策）
"""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main

NO_CACHE = "no-cache, no-store, must-revalidate"
INDEX_HTML = "<!doctype html><html>app shell</html>"
SECRET = "top secret"


@pytest.fixture
def dist(tmp_path) -> Path:
    dist_dir = tmp_path / "frontend" / "dist"
    (dist_dir / "assets").mkdir(parents=True)
    (dist_dir / "index.html").write_text(INDEX_HTML, encoding="utf-8")
    (dist_dir / "sw.js").write_text("self.addEventListener('install', () => {})", encoding="utf-8")
    (dist_dir / "workbox-abc123.js").write_text("// workbox", encoding="utf-8")
    (dist_dir / "manifest.webmanifest").write_text("{}", encoding="utf-8")
    (dist_dir / "vite.svg").write_text("<svg/>", encoding="utf-8")
    (dist_dir / "assets" / "index-CYeIsup6.js").write_text("console.log('ok')", encoding="utf-8")
    # dist の外にある、配信してはいけないファイル
    (tmp_path / "secret.txt").write_text(SECRET, encoding="utf-8")
    return dist_dir


@pytest.fixture
def static_client(dist) -> TestClient:
    return TestClient(main.create_app(frontend_dist=dist))


# --- キャッシュヘッダー ---

@pytest.mark.parametrize("filename,expected", [
    ("index.html", NO_CACHE),
    ("sw.js", NO_CACHE),
    ("manifest.webmanifest", NO_CACHE),
    ("index-abc123.js", "public, max-age=31536000, immutable"),
    ("index-CYeIsup6.css", "public, max-age=31536000, immutable"),
    ("vite.svg", "public, max-age=3600"),
    ("registerSW.js", "public, max-age=3600"),
])
def test_cache_headers_by_file_kind(filename, expected):
    assert main.build_static_cache_headers(Path("dist") / filename)["Cache-Control"] == expected


# --- 配信 ---

def test_root_serves_index_html_without_caching(static_client):
    response = static_client.get("/")

    assert response.text == INDEX_HTML
    assert response.headers["cache-control"] == NO_CACHE


def test_unknown_path_falls_back_to_index_for_spa_routing(static_client):
    response = static_client.get("/grid")

    assert response.text == INDEX_HTML
    assert response.headers["cache-control"] == NO_CACHE


def test_existing_file_is_served_as_is(static_client):
    response = static_client.get("/vite.svg")

    assert response.text == "<svg/>"
    assert response.headers["cache-control"] == "public, max-age=3600"


def test_service_worker_files_have_pwa_headers(static_client):
    sw = static_client.get("/sw.js")
    assert sw.headers["content-type"].startswith("application/javascript")
    assert sw.headers["service-worker-allowed"] == "/"
    assert sw.headers["cache-control"] == NO_CACHE

    workbox = static_client.get("/workbox-abc123.js")
    assert workbox.headers["service-worker-allowed"] == "/"

    manifest = static_client.get("/manifest.webmanifest")
    assert manifest.headers["content-type"].startswith("application/manifest+json")


def test_hashed_assets_are_served_from_assets_mount(static_client):
    response = static_client.get("/assets/index-CYeIsup6.js")

    assert response.status_code == 200
    assert response.text == "console.log('ok')"


def test_api_routes_take_precedence_over_spa_fallback(static_client):
    assert static_client.get("/api/health").json()["status"] == "ok"


# --- ディレクトリトラバーサル対策 ---

@pytest.mark.parametrize("request_path", [
    "..%2f..%2fsecret.txt",
    "%2e%2e/%2e%2e/secret.txt",
    "..%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd",
    "assets%2f..%2f..%2f..%2fsecret.txt",
])
def test_paths_escaping_dist_are_not_served(static_client, request_path):
    response = static_client.get(f"/{request_path}")

    # SPAのindex.html（/assets 配下への要求は 404）が返り、dist の外のファイルは返らない
    assert SECRET not in response.text
    assert response.text == INDEX_HTML or response.status_code == 404


def test_resolve_static_file_rejects_paths_outside_dist(dist, tmp_path):
    assert main.resolve_static_file(dist, "../../secret.txt") is None
    assert main.resolve_static_file(dist, str(tmp_path / "secret.txt")) is None
    assert main.resolve_static_file(dist, "") is None
    assert main.resolve_static_file(dist, "missing.js") is None
    assert main.resolve_static_file(dist, "vite.svg") == (dist / "vite.svg").resolve()
    assert main.resolve_static_file(dist, "assets/../vite.svg") == (dist / "vite.svg").resolve()


# --- dist が無い場合 ---

def test_root_returns_api_message_when_frontend_is_not_built(tmp_path):
    api_only_client = TestClient(main.create_app(frontend_dist=tmp_path / "no-dist"))

    assert api_only_client.get("/").json() == {"message": "Gantt Chart API (Frontend not found)"}
    assert api_only_client.get("/api/health").status_code == 200
