"""
ファイルの履歴（POST /api/git/history）と、版を指定した比較（old_rev / new_rev）のテスト。
- 履歴はファイルを変えたコミットを古い順に返し、名前の変更もたどる（1つ目は追加、その後は直前のコミットとの比較）
- /api/git/item・/api/git/diff は old_rev / new_rev で過去のコミットどうしを比べる（未指定は HEAD と作業ツリー）
- 版の指定は HEAD かコミットの16進IDだけ（オプションのような値は 422）
- Markdown は各コミットでの埋め込みExcalidraw図・3D表示の一覧を付ける
"""

import io
import subprocess
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from backend.app.main import app


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout


def _png(color: tuple[int, int, int], box: tuple[int, int, int, int] | None = None) -> bytes:
    image = Image.new("RGB", (64, 48), "white")
    if box:
        for x in range(box[0], box[2]):
            for y in range(box[1], box[3]):
                image.putpixel((x, y), color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class TestGitFileHistory(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp_dir.name) / "repo"
        self.repo.mkdir()
        _git(self.repo, "init", "--quiet", "-b", "main")
        _git(self.repo, "config", "user.email", "test@example.com")
        _git(self.repo, "config", "user.name", "Tester")
        self.commits = []
        for index, text in enumerate(["one\n", "one\ntwo\n", "one\ntwo\nthree\n"]):
            (self.repo / "note.md").write_text(text, encoding="utf-8")
            (self.repo / "other.txt").write_text(f"{index}\n", encoding="utf-8")
            _git(self.repo, "add", ".")
            _git(self.repo, "commit", "--quiet", "-m", f"step {index + 1}")
            self.commits.append(_git(self.repo, "rev-parse", "HEAD").strip())
        # 名前の変更
        _git(self.repo, "mv", "note.md", "renamed.md")
        _git(self.repo, "commit", "--quiet", "-m", "rename")
        self.commits.append(_git(self.repo, "rev-parse", "HEAD").strip())
        # 作業ツリーの変更（変更一覧に出る）
        (self.repo / "renamed.md").write_text("one\ntwo\nthree\nfour\n", encoding="utf-8")

    def tearDown(self):
        self.temp_dir.cleanup()

    def _history(self, path, **extra):
        return self.client.post("/api/git/history", json={"folder": str(self.repo), "path": path, "text_extensions": [".md", ".txt"], **extra})

    def test_history_lists_commits_oldest_first_and_follows_renames(self):
        response = self._history("renamed.md")
        self.assertEqual(response.status_code, 200, response.text)
        commits = response.json()["commits"]
        self.assertEqual([item["subject"] for item in commits], ["step 1", "step 2", "step 3", "rename"])
        first, second, _, rename = commits
        self.assertEqual(first["change_type"], "added")
        self.assertFalse(first["has_head"])
        self.assertEqual(first["new_rev"], self.commits[0])
        self.assertEqual(second["old_rev"], self.commits[0])
        self.assertEqual(second["new_rev"], self.commits[1])
        self.assertTrue(second["diffable"])
        self.assertEqual(rename["change_type"], "renamed")
        self.assertEqual(rename["head_path"], "note.md")
        self.assertEqual(rename["path"], "renamed.md")
        # Markdown のサブ項目の情報も付く
        self.assertIn("cad_views", second)
        self.assertFalse(second["embedded_excalidraw"])

    def test_item_compares_two_past_commits(self):
        response = self.client.post(
            "/api/git/item",
            json={
                "folder": str(self.repo),
                "path": "note.md",
                "head_path": "note.md",
                "old_rev": self.commits[0],
                "new_rev": self.commits[1],
                "text_extensions": [".md"],
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["text_head"], "one\n")
        self.assertEqual(body["text_current"], "one\ntwo\n")
        self.assertIn("insert", {row["kind"] for row in body["rows"]})

    def test_item_without_revisions_still_compares_head_and_worktree(self):
        response = self.client.post(
            "/api/git/item",
            json={"folder": str(self.repo), "path": "renamed.md", "head_path": "renamed.md", "text_extensions": [".md"]},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["text_current"], "one\ntwo\nthree\nfour\n")

    def test_rejects_option_like_revisions(self):
        for bad in ("--output=/tmp/x", "HEAD~1", "main", "../x"):
            response = self.client.post(
                "/api/git/item",
                json={"folder": str(self.repo), "path": "note.md", "old_rev": bad, "new_rev": self.commits[1], "text_extensions": [".md"]},
            )
            self.assertEqual(response.status_code, 422, bad)

    def test_untracked_file_has_no_commits(self):
        (self.repo / "fresh.md").write_text("x\n", encoding="utf-8")
        response = self._history("fresh.md", has_head=False)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["commits"], [])

    def test_image_diff_between_past_commits(self):
        (self.repo / "pic.png").write_bytes(_png((0, 0, 0)))
        _git(self.repo, "add", "pic.png")
        _git(self.repo, "commit", "--quiet", "-m", "pic 1")
        first = _git(self.repo, "rev-parse", "HEAD").strip()
        (self.repo / "pic.png").write_bytes(_png((255, 0, 0), (10, 10, 30, 30)))
        _git(self.repo, "commit", "--quiet", "-am", "pic 2")
        second = _git(self.repo, "rev-parse", "HEAD").strip()
        # 作業ツリーは別の内容にしておき、過去の2つを比べていることを確かめる
        (self.repo / "pic.png").write_bytes(_png((0, 0, 255), (0, 0, 64, 48)))

        history = self._history("pic.png").json()["commits"]
        self.assertEqual([item["new_rev"] for item in history], [first, second])

        response = self.client.post(
            "/api/git/diff",
            json={"folder": str(self.repo), "path": "pic.png", "head_path": "pic.png", "old_rev": first, "new_rev": second},
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertGreater(body["diff_pixels"], 0)
        self.assertLess(body["diff_ratio"], 0.5)  # 作業ツリー（全面が青）と比べていない


if __name__ == "__main__":
    unittest.main()
