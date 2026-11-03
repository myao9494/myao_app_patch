"""
Markdown内の3D表示（```step / ```cad）の読み取りと、Git差分で画像として比べるためのAPIのテスト。
"""

import os
import subprocess
import sys
import tempfile
import time
import unittest
from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from app.cad_views import cad_view_summaries, extract_cad_views, pair_cad_views, parse_cad_view_block  # noqa: E402
from app.main import app  # noqa: E402
from app.mesh_jobs import check_3d_availability  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NOTE_HEAD = """# note
```step
path: models/part.step
name: 部品
width: 600
height: 400
camera:
  position: [10, -200, 150]
  target: [10, 0, 20]
  zoom: 1
  viewHeight: 120
annotations:
  - id: a1
    x: 1
    y: 2
    z: 3
    text: 旧の注記
    leader: true
    ox: 90
    oy: -60
```
"""

NOTE_CURRENT = NOTE_HEAD.replace("旧の注記", "新しい注記") + """
- list
  ```cad
  path: "[[bracket.stl|L金具]]"
  name: 金具
  ```
"""

STL = b"""solid t
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 10 0 0
  vertex 0 10 0
 endloop
endfacet
endsolid t
"""


class CadViewParsingTest(unittest.TestCase):
    def test_reads_yaml_settings_like_the_plugin(self):
        views = extract_cad_views(NOTE_HEAD)
        self.assertEqual(len(views), 1)
        config = views[0]["config"]
        self.assertEqual(config["path"], "models/part.step")
        self.assertEqual((config["width"], config["height"]), (600, 400))
        self.assertEqual(config["camera"]["viewHeight"], 120.0)
        self.assertEqual(config["annotations"][0]["text"], "旧の注記")
        self.assertEqual(config["annotations"][0]["color"], "#ffc531")  # 既定のカテゴリ色

    def test_blocks_in_lists_and_callouts_and_wikilinks(self):
        text = "> [!note]\n> ```step\n> path: a/b.step\n> ```\n" + NOTE_CURRENT
        summaries = cad_view_summaries(text)
        self.assertEqual([item["model"] for item in summaries], ["b.step", "part.step", "bracket.stl"])

    def test_legacy_line_format(self):
        self.assertEqual(parse_cad_view_block("models/x.stp\nheight: 300"), {"path": "models/x.stp", "height": 300})

    def test_name_becomes_key_and_duplicates_are_distinguished(self):
        text = "```step\npath: a.step\nname: 正面\n```\n```step\npath: b.step\n```\n```step\npath: c.step\nname: 正面\n```\n"
        self.assertEqual([view["key"] for view in extract_cad_views(text)], ["正面", "#2", "正面 (2)"])

    def test_pairs_by_name_even_when_blocks_are_reordered(self):
        head = extract_cad_views("```step\npath: a.step\nname: A\n```\n```step\npath: b.step\nname: B\n```\n")
        current = extract_cad_views("```step\npath: b.step\nname: B\n```\n```step\npath: c.step\nname: C\n```\n```step\npath: a.step\nname: A\n```\n")
        pairs = {(p["head"] and p["head"]["key"], p["current"] and p["current"]["key"]): p["paired_by"] for p in pair_cad_views(head, current)}
        self.assertEqual(pairs, {("B", "B"): "name", ("A", "A"): "name", (None, "C"): None})

    def test_unnamed_head_blocks_pair_by_order_but_different_names_do_not(self):
        head = extract_cad_views("```step\npath: a.step\n```\n```step\npath: b.step\nname: old\n```\n")
        current = extract_cad_views("```step\npath: a.step\nname: 3D-1\n```\n```step\npath: b.step\nname: new\n```\n")
        pairs = {(p["head"] and p["head"]["key"], p["current"] and p["current"]["key"]): p["paired_by"] for p in pair_cad_views(head, current)}
        self.assertEqual(pairs, {("#1", "3D-1"): "order", (None, "new"): None, ("old", None): None})

    def test_other_code_blocks_are_ignored(self):
        self.assertEqual(extract_cad_views("```python\npath: a.step\n```\n```3d\npath: b.step\n```"), [])


