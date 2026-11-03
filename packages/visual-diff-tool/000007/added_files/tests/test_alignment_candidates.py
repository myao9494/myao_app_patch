"""
位置合わせの候補選びと、人が指定した範囲での補正、ベクター図の描画倍率のテスト。
図形が個別に動いた図を全体補正で歪ませないこと、指定範囲が優先されることを確認する。
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from io import BytesIO

import cv2
import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from app.alignment import NOT_MOVED_METHOD, TRANSLATION_METHOD, align_to_reference  # noqa: E402
from app.diffing import build_visual_diff, resize_to_match  # noqa: E402
from app.image_io import VECTOR_RASTER_MAX_PIXELS, _vector_raster_scale, rasterize_upload_page  # noqa: E402
from app.main import app  # noqa: E402


def canvas(width=800, height=600):
    return np.full((height, width, 3), 255, dtype=np.uint8)


def square(image, x, y, size=120):
    cv2.rectangle(image, (x, y), (x + size, y + size), (0, 0, 0), 3)


def circle(image, x, y, radius=60):
    cv2.circle(image, (x, y), radius, (0, 0, 0), 3, cv2.LINE_AA)


def actor(image, x, y):
    cv2.circle(image, (x, y), 20, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.line(image, (x, y + 20), (x, y + 90), (0, 0, 0), 3)
    cv2.line(image, (x - 40, y + 45), (x + 40, y + 45), (0, 0, 0), 3)


def png_bytes(image_bgr):
    buffer = BytesIO()
    Image.fromarray(cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)).save(buffer, format="PNG")
    return buffer.getvalue()


def compare(reference, candidate, **kwargs):
    result = align_to_reference(reference, candidate, **kwargs)
    comparison_a = result.reference_image if result.reference_image is not None else reference
    comparison_a = resize_to_match(result.image, comparison_a)
    comparison_b = resize_to_match(comparison_a, result.image)
    return result, build_visual_diff(comparison_a, comparison_b)


class AutomaticAlignmentTest(unittest.TestCase):
    def test_different_canvas_sizes_stay_in_place_when_top_left_content_matches(self):
        # draw.io の書き出しは図の範囲で切り抜かれるので、図形を動かすとサイズだけが変わる
        reference = canvas(844, 728)
        square(reference, 10, 10, 300)
        actor(reference, 340, 420)
        circle(reference, 680, 260, 150)
        candidate = canvas(724, 728)
        square(candidate, 10, 10, 300)
        actor(candidate, 340, 420)
        circle(candidate, 560, 560, 150)

        result, diff = compare(reference, candidate)

        self.assertEqual(result.method, NOT_MOVED_METHOD)
        # 差分は円の移動前後だけで、動いていない正方形と人の位置には出ない
        self.assertEqual(cv2.countNonZero(diff["mask"][:, :400]), 0)

    def test_whole_figure_shift_is_exact_translation_when_one_shape_moved_alone(self):
        reference = canvas()
        square(reference, 100, 100)
        circle(reference, 400, 160)
        actor(reference, 250, 350)
        dx, dy = 37, 83
        candidate = canvas(900, 760)
        square(candidate, 100 + dx, 100 + dy)
        circle(candidate, 400 + dx, 160 + dy)
        actor(candidate, 90, 40)  # これだけ別の場所へ動いた

        result, diff = compare(reference, candidate)

        self.assertEqual(result.method, TRANSLATION_METHOD)
        np.testing.assert_allclose(result.matrix, [[1, 0, -dx], [0, 1, -dy], [0, 0, 1]])
        # 変更箇所は動いた図形の前後の位置だけで、動いていない正方形・円は差分にならない
        self.assertLessEqual(diff["diff_ratio"], 0.01)

    def test_large_image_translation_is_refined_to_full_resolution(self):
        reference = canvas(3200, 2400)
        for x in range(200, 2800, 400):
            square(reference, x, 300 + x // 10, 180)
            circle(reference, x + 90, 1500 - x // 12, 70)
        matrix = np.float32([[1, 0, 23], [0, 1, -17]])
        candidate = cv2.warpAffine(reference, matrix, (3200, 2400), borderValue=(255, 255, 255))

        result, diff = compare(reference, candidate)

        self.assertEqual(result.method, TRANSLATION_METHOD)
        np.testing.assert_allclose(result.matrix, [[1, 0, -23], [0, 1, 17], [0, 0, 1]])
        self.assertEqual(len(diff["rects"]), 0)

    def test_rotated_scan_still_uses_feature_transform(self):
        reference = canvas()
        for index in range(14):
            x, y = 60 + (index * 137) % 640, 60 + (index * 89) % 460
            square(reference, x, y, 30 + index * 3)
            circle(reference, (x + 200) % 760 + 20, (y + 120) % 560 + 20, 15 + index)
        rotation = cv2.getRotationMatrix2D((400, 300), 2.0, 1.0)
        candidate = cv2.warpAffine(reference, rotation, (800, 600), borderValue=(255, 255, 255))

        result, diff = compare(reference, candidate)

        self.assertNotIn(result.method, (NOT_MOVED_METHOD, TRANSLATION_METHOD))
        self.assertLess(diff["diff_ratio"], build_visual_diff(reference, candidate)["diff_ratio"] * 0.6)


class AnchorRegionTest(unittest.TestCase):
    def build_pair(self):
        reference = canvas()
        square(reference, 100, 100)
        circle(reference, 400, 160)
        actor(reference, 250, 350)
        candidate = canvas()
        square(candidate, 140, 180)
        circle(candidate, 440, 240)
        actor(candidate, 500, 200)
        return reference, candidate

    def test_selected_region_wins_over_the_majority(self):
        reference, candidate = self.build_pair()
        result = align_to_reference(reference, candidate, anchor_region={"x": 200, "y": 320, "width": 110, "height": 140})
        self.assertTrue(result.success)
        self.assertTrue(result.method.startswith("anchor region"))
        np.testing.assert_allclose(result.matrix, [[1, 0, -250], [0, 1, 150], [0, 0, 1]])

    def test_region_outside_changes_does_not_drag_alignment(self):
        reference, candidate = self.build_pair()
        result = align_to_reference(reference, candidate, anchor_region={"x": 80, "y": 80, "width": 170, "height": 170})
        np.testing.assert_allclose(result.matrix, [[1, 0, -40], [0, 1, -80], [0, 0, 1]])

    def test_repeated_shape_picks_nearest_and_b_position_overrides(self):
        reference = canvas()
        square(reference, 300, 100)
        candidate = canvas()
        for x in (100, 320, 560):
            square(candidate, x, 110)
        region = {"x": 280, "y": 80, "width": 170, "height": 170}

        nearest = align_to_reference(reference, candidate, anchor_region=region)
        np.testing.assert_allclose(nearest.matrix, [[1, 0, -20], [0, 1, -10], [0, 0, 1]])

        chosen = align_to_reference(reference, candidate, anchor_region=region, anchor_region_b={"x": 540, "y": 90, "width": 170, "height": 170})
        np.testing.assert_allclose(chosen.matrix, [[1, 0, -260], [0, 1, -10], [0, 0, 1]])

    def test_region_that_cannot_be_found_falls_back_with_warning(self):
        reference, candidate = self.build_pair()
        cv2.putText(reference, "ONLY A", (520, 480), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 3)
        result = align_to_reference(reference, candidate, anchor_region={"x": 500, "y": 430, "width": 240, "height": 70})
        self.assertFalse(result.method.startswith("anchor region"))
        self.assertIn("自動で位置合わせしました", result.warning)

    def test_blank_region_is_reported(self):
        reference, candidate = self.build_pair()
        result = align_to_reference(reference, candidate, anchor_region={"x": 600, "y": 400, "width": 100, "height": 100})
        self.assertIn("線や文字がありません", result.warning)


class AnchorApiTest(unittest.TestCase):
    def setUp(self):
        os.environ["VISUAL_DIFF_OPEN_BROWSER"] = "0"
        self.client = TestClient(app)
        self.reference, self.candidate = AnchorRegionTest().build_pair()
        self.region = {"x": 200, "y": 320, "width": 110, "height": 140, "label": "指定した範囲"}

    def test_diff_form_accepts_a_and_b_regions(self):
        response = self.client.post(
            "/api/diff",
            files={
                "file_a": ("a.png", png_bytes(self.reference), "image/png"),
                "file_b": ("b.png", png_bytes(self.candidate), "image/png"),
            },
            data={
                "anchor_region": json.dumps(self.region),
                "anchor_region_b": json.dumps({"x": 450, "y": 170, "width": 110, "height": 140}),
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["alignment"]["method"].startswith("anchor region"))

    def test_invalid_b_region_is_rejected(self):
        response = self.client.post(
            "/api/diff",
            files={
                "file_a": ("a.png", png_bytes(self.reference), "image/png"),
                "file_b": ("b.png", png_bytes(self.candidate), "image/png"),
            },
            data={"anchor_region": json.dumps(self.region), "anchor_region_b": "[1]"},
        )
        self.assertEqual(response.status_code, 400)

    def test_git_diff_uses_anchor_region(self):
        with tempfile.TemporaryDirectory() as repo:
            def git(*args):
                subprocess.run(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", *args], check=True, capture_output=True)

            git("init")
            path = os.path.join(repo, "figure.png")
            with open(path, "wb") as file:
                file.write(png_bytes(self.reference))
            git("add", ".")
            git("commit", "-m", "base")
            with open(path, "wb") as file:
                file.write(png_bytes(self.candidate))

            response = self.client.post(
                "/api/git/diff",
                json={"folder": repo, "path": "figure.png", "anchor_region": self.region},
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(response.json()["alignment"]["method"].startswith("anchor region"))

            rejected = self.client.post("/api/git/diff", json={"folder": repo, "path": "figure.png", "anchor_region": "x"})
            self.assertEqual(rejected.status_code, 422)


class VectorRasterScaleTest(unittest.TestCase):
    def test_svg_of_any_origin_is_rendered_at_the_same_high_scale(self):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect x="10" y="10" width="50" height="50"/></svg>'
        _, page = rasterize_upload_page("plain.svg", svg)
        self.assertEqual(page.image.size, (800, 400))

    def test_scale_steps_keep_similar_sizes_on_the_same_step(self):
        # A/Bの大きさが少し違っても倍率がそろい、同じ図形が同じ大きさで重なる
        self.assertEqual(_vector_raster_scale(1100, 1000), _vector_raster_scale(1050, 1040))

    def test_scale_respects_pixel_limit(self):
        for width, height in ((200, 150), (3000, 2000), (8000, 6000)):
            scale = _vector_raster_scale(width, height)
            self.assertTrue(width * height * scale * scale <= VECTOR_RASTER_MAX_PIXELS or scale == 1.0)

    def test_excalidraw_is_scaled_and_antialiased(self):
        payload = {
            "type": "excalidraw",
            "elements": [
                {"id": "a", "type": "ellipse", "x": 0, "y": 0, "width": 100, "height": 100, "strokeColor": "#000000", "strokeWidth": 1},
                {"id": "b", "type": "text", "x": 0, "y": 120, "width": 80, "height": 25, "text": "Actor", "fontSize": 20, "strokeColor": "#000000"},
            ],
            "appState": {},
        }
        _, page = rasterize_upload_page("figure.excalidraw", json.dumps(payload).encode("utf-8"))
        self.assertEqual(page.image.size, ((100 + 160) * 4, (145 + 160) * 4))
        values = np.unique(np.asarray(page.image.convert("L")))
        self.assertGreater(len(values), 8)  # 2値の階調なしではなく、縁が滑らか


if __name__ == "__main__":
    unittest.main()
