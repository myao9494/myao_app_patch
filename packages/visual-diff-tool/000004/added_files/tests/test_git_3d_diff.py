"""
3D CAD (STEP) ファイルの Git 差分連携機能の単体テスト仕様。
- _is_git_3d_path および _git_file_kind による .step / .stp 拡張子の自動判定
- Git 管理下での STEP ファイル変更検出 (kind: '3d', diffable: True)
- POST /api/git/3d/jobs エンドポイントによる HEAD と作業ツリーからの3D差分ジョブ作成
"""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from starlette.testclient import TestClient

from backend.app.main import app, _git_file_kind, _is_git_3d_path


class TestGit3dDiff(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.temp_dir = tempfile.mkdtemp()
        self.repo_dir = Path(self.temp_dir) / "test_repo"
        self.repo_dir.mkdir()

        # Git 初期化
        subprocess.run(["git", "init"], cwd=self.repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=self.repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.name", "Test User"], cwd=self.repo_dir, check=True, capture_output=True)

        # サンプルの STEP データを準備
        samples_dir = Path(__file__).resolve().parents[1] / "backend" / "app" / "samples_3d"
        sample_old = samples_dir / "sample_a_bracket.step"
        sample_new = samples_dir / "sample_b_hole_moved.step"

        if sample_old.exists() and sample_new.exists():
            self.step_content_old = sample_old.read_bytes()
            self.step_content_new = sample_new.read_bytes()
        else:
            self.step_content_old = b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"
            self.step_content_new = b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n#1=DUMMY;\nENDSEC;\nEND-ISO-10303-21;\n"

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_git_3d_path_detection(self):
        """_is_git_3d_path および _git_file_kind が .step / .stp を '3d' として認識する"""
        self.assertTrue(_is_git_3d_path("model.step"))
        self.assertTrue(_is_git_3d_path("model.STEP"))
        self.assertTrue(_is_git_3d_path("parts/sub/bracket.stp"))
        self.assertTrue(_is_git_3d_path("parts/sub/bracket.STP"))
        self.assertFalse(_is_git_3d_path("drawing.png"))
        self.assertFalse(_is_git_3d_path("note.md"))

        text_exts = {".md", ".txt"}
        self.assertEqual(_git_file_kind("model.step", text_exts), "3d")
        self.assertEqual(_git_file_kind("model.stp", text_exts), "3d")
        self.assertEqual(_git_file_kind("image.png", text_exts), "image")
        self.assertEqual(_git_file_kind("note.md", text_exts), "text")
        self.assertIsNone(_git_file_kind("archive.zip", text_exts))

    def test_changed_files_detects_3d_step(self):
        """Git リポジトリ内の STEP ファイルの変更が kind: '3d' として検出される"""
        step_file = self.repo_dir / "bracket.step"
        step_file.write_bytes(self.step_content_old)
        subprocess.run(["git", "add", "bracket.step"], cwd=self.repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add bracket.step"], cwd=self.repo_dir, check=True, capture_output=True)

        # 作業ツリーで変更
        step_file.write_bytes(self.step_content_new)

        resp = self.client.post("/api/git/files", json={"folder": str(self.repo_dir)})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        files = data.get("files", [])

        step_entries = [f for f in files if f["path"] == "bracket.step"]
        self.assertEqual(len(step_entries), 1)
        entry = step_entries[0]
        self.assertEqual(entry["kind"], "3d")
        self.assertEqual(entry["change_type"], "modified")
        self.assertTrue(entry["has_head"])
        self.assertTrue(entry["has_current"])
        self.assertTrue(entry["diffable"])

    def test_create_git_3d_job_success(self):
        """POST /api/git/3d/jobs により HEAD と作業ツリーから 3D 差分ジョブが作成できる"""
        step_file = self.repo_dir / "bracket.step"
        step_file.write_bytes(self.step_content_old)
        subprocess.run(["git", "add", "bracket.step"], cwd=self.repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add bracket.step"], cwd=self.repo_dir, check=True, capture_output=True)

        # 作業ツリーで変更
        step_file.write_bytes(self.step_content_new)

        resp = self.client.post(
            "/api/git/3d/jobs",
            json={
                "folder": str(self.repo_dir),
                "path": "bracket.step",
                "head_path": "bracket.step",
                "quality": "coarse",
                "align_mode": "auto",
            },
        )
        self.assertEqual(resp.status_code, 202)
        data = resp.json()
        self.assertIn("job_id", data)
        self.assertEqual(data.get("status"), "pending")

    def test_create_git_3d_job_rejects_non_step(self):
        """非 STEP ファイルのパスが指定された場合は 400 エラーを返す"""
        text_file = self.repo_dir / "note.txt"
        text_file.write_text("hello")
        subprocess.run(["git", "add", "note.txt"], cwd=self.repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add note.txt"], cwd=self.repo_dir, check=True, capture_output=True)

        resp = self.client.post(
            "/api/git/3d/jobs",
            json={
                "folder": str(self.repo_dir),
                "path": "note.txt",
            },
        )
        self.assertEqual(resp.status_code, 400)


if __name__ == "__main__":
    unittest.main()
