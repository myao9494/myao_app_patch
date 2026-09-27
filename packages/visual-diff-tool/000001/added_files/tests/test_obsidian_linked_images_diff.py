"""
Obsidian Markdown 起点のリンク画像差分検出テスト仕様。
Obsidian 特有のショートリンク（パスなしのファイル名参照）、拡張子省略、
Vault自動検出（設定未指定時や別Vault指定時のフォールバック）、
URL形式リンク内のローカルパス、および削除された画像の差分検出を検証する。
"""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app.main import app


class TestObsidianLinkedImagesDiff(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def _git(self, repo_dir: str, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["git", "-C", repo_dir, *args],
            check=True,
            capture_output=True,
            text=True,
        )

    def test_obsidian_shortlink_in_subfolder_without_configured_vault(self):
        """
        設定ファイルで別Vaultが指定されている、あるいは未設定の場合でも、
        Markdown内のショートリンク（![[図_test_convert.excalidraw]] など）が
        親リポジトリまたは自動検出されたVaultから正しく解決され、差分画像として検出されることを検証する。
        """
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as other_vault:
            repo_dir = os.path.join(tmp, "my_repo")
            os.makedirs(repo_dir)
            obsidian_dir = os.path.join(repo_dir, ".obsidian")
            os.makedirs(obsidian_dir)

            data_dir = os.path.join(repo_dir, "01_data", "2026", "08", "05")
            scratch_dir = os.path.join(repo_dir, "scratch")
            os.makedirs(data_dir)
            os.makedirs(scratch_dir)

            markdown_path = os.path.join(scratch_dir, "test_convert.md")
            excalidraw_path = os.path.join(data_dir, "図_test_convert.excalidraw.md")
            svg_path = os.path.join(data_dir, "test_convert.drawio.svg")

            # Markdown 内で Obsidian ショートリンク（パスなし）として記述
            with open(markdown_path, "w", encoding="utf-8") as f:
                f.write(
                    "# テストノート\n"
                    "![[図_test_convert.excalidraw|525]]\n"
                    "![[test_convert.drawio.svg]]\n"
                )

            with open(excalidraw_path, "w", encoding="utf-8") as f:
                f.write(
                    "---\n"
                    "excalidraw-plugin: parsed\n"
                    "---\n"
                    "# Excalidraw Data\n"
                    '```json\n{"elements": []}\n```\n'
                )

            with open(svg_path, "w", encoding="utf-8") as f:
                f.write('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><circle cx="15" cy="15" r="10"/></svg>')

            # Git 初期化
            self._git(repo_dir, "init", "--quiet")
            self._git(repo_dir, "config", "user.email", "test@example.com")
            self._git(repo_dir, "config", "user.name", "Tester")
            self._git(repo_dir, "add", ".")
            self._git(repo_dir, "commit", "--quiet", "-m", "initial commit")

            # 画像を変更する（Git差分を発生させる）
            with open(excalidraw_path, "a", encoding="utf-8") as f:
                f.write("\n<!-- modified -->\n")
            with open(svg_path, "a", encoding="utf-8") as f:
                f.write("\n<!-- modified -->\n")

            # サーバー設定には、今回のリポジトリとは全く無関係な other_vault を設定
            dummy_settings = Path(tmp) / "settings.json"
            with patch("backend.app.main.SERVER_SETTINGS_PATH", dummy_settings):
                self.client.put("/api/settings/obsidian", json={"obsidian_folder": other_vault})

                # /api/git/files で Markdown 起点の差分を取得
                response = self.client.post(
                    "/api/git/files",
                    json={"folder": markdown_path, "text_extensions": [".md"]},
                )
                self.assertEqual(response.status_code, 200, response.text)
                body = response.json()
                paths = {item["path"] for item in body["files"]}

                # ショートリンク先の Excalidraw と SVG が差分として検出されること
                self.assertIn("01_data/2026/08/05/図_test_convert.excalidraw.md", paths)
                self.assertIn("01_data/2026/08/05/test_convert.drawio.svg", paths)

                # /api/git/images でも同様に画像差分として検出されること
                img_response = self.client.post(
                    "/api/git/images",
                    json={"folder": markdown_path},
                )
                self.assertEqual(img_response.status_code, 200, img_response.text)
                img_paths = {item["path"] for item in img_response.json()["files"]}
                self.assertIn("01_data/2026/08/05/図_test_convert.excalidraw.md", img_paths)
                self.assertIn("01_data/2026/08/05/test_convert.drawio.svg", img_paths)

    def test_obsidian_shortlink_without_extension(self):
        """
        Markdown内で拡張子なしの ![[image_sample]] で参照されている場合、
        画像拡張子（.pngなど）を自動補完して解決できることを検証する。
        """
        with tempfile.TemporaryDirectory() as tmp:
            repo_dir = os.path.join(tmp, "repo")
            os.makedirs(repo_dir)
            assets_dir = os.path.join(repo_dir, "assets")
            os.makedirs(assets_dir)

            markdown_path = os.path.join(repo_dir, "note.md")
            image_path = os.path.join(assets_dir, "image_sample.png")

            with open(markdown_path, "w", encoding="utf-8") as f:
                f.write("# Note\n![[image_sample]]\n")

            with open(image_path, "wb") as f:
                f.write(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82")

            self._git(repo_dir, "init", "--quiet")
            self._git(repo_dir, "config", "user.email", "test@example.com")
            self._git(repo_dir, "config", "user.name", "Tester")
            self._git(repo_dir, "add", ".")
            self._git(repo_dir, "commit", "--quiet", "-m", "init")

            # 画像を変更
            with open(image_path, "ab") as f:
                f.write(b"extra")

            dummy_settings = Path(tmp) / "settings.json"
            with patch("backend.app.main.SERVER_SETTINGS_PATH", dummy_settings):
                response = self.client.post(
                    "/api/git/files",
                    json={"folder": markdown_path},
                )
                self.assertEqual(response.status_code, 200, response.text)
                paths = {item["path"] for item in response.json()["files"]}
                self.assertIn("assets/image_sample.png", paths)

    def test_markdown_with_url_filepath_param(self):
        """
        Markdown内の [リンク](http://localhost:3001/?filepath=...) のようなURLに
        リポジトリ内ファイルのパスが含まれる場合、差分対象として検出できることを検証する。
        """
        with tempfile.TemporaryDirectory() as tmp:
            repo_dir = os.path.join(tmp, "repo")
            os.makedirs(repo_dir)
            img_dir = os.path.join(repo_dir, "images")
            os.makedirs(img_dir)

            markdown_path = os.path.join(repo_dir, "doc.md")
            svg_path = os.path.join(img_dir, "diagram.svg")

            with open(markdown_path, "w", encoding="utf-8") as f:
                f.write(f"# Doc\n[図面](http://localhost:3001/?filepath={svg_path})\n")

            with open(svg_path, "w", encoding="utf-8") as f:
                f.write('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')

            self._git(repo_dir, "init", "--quiet")
            self._git(repo_dir, "config", "user.email", "test@example.com")
            self._git(repo_dir, "config", "user.name", "Tester")
            self._git(repo_dir, "add", ".")
            self._git(repo_dir, "commit", "--quiet", "-m", "init")

            with open(svg_path, "a", encoding="utf-8") as f:
                f.write("<!-- change -->")

            dummy_settings = Path(tmp) / "settings.json"
            with patch("backend.app.main.SERVER_SETTINGS_PATH", dummy_settings):
                response = self.client.post(
                    "/api/git/files",
                    json={"folder": markdown_path},
                )
                self.assertEqual(response.status_code, 200, response.text)
                paths = {item["path"] for item in response.json()["files"]}
                self.assertIn("images/diagram.svg", paths)

    def test_obsidian_shortlink_deleted_in_worktree(self):
        """
        作業ツリーで画像ファイルが削除された場合（HEADにのみ存在）、
        ショートリンク経由でも削除された画像として差分検出できることを検証する。
        """
        with tempfile.TemporaryDirectory() as tmp:
            repo_dir = os.path.join(tmp, "repo")
            os.makedirs(repo_dir)
            assets_dir = os.path.join(repo_dir, "assets")
            os.makedirs(assets_dir)

            markdown_path = os.path.join(repo_dir, "doc.md")
            image_path = os.path.join(assets_dir, "deleted_image.png")

            with open(markdown_path, "w", encoding="utf-8") as f:
                f.write("# Doc\n![[deleted_image.png]]\n")

            with open(image_path, "wb") as f:
                f.write(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82")

            self._git(repo_dir, "init", "--quiet")
            self._git(repo_dir, "config", "user.email", "test@example.com")
            self._git(repo_dir, "config", "user.name", "Tester")
            self._git(repo_dir, "add", ".")
            self._git(repo_dir, "commit", "--quiet", "-m", "init")

            # 作業ツリーから画像を削除
            os.remove(image_path)

            dummy_settings = Path(tmp) / "settings.json"
            with patch("backend.app.main.SERVER_SETTINGS_PATH", dummy_settings):
                response = self.client.post(
                    "/api/git/files",
                    json={"folder": markdown_path},
                )
                self.assertEqual(response.status_code, 200, response.text)
                items = {item["path"]: item for item in response.json()["files"]}
                self.assertIn("assets/deleted_image.png", items)
                self.assertEqual(items["assets/deleted_image.png"]["change_type"], "deleted")
