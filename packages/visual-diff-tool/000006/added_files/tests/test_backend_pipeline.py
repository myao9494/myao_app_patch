import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from backend.app.attachments import ATTACHMENTS_DIR, cleanup_expired_attachments
from backend.app.diffing import build_visual_diff
from backend.app.git_repo import git_output, run_git_process
from backend.app.image_io import (
    _decompress_lz_string_base64,
    _prepare_svg_for_rasterization,
    _smooth_excalidraw_points,
    rasterize_upload_page,
)
from backend.app.main import app
from backend.app.result_cache import store_diff_images
from backend.app.text_diff import build_text_diff_rows


class TestBackendPipeline(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        root = os.path.dirname(os.path.dirname(__file__))
        self.samples_dir = os.path.join(root, "samples")

    def test_health(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")

    def test_serves_built_frontend(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/html", response.headers["content-type"])
        self.assertIn("Visual Diff Tool", response.text)

    def test_serves_api_guide_route(self):
        response = self.client.get("/api-guide")
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/html", response.headers["content-type"])
        self.assertIn("Visual Diff Tool", response.text)

    def test_analyze_png(self):
        with open(os.path.join(self.samples_dir, "gear_a.png"), "rb") as image:
            response = self.client.post("/api/analyze", files={"file": ("gear_a.png", image, "image/png")})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["page_count"], 1)
        self.assertEqual(body["pages"][0]["width"], 800)
        self.assertEqual(body["pages"][0]["height"], 600)

    def test_analyze_and_convert_multipage_pdf(self):
        import fitz

        doc = fitz.open()
        page_a = doc.new_page(width=120, height=80)
        page_a.draw_rect(fitz.Rect(10, 10, 80, 50), color=(1, 0, 0), fill=(1, 0, 0))
        page_b = doc.new_page(width=90, height=140)
        page_b.draw_rect(fitz.Rect(15, 20, 70, 120), color=(0, 0, 1), fill=(0, 0, 1))
        pdf = BytesIO(doc.tobytes())

        analyze_response = self.client.post("/api/analyze", files={"file": ("pages.pdf", pdf, "application/pdf")})
        self.assertEqual(analyze_response.status_code, 200)
        self.assertEqual(analyze_response.json()["page_count"], 2)

        pdf.seek(0)
        convert_response = self.client.post(
            "/api/convert",
            files={"file": ("pages.pdf", pdf, "application/pdf")},
            data={"page": "1"},
        )
        self.assertEqual(convert_response.status_code, 200)
        self.assertEqual(convert_response.json()["page"], 1)

    def test_analyze_and_convert_multipage_tiff(self):
        frame_a = Image.new("RGB", (80, 60), "white")
        frame_b = Image.new("RGB", (120, 90), "black")
        tiff = BytesIO()
        frame_a.save(tiff, format="TIFF", save_all=True, append_images=[frame_b])
        tiff.seek(0)

        analyze_response = self.client.post("/api/analyze", files={"file": ("pages.tiff", tiff, "image/tiff")})
        self.assertEqual(analyze_response.status_code, 200)
        self.assertEqual(analyze_response.json()["page_count"], 2)

        tiff.seek(0)
        convert_response = self.client.post(
            "/api/convert",
            files={"file": ("pages.tiff", tiff, "image/tiff")},
            data={"page": "1"},
        )
        self.assertEqual(convert_response.status_code, 200)
        self.assertEqual(convert_response.json()["page"], 1)
        self.assertEqual(convert_response.json()["width"], 120)
        self.assertEqual(convert_response.json()["height"], 90)

    def test_convert_png_suggests_anchor_regions(self):
        with open(os.path.join(self.samples_dir, "gear_a.png"), "rb") as image:
            response = self.client.post(
                "/api/convert",
                files={"file": ("gear_a.png", image, "image/png")},
                data={"page": "0"},
            )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn("regions", body)
        self.assertGreater(len(body["regions"]), 0)
        first_region = body["regions"][0]
        self.assertIn("label", first_region)
        self.assertGreater(first_region["width"], 20)
        self.assertGreater(first_region["height"], 20)

    def test_svg_conversion_falls_back_when_cairosvg_native_library_is_unavailable(self):
        svg = b"""<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80">
          <rect x="10" y="10" width="80" height="40" fill="#cc0000"/>
        </svg>"""
        original_import = __import__

        def blocked_cairosvg_import(name, globals=None, locals=None, fromlist=(), level=0):
            if name == "cairosvg":
                raise OSError("no native cairo library")
            return original_import(name, globals, locals, fromlist, level)

        with patch("builtins.__import__", side_effect=blocked_cairosvg_import):
            fmt, page = rasterize_upload_page("shape.svg", svg)

        self.assertEqual(fmt, "svg")
        self.assertEqual(page.image.size, (120, 80))

    def test_drawio_svg_converts_html_text_and_preserves_line_breaks(self):
        svg = '''<?xml version="1.0" encoding="UTF-8"?>
        <svg xmlns="http://www.w3.org/2000/svg" width="120" height="80">
          <g transform="translate(20,20)">
            <switch>
              <foreignObject width="80" height="20">
                <div xmlns="http://www.w3.org/1999/xhtml" style="padding-top: 20px; margin-left: 0px; width: 80px; justify-content: center;">
                  <div style="font-size: 12px; color: light-dark(#000000, #ffffff)">HTML label メール<div>second line</div></div>
                </div>
              </foreignObject>
              <text x="0" y="16">SVG label...</text>
            </switch>
          </g>
        </svg>'''.encode()

        prepared = _prepare_svg_for_rasterization(svg)

        self.assertNotIn(b"foreignObject", prepared)
        self.assertNotIn(b"SVG label...", prepared)
        self.assertIn(b"HTML label", prepared)
        self.assertIn(b"second line", prepared)
        self.assertIn("メール".encode(), prepared)
        self.assertIn("メ−ル".encode(), prepared)
        self.assertNotIn(b"light-dark(", prepared)

        fmt, page = rasterize_upload_page("drawio.svg", svg)
        self.assertEqual(fmt, "svg")
        self.assertEqual(page.image.size, (300, 200))

    def test_lz_string_base64_decompression_matches_obsidian_excalidraw_format(self):
        self.assertEqual(_decompress_lz_string_base64("BIUwNmD2AEDukCcwBMCEQ==="), "Hello world!")

    def test_convert_graph_suggests_plot_frame_region(self):
        with open(os.path.join(self.samples_dir, "bathtub_curve_a.png"), "rb") as image:
            response = self.client.post(
                "/api/convert",
                files={"file": ("bathtub_curve_a.png", image, "image/png")},
                data={"page": "0"},
            )
        self.assertEqual(response.status_code, 200)
        regions = response.json()["regions"]
        frame = next((region for region in regions if region["label"] == "枠線候補"), None)
        self.assertIsNotNone(frame)
        self.assertLess(frame["x"], 90)
        self.assertLess(frame["y"], 45)
        self.assertGreater(frame["width"], 680)
        self.assertGreater(frame["height"], 480)

    def test_attachment_upload_saves_file_and_cleanup_removes_old_files(self):
        with open(os.path.join(self.samples_dir, "gear_a.png"), "rb") as image:
            response = self.client.post("/api/attachments", files={"file": ("clipboard.png", image, "image/png")})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        saved_path = ATTACHMENTS_DIR / body["stored_as"]
        self.assertTrue(saved_path.exists())
        self.assertEqual(body["retention_days"], 3)

        old_time = (datetime.now(timezone.utc) - timedelta(days=4)).timestamp()
        os.utime(saved_path, (old_time, old_time))
        self.assertEqual(cleanup_expired_attachments(), 1)
        self.assertFalse(saved_path.exists())

    def test_diff_png_pair(self):
        with open(os.path.join(self.samples_dir, "gear_a.png"), "rb") as a, open(
            os.path.join(self.samples_dir, "gear_b.png"), "rb"
        ) as b:
            response = self.client.post(
                "/api/diff",
                files={
                    "file_a": ("gear_a.png", a, "image/png"),
                    "file_b": ("gear_b.png", b, "image/png"),
                },
                data={"page_a": "0", "page_b": "0", "category": "図面"},
            )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertGreater(body["diff_pixels"], 0)
        self.assertIn("overlay", body)
        self.assertIn("image_b_aligned", body)
        self.assertIsInstance(body["diff_rects"], list)

    def test_visual_diff_keeps_thin_line_changes(self):
        reference = np.full((80, 80, 3), 255, dtype=np.uint8)
        changed = reference.copy()
        changed[40, 10:70] = (0, 0, 0)

        diff = build_visual_diff(reference, changed, threshold=0.1)

        self.assertGreater(diff["diff_pixels"], 0)
        self.assertTrue(any(rect["width"] >= 55 and rect["height"] <= 5 for rect in diff["rects"]))

    def test_visual_diff_distinguishes_added_and_removed_ink(self):
        reference = np.full((80, 80, 3), 255, dtype=np.uint8)
        changed = reference.copy()
        reference[15:35, 15:35] = (0, 0, 0)
        changed[45:65, 45:65] = (0, 0, 0)

        diff = build_visual_diff(reference, changed, threshold=0.1)

        self.assertGreaterEqual(len(diff["rects"]), 2)

    def test_visual_diff_keeps_larger_candidate_canvas(self):
        reference = np.full((80, 100, 3), 255, dtype=np.uint8)
        changed = np.full((110, 140, 3), 255, dtype=np.uint8)
        changed[90:105, 115:135] = (0, 0, 0)

        diff = build_visual_diff(reference, changed, threshold=0.1)

        self.assertEqual(diff["overlay"].shape[:2], (110, 140))
        self.assertTrue(any(rect["x"] >= 110 and rect["y"] >= 85 for rect in diff["rects"]))

    def test_excalidraw_rasterizes_elements_outside_default_canvas(self):
        payload = {
            "type": "excalidraw",
            "elements": [
                {
                    "id": "far-rect",
                    "type": "rectangle",
                    "x": 2200,
                    "y": -500,
                    "width": 120,
                    "height": 80,
                    "strokeColor": "#000000",
                    "backgroundColor": "transparent",
                    "strokeWidth": 2,
                    "isDeleted": False,
                }
            ],
            "appState": {},
        }
        response = self.client.post(
            "/api/analyze",
            files={"file": ("far.excalidraw", BytesIO(json.dumps(payload).encode("utf-8")), "application/json")},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["page_count"], 1)
        self.assertGreaterEqual(body["pages"][0]["width"], 260)
        self.assertGreaterEqual(body["pages"][0]["height"], 220)

    def test_excalidraw_reports_approximated_elements(self):
        payload = {
            "type": "excalidraw",
            "elements": [
                {
                    "id": "rotated-rect",
                    "type": "rectangle",
                    "x": 10,
                    "y": 10,
                    "width": 120,
                    "height": 80,
                    "angle": 0.5,
                    "strokeColor": "#000000",
                    "backgroundColor": "transparent",
                    "strokeWidth": 2,
                    "isDeleted": False,
                }
            ],
            "appState": {},
        }

        response = self.client.post(
            "/api/analyze",
            files={"file": ("rotated.excalidraw", BytesIO(json.dumps(payload).encode("utf-8")), "application/json")},
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(any("rotation" in warning for warning in response.json()["warnings"]))

    def test_excalidraw_honors_canvas_background_color(self):
        payload = {
            "type": "excalidraw",
            "elements": [
                {
                    "id": "rect",
                    "type": "rectangle",
                    "x": 10,
                    "y": 10,
                    "width": 40,
                    "height": 30,
                    "strokeColor": "#000000",
                    "backgroundColor": "transparent",
                    "strokeWidth": 1,
                    "isDeleted": False,
                }
            ],
            "appState": {"viewBackgroundColor": "#123456"},
        }

        _, page = rasterize_upload_page("background.excalidraw", json.dumps(payload).encode("utf-8"))

        self.assertEqual(page.image.getpixel((0, 0)), (18, 52, 86))

    def test_excalidraw_line_points_outside_nominal_bounds_are_not_cropped(self):
        payload = {
            "type": "excalidraw",
            "elements": [{
                "id": "stem",
                "type": "line",
                "x": 0,
                "y": 0,
                "width": 100,
                "height": 10,
                "points": [[0, 0], [40, -120], [100, -80]],
                "strokeColor": "#000000",
                "strokeWidth": 2,
                "isDeleted": False,
            }],
            "appState": {},
        }
        _, page = rasterize_upload_page("line.excalidraw", json.dumps(payload).encode("utf-8"))
        self.assertGreaterEqual(page.image.height, 280)

    def test_excalidraw_line_points_are_interpolated_for_smooth_joins(self):
        points = [(0.0, 0.0), (25.0, 40.0), (100.0, 30.0)]
        smoothed = _smooth_excalidraw_points(points)
        self.assertGreater(len(smoothed), len(points))
        self.assertEqual(smoothed[0], points[0])
        self.assertEqual(smoothed[-1], points[-1])
        self.assertTrue(any(0 < point[0] < 25 and point[1] > 0 for point in smoothed))

    def test_diff_accepts_anchor_region(self):
        anchor_region = {"x": 0, "y": 0, "width": 800, "height": 600, "label": "全体枠候補"}
        with open(os.path.join(self.samples_dir, "gear_a.png"), "rb") as a, open(
            os.path.join(self.samples_dir, "gear_b.png"), "rb"
        ) as b:
            response = self.client.post(
                "/api/diff",
                files={
                    "file_a": ("gear_a.png", a, "image/png"),
                    "file_b": ("gear_b.png", b, "image/png"),
                },
                data={"page_a": "0", "page_b": "0", "category": "図面", "anchor_region": json.dumps(anchor_region)},
            )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["alignment"]["success"], body["alignment"]["warning"])
        self.assertIn("anchor region", body["alignment"]["method"])

    def test_diff_accepts_different_size_and_aspect_ratio_screenshots(self):
        source = Image.open(os.path.join(self.samples_dir, "gear_a.png")).convert("RGB")
        reference = source.crop((50, 50, 650, 260)).resize((584, 158))
        candidate = source.crop((30, 30, 760, 460)).resize((502, 296))

        reference_buf = BytesIO()
        candidate_buf = BytesIO()
        reference.save(reference_buf, format="PNG")
        candidate.save(candidate_buf, format="PNG")
        reference_buf.seek(0)
        candidate_buf.seek(0)

        response = self.client.post(
            "/api/diff",
            files={
                "file_a": ("reference-crop.png", reference_buf, "image/png"),
                "file_b": ("candidate-crop.png", candidate_buf, "image/png"),
            },
            data={"page_a": "0", "page_b": "0", "category": "汎用"},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["alignment"]["success"], body["alignment"]["warning"])
        self.assertGreaterEqual(body["width"], 584)
        self.assertGreaterEqual(body["height"], 158)

    def test_diff_response_keeps_larger_unmatched_candidate_area(self):
        reference = Image.new("RGB", (100, 80), "white")
        candidate = Image.new("RGB", (140, 110), "white")
        for x in range(115, 135):
            for y in range(90, 105):
                candidate.putpixel((x, y), (0, 0, 0))

        reference_buf = BytesIO()
        candidate_buf = BytesIO()
        reference.save(reference_buf, format="PNG")
        candidate.save(candidate_buf, format="PNG")
        reference_buf.seek(0)
        candidate_buf.seek(0)

        response = self.client.post(
            "/api/diff",
            files={
                "file_a": ("small.png", reference_buf, "image/png"),
                "file_b": ("large.png", candidate_buf, "image/png"),
            },
            data={"page_a": "0", "page_b": "0", "category": "汎用"},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["width"], 140)
        self.assertEqual(body["height"], 110)
        self.assertTrue(any(rect["x"] >= 110 and rect["y"] >= 85 for rect in body["diff_rects"]))

    def test_diff_threshold_controls_sensitivity(self):
        def request_with_threshold(value):
            with open(os.path.join(self.samples_dir, "gear_a.png"), "rb") as a, open(
                os.path.join(self.samples_dir, "gear_b.png"), "rb"
            ) as b:
                return self.client.post(
                    "/api/diff",
                    files={
                        "file_a": ("gear_a.png", a, "image/png"),
                        "file_b": ("gear_b.png", b, "image/png"),
                    },
                    data={"page_a": "0", "page_b": "0", "category": "図面", "diff_threshold": str(value)},
                ).json()

        sensitive = request_with_threshold(0.03)
        tolerant = request_with_threshold(0.4)
        self.assertEqual(sensitive["diff_threshold"], 0.03)
        self.assertEqual(tolerant["diff_threshold"], 0.4)
        self.assertGreaterEqual(sensitive["diff_pixels"], tolerant["diff_pixels"])

    def test_rediff_reuses_aligned_images_without_realigning(self):
        with open(os.path.join(self.samples_dir, "gear_a.png"), "rb") as a, open(
            os.path.join(self.samples_dir, "gear_b.png"), "rb"
        ) as b:
            response = self.client.post(
                "/api/diff",
                files={
                    "file_a": ("gear_a.png", a, "image/png"),
                    "file_b": ("gear_b.png", b, "image/png"),
                },
                data={"page_a": "0", "page_b": "0", "category": "図面", "diff_threshold": "0.03"},
            )
        self.assertEqual(response.status_code, 200)
        diff_body = response.json()
        self.assertTrue(diff_body["result_id"])

        rediff_response = self.client.post(
            "/api/rediff",
            json={
                "result_id": diff_body["result_id"],
                "diff_threshold": 0.4,
            },
        )
        self.assertEqual(rediff_response.status_code, 200)
        rediff_body = rediff_response.json()
        self.assertEqual(rediff_body["diff_threshold"], 0.4)
        self.assertLessEqual(rediff_body["diff_pixels"], diff_body["diff_pixels"])
        self.assertIn("overlay", rediff_body)
        self.assertIn("mask", rediff_body)

        fallback_response = self.client.post(
            "/api/rediff",
            json={
                "result_id": "expired",
                "image_a": diff_body["image_a"],
                "image_b_aligned": diff_body["image_b_aligned"],
                "diff_threshold": 0.4,
            },
        )
        self.assertEqual(fallback_response.status_code, 200)
        self.assertEqual(fallback_response.json()["diff_pixels"], rediff_body["diff_pixels"])
        self.assertTrue(fallback_response.json()["result_id"])

    def test_git_diff_handles_staged_rename(self):
        with tempfile.TemporaryDirectory() as tmp:
            image_path = os.path.join(tmp, "old.png")
            Image.new("RGB", (80, 60), "white").save(image_path)
            self._git(tmp, "init", "--quiet")
            self._git(tmp, "config", "user.email", "review@example.com")
            self._git(tmp, "config", "user.name", "Review")
            self._git(tmp, "add", "old.png")
            self._git(tmp, "commit", "--quiet", "-m", "initial image")
            self._git(tmp, "mv", "old.png", "new.png")

            images_response = self.client.post("/api/git/images", json={"folder": tmp})
            self.assertEqual(images_response.status_code, 200, images_response.text)
            files = images_response.json()["files"]
            renamed = next((item for item in files if item["path"] == "new.png"), None)
            self.assertIsNotNone(renamed)
            self.assertEqual(renamed["head_path"], "old.png")
            self.assertTrue(renamed["comparable"])

            diff_response = self.client.post("/api/git/diff", json={"folder": tmp, **renamed})
            self.assertEqual(diff_response.status_code, 200, diff_response.text)
            self.assertEqual(diff_response.json()["page_a"], 0)
            self.assertEqual(diff_response.json()["page_b"], 0)

    def test_git_images_accepts_current_repository_folder(self):
        repo_root = os.path.dirname(os.path.dirname(__file__))
        response = self.client.post("/api/git/images", json={"folder": repo_root})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            os.path.normcase(response.json()["repo_root"]),
            os.path.normcase(os.path.abspath(repo_root)),
        )

    def test_git_files_lists_text_changes_and_builds_side_by_side_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            markdown_path = os.path.join(tmp, "guide.md")
            with open(markdown_path, "w", encoding="utf-8") as stream:
                stream.write("# Guide\n\nOld sentence\n")
            self._git(tmp, "init", "--quiet")
            self._git(tmp, "config", "user.email", "review@example.com")
            self._git(tmp, "config", "user.name", "Review")
            self._git(tmp, "add", "guide.md")
            self._git(tmp, "commit", "--quiet", "-m", "initial text")
            with open(markdown_path, "w", encoding="utf-8") as stream:
                stream.write("# Guide\n\nNew sentence\nAdded line\n")

            files_response = self.client.post(
                "/api/git/files",
                json={"folder": tmp, "text_extensions": [".md"]},
            )
            self.assertEqual(files_response.status_code, 200, files_response.text)
            item = files_response.json()["files"][0]
            self.assertEqual(item["kind"], "text")
            self.assertEqual(item["change_type"], "modified")

            item_response = self.client.post(
                "/api/git/item",
                json={"folder": tmp, "text_extensions": [".md"], **item},
            )
            self.assertEqual(item_response.status_code, 200, item_response.text)
            body = item_response.json()
            self.assertEqual(body["text_head"], "# Guide\n\nOld sentence\n")
            self.assertEqual(body["text_current"], "# Guide\n\nNew sentence\nAdded line\n")
            self.assertTrue(any(row["kind"] == "replace" for row in body["rows"]))
            self.assertTrue(any(row["kind"] == "insert" for row in body["rows"]))

            compact_response = self.client.post(
                "/api/git/item",
                json={"folder": tmp, "text_extensions": [".md"], "include_text": False, **item},
            )
            self.assertEqual(compact_response.status_code, 200, compact_response.text)
            self.assertNotIn("text_head", compact_response.json())
            self.assertNotIn("text_current", compact_response.json())

    def test_git_markdown_scope_filters_to_obsidian_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            assets_dir = os.path.join(tmp, "assets")
            notes_dir = os.path.join(tmp, "notes")
            os.makedirs(assets_dir)
            os.makedirs(notes_dir)
            markdown_path = os.path.join(notes_dir, "guide.md")
            child_path = os.path.join(notes_dir, "child.md")
            linked_image = os.path.join(assets_dir, "linked.svg")
            child_image = os.path.join(assets_dir, "child.svg")
            unrelated_image = os.path.join(assets_dir, "unrelated.svg")
            with open(markdown_path, "w", encoding="utf-8") as stream:
                stream.write("# Guide\n![[assets/linked.svg]]\n[[child]]\n")
            with open(child_path, "w", encoding="utf-8") as stream:
                stream.write("# Child\n![child](assets/child.svg)\n")
            for path in (linked_image, child_image, unrelated_image):
                with open(path, "w", encoding="utf-8") as stream:
                    stream.write('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="10" height="10"/></svg>')
            self._git(tmp, "init", "--quiet")
            self._git(tmp, "config", "user.email", "review@example.com")
            self._git(tmp, "config", "user.name", "Review")
            self._git(tmp, "add", ".")
            self._git(tmp, "commit", "--quiet", "-m", "initial vault")
            with open(linked_image, "a", encoding="utf-8") as stream:
                stream.write("<!-- changed -->")
            with open(child_image, "a", encoding="utf-8") as stream:
                stream.write("<!-- changed -->")
            with open(unrelated_image, "a", encoding="utf-8") as stream:
                stream.write("<!-- unrelated -->")

            with patch("backend.app.settings_store.SERVER_SETTINGS_PATH", Path(tmp) / "settings.json"):
                settings_response = self.client.put("/api/settings/obsidian", json={"obsidian_folder": tmp})
                self.assertEqual(settings_response.status_code, 200, settings_response.text)
                files_response = self.client.post(
                    "/api/git/files",
                    json={"folder": markdown_path, "text_extensions": [".md"]},
                )
                markdown_response = self.client.post(
                    "/api/git/markdown",
                    json={"markdown_path": markdown_path, "text_extensions": [".md"]},
                )
                get_markdown_response = self.client.get("/api/git/markdown", params={"path": markdown_path})

            self.assertEqual(files_response.status_code, 200, files_response.text)
            body = files_response.json()
            self.assertTrue(body["source_markdown"].endswith("guide.md"))
            self.assertEqual({item["path"] for item in body["files"]}, {"assets/linked.svg", "assets/child.svg"})
            self.assertEqual(markdown_response.status_code, 200, markdown_response.text)
            markdown_body = markdown_response.json()
            self.assertIn("markdown_path=", markdown_body["diff_url"])
            self.assertEqual({item["path"] for item in markdown_body["files"]}, {"assets/linked.svg", "assets/child.svg"})
            self.assertEqual(get_markdown_response.status_code, 200, get_markdown_response.text)

    def test_git_revert_line_restores_later_deleted_line_at_the_original_gap(self):
        with tempfile.TemporaryDirectory() as tmp:
            text_path = Path(tmp) / "guide.md"
            text_path.write_text("top\ndeleted one\ndeleted two\nbottom\n", encoding="utf-8")
            self._git(tmp, "init", "--quiet")
            self._git(tmp, "config", "user.email", "review@example.com")
            self._git(tmp, "config", "user.name", "Review")
            self._git(tmp, "add", "guide.md")
            self._git(tmp, "commit", "--quiet", "-m", "initial text")
            text_path.write_text("top\nbottom\n", encoding="utf-8")

            item_response = self.client.post(
                "/api/git/item",
                json={
                    "folder": tmp,
                    "path": "guide.md",
                    "head_path": "guide.md",
                    "kind": "text",
                    "has_head": True,
                    "has_current": True,
                    "text_extensions": [".md"],
                },
            )
            target = next(row for row in item_response.json()["rows"] if row.get("old") == "deleted two")
            restore_response = self.client.post(
                "/api/git/revert-line",
                json={
                    "folder": tmp,
                    "path": "guide.md",
                    "head_path": "guide.md",
                    "text_extensions": [".md"],
                    "row": target,
                },
            )

            self.assertEqual(restore_response.status_code, 200, restore_response.text)
            self.assertEqual(text_path.read_text(encoding="utf-8"), "top\ndeleted two\nbottom\n")

    def test_git_revert_line_rejects_a_stale_shifted_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            text_path = Path(tmp) / "guide.md"
            text_path.write_text("top\nold value\nbottom\n", encoding="utf-8")
            self._git(tmp, "init", "--quiet")
            self._git(tmp, "config", "user.email", "review@example.com")
            self._git(tmp, "config", "user.name", "Review")
            self._git(tmp, "add", "guide.md")
            self._git(tmp, "commit", "--quiet", "-m", "initial text")
            text_path.write_text("top\nnew value\nbottom\n", encoding="utf-8")

            item_response = self.client.post(
                "/api/git/item",
                json={
                    "folder": tmp,
                    "path": "guide.md",
                    "head_path": "guide.md",
                    "kind": "text",
                    "has_head": True,
                    "has_current": True,
                    "text_extensions": [".md"],
                },
            )
            stale_row = next(row for row in item_response.json()["rows"] if row.get("kind") == "replace")
            text_path.write_text("inserted elsewhere\ntop\nnew value\nbottom\n", encoding="utf-8")

            restore_response = self.client.post(
                "/api/git/revert-line",
                json={
                    "folder": tmp,
                    "path": "guide.md",
                    "head_path": "guide.md",
                    "text_extensions": [".md"],
                    "row": stale_row,
                },
            )

            self.assertEqual(restore_response.status_code, 409, restore_response.text)
            self.assertEqual(text_path.read_text(encoding="utf-8"), "inserted elsewhere\ntop\nnew value\nbottom\n")

    def test_obsidian_settings_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            requested_override = Path(tmp) / "request-override"
            requested_override.mkdir()
            with patch("backend.app.settings_store.SERVER_SETTINGS_PATH", Path(tmp) / "settings.json"):
                put_response = self.client.put(
                    "/api/settings/obsidian",
                    json={"obsidian_folder": tmp, "obsidian_report_folder": tmp},
                )
                partial_response = self.client.put(
                    "/api/settings/obsidian",
                    json={"obsidian_folder": tmp},
                )
                get_response = self.client.get("/api/settings/obsidian")
                save_response = self.client.post(
                    "/api/reports/save",
                    json={
                        "filename": "../note_変更差分レポート.html",
                        "html": "<!doctype html><p>diff</p>",
                        "report_folder": str(requested_override),
                    },
                )
            self.assertEqual(put_response.status_code, 200, put_response.text)
            self.assertEqual(partial_response.status_code, 200, partial_response.text)
            self.assertEqual(get_response.status_code, 200, get_response.text)
            self.assertEqual(get_response.json()["obsidian_folder"], str(Path(tmp).resolve()))
            self.assertEqual(get_response.json()["obsidian_report_folder"], str(Path(tmp).resolve()))
            self.assertEqual(save_response.status_code, 200, save_response.text)
            saved_path = Path(save_response.json()["path"])
            self.assertEqual(saved_path.parent, Path(tmp).resolve())
            self.assertEqual(saved_path.name, "note_変更差分レポート.html")
            self.assertFalse((requested_override / saved_path.name).exists())
            self.assertTrue(saved_path.read_text(encoding="utf-8").endswith("diff</p>"))

    def test_report_save_requires_server_configured_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch("backend.app.settings_store.SERVER_SETTINGS_PATH", Path(tmp) / "missing-settings.json"):
                response = self.client.post(
                    "/api/reports/save",
                    json={
                        "filename": "report.html",
                        "html": "<!doctype html><p>diff</p>",
                        "report_folder": tmp,
                    },
                )
        self.assertEqual(response.status_code, 422, response.text)
        self.assertIn("未設定", response.json()["detail"])

    def test_git_treats_excalidraw_markdown_as_image(self):
        with tempfile.TemporaryDirectory() as tmp:
            drawing_path = os.path.join(tmp, "diagram.excalidraw.md")
            base_payload = {
                "type": "excalidraw",
                "elements": [{
                    "id": "box",
                    "type": "rectangle",
                    "x": 10,
                    "y": 10,
                    "width": 80,
                    "height": 50,
                    "strokeColor": "#000000",
                    "backgroundColor": "transparent",
                    "strokeWidth": 2,
                    "isDeleted": False,
                }],
                "appState": {},
            }

            def write_drawing(payload):
                with open(drawing_path, "w", encoding="utf-8") as stream:
                    stream.write("---\nexcalidraw-plugin: parsed\n---\n```json\n")
                    stream.write(json.dumps(payload))
                    stream.write("\n```\n")

            write_drawing(base_payload)
            self._git(tmp, "init", "--quiet")
            self._git(tmp, "config", "user.email", "review@example.com")
            self._git(tmp, "config", "user.name", "Review")
            self._git(tmp, "add", "diagram.excalidraw.md")
            self._git(tmp, "commit", "--quiet", "-m", "initial drawing")
            changed_payload = json.loads(json.dumps(base_payload))
            changed_payload["elements"][0]["width"] = 120
            write_drawing(changed_payload)

            files_response = self.client.post(
                "/api/git/files",
                json={"folder": tmp, "text_extensions": [".md"]},
            )
            self.assertEqual(files_response.status_code, 200, files_response.text)
            item = files_response.json()["files"][0]
            self.assertEqual(item["kind"], "image")

            diff_response = self.client.post("/api/git/diff", json={"folder": tmp, **item})
            self.assertEqual(diff_response.status_code, 200, diff_response.text)
            self.assertGreater(diff_response.json()["diff_pixels"], 0)

    def test_git_markdown_exposes_embedded_excalidraw_as_separate_diff_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            note_path = os.path.join(tmp, "りんご.md")
            base_payload = {
                "type": "excalidraw",
                "elements": [{
                    "id": "box",
                    "type": "rectangle",
                    "x": 10,
                    "y": 10,
                    "width": 80,
                    "height": 50,
                    "strokeColor": "#000000",
                    "backgroundColor": "transparent",
                    "strokeWidth": 2,
                    "isDeleted": False,
                }],
                "appState": {},
            }

            def write_note(payload, body="りんご"):
                with open(note_path, "w", encoding="utf-8") as stream:
                    stream.write("---\nexcalidraw-plugin: parsed\n---\n\n")
                    stream.write(f"{body}\n\n# Excalidraw Data\n## Drawing\n```json\n")
                    stream.write(json.dumps(payload))
                    stream.write("\n```\n")

            write_note(base_payload)
            self._git(tmp, "init", "--quiet")
            self._git(tmp, "config", "user.email", "review@example.com")
            self._git(tmp, "config", "user.name", "Review")
            self._git(tmp, "add", "りんご.md")
            self._git(tmp, "commit", "--quiet", "-m", "initial note")
            changed_payload = json.loads(json.dumps(base_payload))
            changed_payload["elements"][0]["width"] = 140
            write_note(changed_payload, body="りんご（更新）")

            files_response = self.client.post(
                "/api/git/files",
                json={"folder": tmp, "text_extensions": [".md"]},
            )
            self.assertEqual(files_response.status_code, 200, files_response.text)
            item = files_response.json()["files"][0]
            self.assertEqual(item["kind"], "text")
            self.assertTrue(item["embedded_excalidraw"])

            text_item_response = self.client.post(
                "/api/git/item",
                json={"folder": tmp, "text_extensions": [".md"], "include_text": True, **item},
            )
            self.assertEqual(text_item_response.status_code, 200, text_item_response.text)
            text_rows = text_item_response.json()["rows"]
            self.assertTrue(any("りんご（更新）" in (row.get("new") or "") for row in text_rows))
            self.assertTrue(any("# Excalidraw Data" in (row.get("new") or "") for row in text_rows))
            self.assertFalse(any("## Drawing" in (row.get("new") or "") for row in text_rows))
            self.assertFalse(any("```json" in (row.get("new") or "") for row in text_rows))

            drawing_response = self.client.post(
                "/api/git/diff",
                json={"folder": tmp, **item, "subresource": "excalidraw"},
            )
            self.assertEqual(drawing_response.status_code, 200, drawing_response.text)
            self.assertGreater(drawing_response.json()["diff_pixels"], 0)

    def test_git_item_rejects_large_text_before_diffing(self):
        with tempfile.TemporaryDirectory() as tmp:
            text_path = os.path.join(tmp, "large.md")
            with open(text_path, "w", encoding="utf-8") as stream:
                stream.write("too large")
            self._git(tmp, "init", "--quiet")

            with patch("backend.app.routes.git.MAX_TEXT_BYTES", 4):
                response = self.client.post(
                    "/api/git/item",
                    json={
                        "folder": tmp,
                        "path": "large.md",
                        "head_path": "large.md",
                        "has_head": False,
                        "has_current": True,
                        "text_extensions": [".md"],
                    },
                )

            self.assertEqual(response.status_code, 413, response.text)

    def test_long_changed_line_skips_expensive_inline_matching(self):
        old_line = "a" * 12_000
        new_line = "b" * 12_000

        rows = build_text_diff_rows(old_line, new_line)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["old_segments"], [{"text": old_line, "changed": True}])
        self.assertEqual(rows[0]["new_segments"], [{"text": new_line, "changed": True}])

    def test_text_diff_reports_terminal_newline_change(self):
        rows = build_text_diff_rows("same line\n", "same line")

        self.assertEqual(rows[-1]["kind"], "replace")
        self.assertEqual(rows[-1]["old"], "ファイル末尾: 改行あり")
        self.assertEqual(rows[-1]["new"], "ファイル末尾: 改行なし")

    def test_git_item_rejects_control_character_binary_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            binary_path = os.path.join(tmp, "binary.txt")
            with open(binary_path, "wb") as stream:
                stream.write(b"abc\x01\x02\x03")
            self._git(tmp, "init", "--quiet")

            response = self.client.post(
                "/api/git/item",
                json={
                    "folder": tmp,
                    "path": "binary.txt",
                    "head_path": "binary.txt",
                    "has_head": False,
                    "has_current": True,
                    "text_extensions": [".txt"],
                },
            )

            self.assertEqual(response.status_code, 422, response.text)

    def test_oversized_diff_pair_does_not_return_unusable_cache_id(self):
        image = np.zeros((2, 2, 3), dtype=np.uint8)
        with patch("backend.app.result_cache.MAX_CACHE_BYTES", 1):
            result_id = store_diff_images(image, image)

        self.assertIsNone(result_id)

    def test_git_files_includes_added_deleted_and_untracked_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            deleted_path = os.path.join(tmp, "deleted.md")
            added_path = os.path.join(tmp, "added.txt")
            untracked_path = os.path.join(tmp, "notes.md")
            with open(deleted_path, "w", encoding="utf-8") as stream:
                stream.write("deleted\n")
            self._git(tmp, "init", "--quiet")
            self._git(tmp, "config", "user.email", "review@example.com")
            self._git(tmp, "config", "user.name", "Review")
            self._git(tmp, "add", "deleted.md")
            self._git(tmp, "commit", "--quiet", "-m", "initial")
            os.remove(deleted_path)
            with open(added_path, "w", encoding="utf-8") as stream:
                stream.write("added\n")
            self._git(tmp, "add", "added.txt")
            with open(untracked_path, "w", encoding="utf-8") as stream:
                stream.write("untracked\n")

            response = self.client.post(
                "/api/git/files",
                json={"folder": tmp, "text_extensions": ["md", ".txt"]},
            )
            self.assertEqual(response.status_code, 200, response.text)
            by_path = {item["path"]: item for item in response.json()["files"]}
            self.assertEqual(by_path["deleted.md"]["change_type"], "deleted")
            self.assertFalse(by_path["deleted.md"]["has_current"])
            self.assertEqual(by_path["added.txt"]["change_type"], "added")
            self.assertFalse(by_path["added.txt"]["has_head"])
            self.assertEqual(by_path["notes.md"]["change_type"], "untracked")

    def test_git_text_output_uses_utf8_instead_of_windows_locale(self):
        completed = subprocess.CompletedProcess(
            args=["git"],
            returncode=0,
            stdout="日本語",
            stderr="",
        )
        with patch("backend.app.git_repo.subprocess.run", return_value=completed) as run:
            run_git_process(
                os.getcwd(),
                ["status", "--porcelain=v1", "-z"],
                check=True,
                capture_output=True,
                text=True,
            )

        self.assertEqual(run.call_args.kwargs["encoding"], "utf-8")

    def test_git_returns_empty_text_when_stdout_is_none(self):
        completed = subprocess.CompletedProcess(
            args=["git"],
            returncode=0,
            stdout=None,
            stderr="",
        )
        with patch("backend.app.git_repo.run_git_process", return_value=completed):
            self.assertEqual(git_output(["status"], os.getcwd()), "")

    def _git(self, cwd, *args):
        subprocess.run(["git", "-C", cwd, *args], check=True, capture_output=True)

    def test_bom_alignment_stays_sane(self):
        with open(os.path.join(self.samples_dir, "bom_a.png"), "rb") as a, open(
            os.path.join(self.samples_dir, "bom_b.png"), "rb"
        ) as b:
            response = self.client.post(
                "/api/diff",
                files={
                    "file_a": ("bom_a.png", a, "image/png"),
                    "file_b": ("bom_b.png", b, "image/png"),
                },
                data={"page_a": "0", "page_b": "0", "category": "書類"},
            )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["alignment"]["success"], body["alignment"]["warning"])
        self.assertLess(body["diff_ratio"], 0.01)
        matrix = body["alignment"]["matrix"]
        self.assertIsNotNone(matrix)
        self.assertAlmostEqual(matrix[0][0], 1.0, places=2)
        self.assertAlmostEqual(matrix[1][1], 1.0, places=2)
        self.assertAlmostEqual(matrix[0][2], 0.0, delta=2.0)
        self.assertAlmostEqual(matrix[1][2], 0.0, delta=2.0)


if __name__ == "__main__":
    unittest.main()
