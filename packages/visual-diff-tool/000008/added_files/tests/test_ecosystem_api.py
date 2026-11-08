"""
エコシステム API (ハーネスや他のアプリから使う、共通の入口) の回帰テスト。
- GET /api/ecosystem: アプリの名乗り (共通の形。版、深いリンク、使ってよい操作)
- POST /api/ecosystem/diff: ローカルのファイルのパスを 2 つ受け取り、差分を「数値と位置の言葉」だけで返す
  (画像を見られない LLM 向け。base64 の画像は返さない。既定ではブラウザを開かない)
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import diff_pipeline
from backend.app.main import app

SAMPLES = Path(__file__).resolve().parents[1] / "samples"


class TestEcosystemManifest(unittest.TestCase):
    def test_manifest_has_common_shape(self):
        client = TestClient(app)
        response = client.get("/api/ecosystem")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["ecosystem"], 1)
        self.assertEqual(body["app"], "diff")
        self.assertTrue(body["title"])
        self.assertTrue(body["version"])
        self.assertEqual(body["base_url"], "http://testserver")
        self.assertEqual(body["links"]["result"], "/?result_id={result_id}")
        # Obsidian のノートの Git の変更 (ノート・埋め込みの図・画像) を、人が開く画面
        self.assertEqual(body["links"]["markdown"], "/?markdown_path={path}")
        operations = {op["id"]: op for op in body["operations"]}
        self.assertEqual(operations["diff.files"], {"id": "diff.files", "method": "POST", "path": "/api/ecosystem/diff", "effect": "read"})
        self.assertEqual(operations["git.markdown"], {"id": "git.markdown", "method": "GET", "path": "/api/git/markdown", "effect": "read"})
        self.assertNotIn("/api/git/commit", {op["path"] for op in body["operations"]}, "コミット・書き戻しは載せない")
        for op in body["operations"]:
            self.assertIn(op["effect"], {"read", "write", "open"})

    def test_manifest_is_not_swallowed_by_spa_route(self):
        # SPA の受け皿 (/{path:path}) より先に登録されていること
        response = TestClient(app).get("/api/ecosystem")
        self.assertEqual(response.headers["content-type"].split(";")[0], "application/json")


class TestEcosystemDiff(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.a = SAMPLES / "bolt_a.png"
        self.b = SAMPLES / "bolt_b.png"

    def test_returns_numbers_and_positions_without_images(self):
        with patch.object(diff_pipeline, "_open_browser") as opened:
            response = self.client.post("/api/ecosystem/diff", json={"path_a": str(self.a), "path_b": str(self.b)})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["result_id"])
        self.assertEqual(body["ui_url"], f"http://testserver/?result_id={body['result_id']}")
        self.assertEqual(body["filename_a"], "bolt_a.png")
        self.assertGreater(body["width"], 0)
        self.assertGreater(body["diff_pixels"], 0)
        self.assertGreater(body["diff_ratio"], 0)
        self.assertIn("success", body["alignment"])
        self.assertNotIn("matrix", body["alignment"])
        self.assertGreaterEqual(body["rect_count"], len(body["rects"]))
        for rect in body["rects"]:
            self.assertRegex(rect["position"], r"^(上|中|下)(左|中|右)$")
            self.assertGreater(rect["area_ratio"], 0)
        # 画像の中身 (base64) は返さない。返すとトークンを大量に使う
        text = response.text
        for key in ("image_a", "overlay", "mask", '"data"'):
            self.assertNotIn(key, text)
        opened.assert_not_called()

    def test_rects_are_largest_first_and_limited(self):
        response = self.client.post("/api/ecosystem/diff", json={"path_a": str(self.a), "path_b": str(self.b), "max_rects": 1})
        body = response.json()
        self.assertLessEqual(len(body["rects"]), 1)
        full = self.client.post("/api/ecosystem/diff", json={"path_a": str(self.a), "path_b": str(self.b)}).json()
        areas = [r["area"] for r in full["rects"]]
        self.assertEqual(areas, sorted(areas, reverse=True))

    def test_same_file_has_no_difference(self):
        body = self.client.post("/api/ecosystem/diff", json={"path_a": str(self.a), "path_b": str(self.a)}).json()
        self.assertEqual(body["diff_pixels"], 0)
        self.assertEqual(body["rects"], [])

    def test_open_browser_only_when_asked(self):
        with patch.object(diff_pipeline, "_open_browser") as opened:
            # TestClient のホストは testserver なので、localhost 以外では開かない (既存の安全の決まり)
            self.client.post("/api/ecosystem/diff", json={"path_a": str(self.a), "path_b": str(self.b), "open_browser": True})
        opened.assert_not_called()

    def test_rejects_missing_or_non_file_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            for path_a in (str(Path(tmp) / "none.png"), tmp, ""):
                response = self.client.post("/api/ecosystem/diff", json={"path_a": path_a, "path_b": str(self.b)})
                self.assertIn(response.status_code, {400, 404, 422}, path_a)

    def test_rejects_too_large_file(self):
        with patch("backend.app.routes.ecosystem.MAX_UPLOAD_BYTES", 10):
            response = self.client.post("/api/ecosystem/diff", json={"path_a": str(self.a), "path_b": str(self.b)})
        self.assertEqual(response.status_code, 413)


if __name__ == "__main__":
    unittest.main()
