"""
Git差分画面でのテキスト編集APIのテスト。
- POST /api/git/text-diff  : 編集中テキストとHEADの差分行を返す（ファイルは書き換えない）
- POST /api/git/save-text  : 作業ツリーへ保存する。改行コード（CRLF）と文字コード（CP932）は元ファイルに合わせる
                             プレビュー後にファイルが外部で変更されていたら 409 で拒否する
- POST /api/git/revert-line: 1行復元後の全文（text_current）も返し、UIが本文を更新できる
"""

import subprocess
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.main import app


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True)


class TestGitTextEditing(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp_dir.name)
        _git(self.repo, "init", "--quiet")
        _git(self.repo, "config", "user.email", "test@example.com")
        _git(self.repo, "config", "user.name", "Tester")

    def tearDown(self):
        self.temp_dir.cleanup()

    def _commit(self, name: str, content: bytes) -> Path:
        path = self.repo / name
        path.write_bytes(content)
        _git(self.repo, "add", name)
        _git(self.repo, "commit", "--quiet", "-m", f"add {name}")
        return path

    def _payload(self, name: str, **extra) -> dict:
        return {"folder": str(self.repo), "path": name, "head_path": name, "text_extensions": [".md", ".txt"], **extra}

    def test_text_diff_previews_without_writing(self):
        path = self._commit("note.md", b"a\nb\n")
        response = self.client.post("/api/git/text-diff", json=self._payload("note.md", text="a\nB\n"))
        self.assertEqual(response.status_code, 200, response.text)
        rows = response.json()["rows"]
        self.assertEqual([row["kind"] for row in rows], ["equal", "replace"])
        self.assertEqual(path.read_bytes(), b"a\nb\n")

    def test_save_text_keeps_crlf_and_cp932(self):
        path = self._commit("memo.txt", "一行目\r\n二行目\r\n".encode("cp932"))
        response = self.client.post(
            "/api/git/save-text",
            json=self._payload("memo.txt", base_text="一行目\n二行目\n", text="一行目\n変更\n"),
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["encoding_current"], "cp932")
        self.assertEqual(path.read_bytes(), "一行目\r\n変更\r\n".encode("cp932"))
        self.assertEqual([row["kind"] for row in response.json()["rows"]], ["equal", "replace"])

    def test_save_text_rejects_external_change(self):
        path = self._commit("note.md", b"original\n")
        path.write_bytes(b"changed elsewhere\n")
        response = self.client.post(
            "/api/git/save-text",
            json=self._payload("note.md", base_text="original\n", text="my edit\n"),
        )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(path.read_bytes(), b"changed elsewhere\n")
        self.assertEqual(list(self.repo.glob(".*.tmp")), [])

    def test_save_text_rejects_path_outside_repository(self):
        self._commit("note.md", b"x\n")
        response = self.client.post("/api/git/save-text", json=self._payload("../outside.md", text="x"))
        self.assertEqual(response.status_code, 422, response.text)

    def test_revert_line_returns_restored_text(self):
        path = self._commit("note.md", b"keep\nold\n")
        path.write_bytes(b"keep\nnew\n")
        item = self.client.post("/api/git/item", json=self._payload("note.md")).json()
        changed = next(row for row in item["rows"] if row["kind"] == "replace")
        response = self.client.post("/api/git/revert-line", json=self._payload("note.md", row=changed))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["text_current"], "keep\nold\n")
        self.assertEqual(path.read_bytes(), b"keep\nold\n")


if __name__ == "__main__":
    unittest.main()
