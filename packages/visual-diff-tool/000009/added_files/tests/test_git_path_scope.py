"""
フォルダー・ファイル 1 つを起点にした Git 差分のテスト仕様。
ファイルマネージャーの右クリック「差分を表示」や、ハーネスの LLM から、パスだけで差分の画面を開くために使う。

- POST /api/git/files: folder にフォルダーを渡すと、そのフォルダーの中の変更だけを返す (従来どおり)
- POST /api/git/files: folder に Markdown 以外のファイルを渡すと、そのファイル 1 つの変更だけを返す
  (Markdown は従来どおり、ノートとリンク先の変更)。folder にはファイルの親フォルダーを返す
- 対象拡張子に入っていないファイル 1 つを渡すと、設定で足すよう案内する 422
- その後の操作 (/api/git/item など) は、folder にファイルのパスを渡しても動く (親フォルダーとして扱う)
- GET /api/git/path?path=...: フォルダー・ファイル・Markdown のどれでも、変更の一覧と人が開く diff_url (/?git_path=...) を返す
- エコシステムの名乗りに、git.path の操作と git_path のリンクを載せる
"""

import subprocess
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote

from fastapi.testclient import TestClient

from backend.app.main import app


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)


class GitPathScopeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = Path(self._tmp.name).resolve() / "repo"
        (self.repo / "docs").mkdir(parents=True)
        (self.repo / "other").mkdir()
        _git(self.repo, "init", "-q")
        _git(self.repo, "config", "user.email", "test@example.invalid")
        _git(self.repo, "config", "user.name", "test")
        (self.repo / "docs" / "a.txt").write_text("一行目\n", encoding="utf-8")
        (self.repo / "docs" / "b.txt").write_text("変えない\n", encoding="utf-8")
        (self.repo / "docs" / "tool.py").write_text("print(1)\n", encoding="utf-8")
        (self.repo / "other" / "c.txt").write_text("別のフォルダー\n", encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "init")
        (self.repo / "docs" / "a.txt").write_text("一行目\n二行目\n", encoding="utf-8")
        (self.repo / "docs" / "tool.py").write_text("print(2)\n", encoding="utf-8")
        (self.repo / "other" / "c.txt").write_text("別のフォルダーも変えた\n", encoding="utf-8")

    def files(self, path: Path, extensions: list[str] | None = None) -> dict:
        response = self.client.post("/api/git/files", json={"folder": str(path), "text_extensions": extensions or [".txt", ".md"]})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_フォルダーはその中の変更だけ(self) -> None:
        body = self.files(self.repo / "docs")
        self.assertEqual([f["path"] for f in body["files"]], ["docs/a.txt"])

    def test_ファイル1つはそのファイルの変更だけ(self) -> None:
        body = self.files(self.repo / "docs" / "a.txt")
        self.assertEqual([f["path"] for f in body["files"]], ["docs/a.txt"])
        self.assertEqual(Path(body["folder"]), self.repo / "docs")
        self.assertEqual(Path(body["single_file"]), self.repo / "docs" / "a.txt")

    def test_変わっていないファイル1つは空(self) -> None:
        self.assertEqual(self.files(self.repo / "docs" / "b.txt")["files"], [])

    def test_対象拡張子に無いファイル1つは設定を案内する(self) -> None:
        response = self.client.post("/api/git/files", json={"folder": str(self.repo / "docs" / "tool.py"), "text_extensions": [".txt"]})
        self.assertEqual(response.status_code, 422)
        self.assertIn(".py", response.json()["detail"])
        self.assertIn("対象拡張子", response.json()["detail"])
        self.assertEqual([f["path"] for f in self.files(self.repo / "docs" / "tool.py", [".txt", ".py"])["files"]], ["docs/tool.py"])

    def test_ファイルのパスのままでも項目を読める(self) -> None:
        response = self.client.post("/api/git/item", json={"folder": str(self.repo / "docs" / "a.txt"), "path": "docs/a.txt", "text_extensions": [".txt"]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("二行目", response.json()["text_current"])

    def test_GETのgit_pathは一覧と画面のURLを返す(self) -> None:
        for target, expected in ((self.repo / "docs", ["docs/a.txt"]), (self.repo / "docs" / "a.txt", ["docs/a.txt"])):
            response = self.client.get("/api/git/path", params={"path": str(target)})
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertEqual([f["path"] for f in body["files"]], expected)
            self.assertEqual(body["diff_url"], f"http://testserver/?git_path={quote(str(target), safe='')}")

    def test_GETのgit_pathはGitの外を断る(self) -> None:
        outside = Path(self._tmp.name).resolve() / "outside"
        outside.mkdir()
        response = self.client.get("/api/git/path", params={"path": str(outside)})
        self.assertGreaterEqual(response.status_code, 400)
        missing = self.client.get("/api/git/path", params={"path": str(self.repo / "無い.txt")})
        self.assertEqual(missing.status_code, 404)

    def test_名乗りにgit_pathを載せる(self) -> None:
        body = self.client.get("/api/ecosystem").json()
        self.assertEqual(body["links"]["git"], "/?git_path={path}")
        operations = {op["id"]: op for op in body["operations"]}
        self.assertEqual(operations["git.path"], {"id": "git.path", "method": "GET", "path": "/api/git/path", "effect": "read"})


if __name__ == "__main__":
    unittest.main()