class CadViewApiTest(unittest.TestCase):
    def setUp(self):
        os.environ["VISUAL_DIFF_OPEN_BROWSER"] = "0"
        self.client = TestClient(app)
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = self.tmp.name
        self.git("init")
        os.makedirs(os.path.join(self.repo, "models"))
        with open(os.path.join(ROOT, "samples", "step", "dimension_a.step"), "rb") as src:
            self.step = src.read()
        self.write("models/part.step", self.step)
        self.write("bracket.stl", STL)
        self.write("note.md", NOTE_HEAD.encode())
        self.git("add", ".")
        self.git("commit", "-m", "base")
        self.write("note.md", NOTE_CURRENT.encode())

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        subprocess.run(["git", "-C", self.repo, "-c", "user.name=t", "-c", "user.email=t@example.com", *args], check=True, capture_output=True)

    def write(self, rel, content):
        with open(os.path.join(self.repo, rel), "wb") as file:
            file.write(content)

    def test_listing_reports_views_of_changed_notes(self):
        body = self.client.post("/api/git/files", json={"folder": self.repo, "text_extensions": [".md"]}).json()
        note = next(item for item in body["files"] if item["path"] == "note.md")
        self.assertEqual(
            note["cad_views"],
            [
                {"key": "部品", "name": "部品", "index": 0, "model": "part.step"},
                {"key": "金具", "name": "金具", "index": 1, "model": "bracket.stl"},
            ],
        )

    @unittest.skipUnless(check_3d_availability()["available"], "3D libraries are not installed")
    def test_same_model_is_meshed_once_for_both_sides(self):
        response = self.client.post("/api/git/cad-view/jobs", json={"folder": self.repo, "path": "note.md", "key": "部品"})
        self.assertEqual(response.status_code, 202, response.text)
        body = response.json()
        self.assertEqual(body["paired_by"], "name")
        self.assertTrue(body["same_model"])
        self.assertEqual((body["head"]["mesh_side"], body["current"]["mesh_side"]), ("new", "new"))
        self.assertEqual(body["head"]["config"]["annotations"][0]["text"], "旧の注記")
        self.assertEqual(body["current"]["config"]["annotations"][0]["text"], "新しい注記")
        self.assertNotIn("content", body["head"])
        for _ in range(200):
            status = self.client.get(f"/api/3d/jobs/{body['job_id']}").json()
            if status["status"] in ("done", "error"):
                break
            time.sleep(0.1)
        self.assertEqual(status["status"], "done", status)
        self.assertEqual(self.client.get(f"/api/3d/jobs/{body['job_id']}/mesh/new").status_code, 200)
        self.client.delete(f"/api/3d/jobs/{body['job_id']}")

    def test_view_added_in_working_tree_has_only_current_side(self):
        body = self.client.post("/api/git/cad-view/jobs", json={"folder": self.repo, "path": "note.md", "key": "金具"}).json()
        self.assertIsNone(body["job_id"])
        self.assertIn("「金具」の3D表示がありません", body["head"]["error"])
        self.assertEqual(body["current"]["model_format"], "stl")
        model = self.client.post("/api/git/cad-view/model", json={"folder": self.repo, "path": body["current"]["model_path"]})
        self.assertEqual(model.content, STL)

    def test_model_endpoint_rejects_other_files(self):
        response = self.client.post("/api/git/cad-view/model", json={"folder": self.repo, "path": "note.md"})
        self.assertEqual(response.status_code, 400)

    def test_missing_view_is_404(self):
        response = self.client.post("/api/git/cad-view/jobs", json={"folder": self.repo, "path": "note.md", "key": "無い名前"})
        self.assertEqual(response.status_code, 404)

    def test_rendered_images_are_compared_without_opening_a_browser(self):
        def png(color):
            buffer = BytesIO()
            image = Image.new("RGB", (200, 120), "white")
            image.paste(color, (40, 40, 90, 80))
            image.save(buffer, format="PNG")
            return buffer.getvalue()

        response = self.client.post(
            "/api/git/cad-view/diff",
            files={"file_a": ("a.png", png((0, 0, 0)), "image/png"), "file_b": ("b.png", png((200, 0, 0)), "image/png")},
            data={"category": "図面"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertGreater(response.json()["diff_pixels"], 0)


if __name__ == "__main__":
    unittest.main()
