"""
WebP画像の差分テスト仕様。
Obsidian Image Converter が作るWebP（不可逆・可逆・透過・アニメーション）を比較できること、
Git差分で一覧・比較できること、PNGからWebPへの変換が削除＋新規に分かれず1件の変更になることを検証する。
"""

import io
import os
import subprocess
import tempfile
import unittest

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from backend.app.main import app


def drawing(*, changed: bool = False, mode: str = "RGB") -> Image.Image:
    image = Image.new(mode, (200, 150), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 20, 80, 70), fill="black")
    if changed:
        draw.ellipse((120, 80, 180, 140), fill="blue")
    return image


def encode(image: Image.Image, **options) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, **options)
    return buffer.getvalue()


class TestWebpUpload(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def _diff(self, content_a: bytes, content_b: bytes, name_a: str = "a.webp", name_b: str = "b.webp"):
        return self.client.post(
            "/api/diff",
            files={
                "file_a": (name_a, content_a, "application/octet-stream"),
                "file_b": (name_b, content_b, "application/octet-stream"),
            },
        )

    def test_analyze_reports_webp_format_and_size(self):
        response = self.client.post(
            "/api/analyze",
            files={"file": ("a.webp", encode(drawing(), format="WEBP"), "image/webp")},
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["format"], "webp")
        self.assertEqual((body["pages"][0]["width"], body["pages"][0]["height"]), (200, 150))

    def test_diff_detects_changes_in_each_webp_encoding(self):
        encodings = {
            "lossy": ("RGB", {"quality": 80}),
            "lossless": ("RGB", {"lossless": True}),
            "alpha": ("RGBA", {"quality": 80}),
        }
        for name, (mode, options) in encodings.items():
            with self.subTest(name):
                response = self._diff(
                    encode(drawing(mode=mode), format="WEBP", **options),
                    encode(drawing(changed=True, mode=mode), format="WEBP", **options),
                )
                self.assertEqual(response.status_code, 200, response.text)
                self.assertGreater(response.json()["diff_ratio"], 0.01)

    def test_animated_webp_compares_first_frame(self):
        animated = encode(drawing(), format="WEBP", save_all=True, append_images=[drawing(changed=True)], duration=100)
        response = self._diff(animated, encode(drawing(), format="WEBP", lossless=True))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertLess(response.json()["diff_ratio"], 0.01)

    def test_uppercase_extension_and_png_comparison(self):
        response = self._diff(encode(drawing(), format="PNG"), encode(drawing(), format="WEBP", lossless=True), "a.png", "B.WEBP")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["diff_ratio"], 0)


class TestWebpGit(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = self._tmp.name
        self._git("init", "--quiet")
        self._git("config", "user.email", "review@example.com")
        self._git("config", "user.name", "Review")

    def _git(self, *args: str) -> None:
        subprocess.run(["git", "-C", self.repo, *args], check=True, capture_output=True)

    def _write(self, name: str, content: bytes) -> None:
        path = os.path.join(self.repo, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as file:
            file.write(content)

    def _commit(self) -> None:
        self._git("add", "-A")
        self._git("commit", "--quiet", "-m", "initial")

    def _files(self) -> dict[str, dict]:
        response = self.client.post("/api/git/files", json={"folder": self.repo})
        self.assertEqual(response.status_code, 200, response.text)
        return {item["path"]: item for item in response.json()["files"]}

    def test_modified_webp_is_compared_with_head(self):
        self._write("assets/figure.webp", encode(drawing(), format="WEBP"))
        self._commit()
        self._write("assets/figure.webp", encode(drawing(changed=True), format="WEBP"))

        item = self._files()["assets/figure.webp"]
        self.assertEqual(item["kind"], "image")
        response = self.client.post("/api/git/diff", json={"folder": self.repo, **item})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertGreater(response.json()["diff_ratio"], 0.01)

    def test_new_webp_shows_single_side_preview(self):
        self._write("seed.txt", b"seed")
        self._commit()
        self._write("pasted.webp", encode(drawing(), format="WEBP"))

        item = self._files()["pasted.webp"]
        self.assertEqual(item["change_type"], "untracked")
        response = self.client.post("/api/git/item", json={"folder": self.repo, **item})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNotNone(response.json()["image_current"])

    def test_png_converted_to_webp_is_one_comparable_change(self):
        self._write("assets/figure.png", encode(drawing(), format="PNG"))
        self._commit()
        os.remove(os.path.join(self.repo, "assets/figure.png"))
        self._write("assets/figure.webp", encode(drawing(), format="WEBP", lossless=True))

        files = self._files()
        self.assertNotIn("assets/figure.png", files)
        item = files["assets/figure.webp"]
        self.assertEqual(item["head_path"], "assets/figure.png")
        self.assertEqual(item["change_type"], "renamed")
        self.assertTrue(item["has_head"])
        self.assertTrue(item["diffable"])

        response = self.client.post("/api/git/diff", json={"folder": self.repo, **item})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["diff_ratio"], 0)

    def test_conversion_is_not_paired_when_the_source_is_unclear(self):
        self._write("figure.png", encode(drawing(), format="PNG"))
        self._write("figure.jpg", encode(drawing(), format="JPEG"))
        self._write("other/figure.bmp", encode(drawing(), format="BMP"))
        self._write("diagram.svg", b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')
        self._commit()
        for name in ("figure.png", "figure.jpg", "other/figure.bmp", "diagram.svg"):
            os.remove(os.path.join(self.repo, name))
        self._write("figure.webp", encode(drawing(), format="WEBP"))
        self._write("diagram.webp", encode(drawing(), format="WEBP"))

        files = self._files()
        self.assertEqual(files["figure.webp"]["change_type"], "untracked")
        self.assertEqual(files["figure.png"]["change_type"], "deleted")
        self.assertEqual(files["figure.jpg"]["change_type"], "deleted")
        self.assertEqual(files["other/figure.bmp"]["change_type"], "deleted")
        self.assertEqual(files["diagram.webp"]["change_type"], "untracked")
        self.assertEqual(files["diagram.svg"]["change_type"], "deleted")


if __name__ == "__main__":
    unittest.main()
