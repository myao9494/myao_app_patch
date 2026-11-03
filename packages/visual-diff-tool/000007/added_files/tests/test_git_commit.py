"""
Git差分画面からのコミット／push API（POST /api/git/commit）のテスト。
- 選んだファイルだけをコミットする（未追跡・削除・リネームを含む。別にstage済みのファイルは巻き込まない）
- 変更一覧にないパス・空のメッセージ・空の選択は拒否する
- push=true ならリモートへ送り、アップストリーム未設定でもリモートが1つなら設定する
"""

import subprocess
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.main import app


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout


class TestGitCommit(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.remote = root / "remote.git"
        self.repo = root / "work"
        self.remote.mkdir()
        self.repo.mkdir()
        _git(self.remote, "init", "--quiet", "--bare")
        _git(self.repo, "init", "--quiet", "-b", "main")
        _git(self.repo, "config", "user.email", "test@example.com")
        _git(self.repo, "config", "user.name", "Tester")
        for name in ("a.md", "b.md", "old.md", "gone.md", "staged.md"):
            (self.repo / name).write_text(f"{name}\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "--quiet", "-m", "base")
        _git(self.repo, "remote", "add", "origin", str(self.remote))

    def tearDown(self):
        self.temp_dir.cleanup()

    def _post(self, paths, message="メッセージ\n\n本文", **extra):
        return self.client.post(
            "/api/git/commit",
            json={"folder": str(self.repo), "paths": paths, "message": message, "text_extensions": [".md"], **extra},
        )

    def test_commits_only_selected_files(self):
        (self.repo / "a.md").write_text("changed\n", encoding="utf-8")
        (self.repo / "b.md").write_text("changed\n", encoding="utf-8")
        (self.repo / "new.md").write_text("new\n", encoding="utf-8")
        (self.repo / "gone.md").unlink()
        _git(self.repo, "mv", "old.md", "renamed.md")
        (self.repo / "staged.md").write_text("staged\n", encoding="utf-8")
        _git(self.repo, "add", "staged.md")

        response = self._post(["a.md", "new.md", "gone.md", "renamed.md"])
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["commit"])
        self.assertFalse(body["pushed"])

        show = _git(self.repo, "show", "--name-status", "--format=%B", "HEAD")
        self.assertIn("メッセージ", show)
        self.assertIn("本文", show)
        committed = {line.split("\t", 1)[-1] for line in show.splitlines() if "\t" in line}
        self.assertTrue({"a.md", "new.md", "gone.md"} <= committed, show)
        self.assertNotIn("b.md", committed)
        self.assertNotIn("staged.md", committed)
        # 選ばなかった変更は作業ツリーに残り、別にstage済みの変更もstageのまま。
        status = _git(self.repo, "status", "--porcelain")
        self.assertIn(" M b.md", status)
        self.assertIn("M  staged.md", status)

    def test_rejects_unlisted_path_empty_message_and_empty_selection(self):
        (self.repo / "a.md").write_text("changed\n", encoding="utf-8")
        head = _git(self.repo, "rev-parse", "HEAD")
        self.assertEqual(self._post(["b.md"]).status_code, 409)
        self.assertEqual(self._post(["a.md"], message="  \n").status_code, 422)
        self.assertEqual(self._post([]).status_code, 422)
        self.assertEqual(self._post(["../outside.md"]).status_code, 409)
        self.assertEqual(_git(self.repo, "rev-parse", "HEAD"), head)

    def test_push_sets_upstream_with_single_remote(self):
        (self.repo / "a.md").write_text("changed\n", encoding="utf-8")
        response = self._post(["a.md"], push=True)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["pushed"], body)
        self.assertEqual(_git(self.remote, "rev-parse", "main").strip(), _git(self.repo, "rev-parse", "HEAD").strip())

        # 2回目はアップストリーム設定済みの通常のpush。
        (self.repo / "b.md").write_text("changed\n", encoding="utf-8")
        self.assertTrue(self._post(["b.md"], push=True).json()["pushed"])

    def test_push_failure_keeps_commit(self):
        _git(self.repo, "remote", "set-url", "origin", str(self.remote) + "-missing")
        (self.repo / "a.md").write_text("changed\n", encoding="utf-8")
        response = self._post(["a.md"], push=True)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertFalse(body["pushed"])
        self.assertTrue(body["push_error"])
        self.assertEqual(_git(self.repo, "log", "-1", "--format=%h").strip(), body["commit"])


if __name__ == "__main__":
    unittest.main()
