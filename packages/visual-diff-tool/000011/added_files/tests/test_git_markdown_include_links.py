"""
Markdown を起点にした Git 差分で、リンク先のファイルも含めるかを選ぶ（include_links）テスト。
- 既定（include_links 未指定・true）は、ノートとリンク先（画像・ノート）の変更を返す（従来どおり）
- include_links: false は、そのノートだけを返す
- コミットも同じ範囲で照合する（false のとき、リンク先のファイルは一覧に無いので 409）
- GET /api/git/path・/api/git/markdown は ?include_links=false で同じように絞る
"""

import subprocess
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.main import app


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)


class GitMarkdownIncludeLinksTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = Path(self._tmp.name).resolve() / "repo"
        self.repo.mkdir()
        _git(self.repo, "init", "-q")
        _git(self.repo, "config", "user.email", "test@example.invalid")
        _git(self.repo, "config", "user.name", "test")
        (self.repo / "note.md").write_text("# ノート\n\n[[child]]\n", encoding="utf-8")
        (self.repo / "child.md").write_text("子\n", encoding="utf-8")
        (self.repo / "unrelated.md").write_text("無関係\n", encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "init")
        (self.repo / "note.md").write_text("# ノート\n\n[[child]]\n追記\n", encoding="utf-8")
        (self.repo / "child.md").write_text("子を変えた\n", encoding="utf-8")
        (self.repo / "unrelated.md").write_text("無関係も変えた\n", encoding="utf-8")
        self.note = str(self.repo / "note.md")

    def paths(self, **extra) -> list[str]:
        response = self.client.post("/api/git/files", json={"folder": self.note, "text_extensions": [".md"], **extra})
        self.assertEqual(response.status_code, 200, response.text)
        return sorted(item["path"] for item in response.json()["files"])

    def test_既定はリンク先も含める(self) -> None:
        self.assertEqual(self.paths(), ["child.md", "note.md"])
        self.assertEqual(self.paths(include_links=True), ["child.md", "note.md"])

    def test_falseならノートだけ(self) -> None:
        self.assertEqual(self.paths(include_links=False), ["note.md"])
        body = self.client.post("/api/git/files", json={"folder": self.note, "include_links": False}).json()
        self.assertIs(body["include_links"], False)

    def test_コミットも同じ範囲で照合する(self) -> None:
        response = self.client.post(
            "/api/git/commit",
            json={"folder": self.note, "include_links": False, "text_extensions": [".md"], "paths": ["child.md"], "message": "x"},
        )
        self.assertEqual(response.status_code, 409, response.text)

    def test_GETでも絞れる(self) -> None:
        body = self.client.get("/api/git/path", params={"path": self.note, "include_links": "false"}).json()
        self.assertEqual([item["path"] for item in body["files"]], ["note.md"])
        body = self.client.get("/api/git/markdown", params={"path": self.note, "include_links": "false"}).json()
        self.assertEqual([item["path"] for item in body["files"]], ["note.md"])
        body = self.client.get("/api/git/path", params={"path": self.note}).json()
        self.assertEqual(sorted(item["path"] for item in body["files"]), ["child.md", "note.md"])


if __name__ == "__main__":
    unittest.main()
