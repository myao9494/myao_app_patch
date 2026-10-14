import os
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))


def static_file_response(path: Path):
    from backend.main import CacheControlledStaticFiles

    static_files = CacheControlledStaticFiles(directory=str(path.parent))
    return static_files.file_response(
        str(path),
        os.stat(path),
        {"method": "GET", "headers": []},
    )


def test_static_files_are_served_with_cache_headers():
    dist_path = PROJECT_ROOT / "dist"

    manifest_response = static_file_response(dist_path / "manifest.json")
    assert manifest_response.headers["cache-control"] == "no-cache, no-store, must-revalidate"

    script_path = next((dist_path / "assets").glob("index-*.js"))
    script_response = static_file_response(script_path)
    assert script_response.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_service_worker_allows_root_scope():
    response = static_file_response(PROJECT_ROOT / "dist" / "sw.js")

    assert response.headers["cache-control"] == "no-cache, no-store, must-revalidate"
    assert response.headers["service-worker-allowed"] == "/"
