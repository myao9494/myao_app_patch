"""
Git管理下における単体3D CADファイル（新規追加・削除）の3D表示プレビューテスト
- HEADが存在しない新規追加ファイル（untracked / added）の単体3Dジョブ作成とメッシュ取得
- 作業ツリーが存在しない削除済みファイル（deleted）の単体3Dジョブ作成とメッシュ取得
"""

import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.main import app


class TestGit3dSingleFile(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repo_dir = Path(self.temp_dir.name)
        # Gitリポジトリ初期化
        subprocess.run(["git", "init"], cwd=self.repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=self.repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.name", "Test User"], cwd=self.repo_dir, check=True, capture_output=True)

        # サンプルSTEPファイル
        sample_path = Path(__file__).resolve().parents[1] / "samples" / "step" / "dimension_a.step"
        self.step_bytes = sample_path.read_bytes()

    def tearDown(self):
        self.temp_dir.cleanup()

    def _wait_job(self, job_id: str, timeout_sec: float = 15.0) -> dict:
        start = time.time()
        while time.time() - start < timeout_sec:
            res = self.client.get(f"/api/3d/jobs/{job_id}")
            self.assertEqual(res.status_code, 200)
            data = res.json()
            if data["status"] in ("done", "error"):
                return data
            time.sleep(0.3)
        self.fail(f"Job {job_id} did not finish within {timeout_sec} seconds")

    def test_git_3d_job_new_file(self):
        """HEADに存在せず作業ツリーのみに存在する新規STEPファイルが単体3D表示ジョブとして完了すること"""
        new_step_path = self.repo_dir / "new_model.step"
        new_step_path.write_bytes(self.step_bytes)

        # ジョブ作成 (HEADなし、作業ツリーあり)
        res = self.client.post(
            "/api/git/3d/jobs",
            json={
                "folder": str(self.repo_dir),
                "path": "new_model.step",
                "head_path": "new_model.step",
                "has_head": False,
                "has_current": True,
                "quality": "coarse",
            },
        )
        self.assertEqual(res.status_code, 202)
        job_id = res.json()["job_id"]

        status_data = self._wait_job(job_id)
        self.assertEqual(status_data["status"], "done")
        self.assertEqual(status_data.get("single_mode"), "new")
        self.assertIsNotNone(status_data["stats"].get("new"))

        # /mesh/new からVDM1バイナリを取得できること
        mesh_res = self.client.get(f"/api/3d/jobs/{job_id}/mesh/new")
        self.assertEqual(mesh_res.status_code, 200)
        self.assertTrue(mesh_res.content.startswith(b"VDM1"))

    def test_git_3d_job_deleted_file(self):
        """作業ツリーで削除されHEADにのみ存在するSTEPファイルが旧版単体3D表示ジョブとして完了すること"""
        del_step_path = self.repo_dir / "deleted_model.step"
        del_step_path.write_bytes(self.step_bytes)
        subprocess.run(["git", "add", "deleted_model.step"], cwd=self.repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add deleted_model.step"], cwd=self.repo_dir, check=True, capture_output=True)
        # 作業ツリーから削除
        del_step_path.unlink()

        res = self.client.post(
            "/api/git/3d/jobs",
            json={
                "folder": str(self.repo_dir),
                "path": "deleted_model.step",
                "head_path": "deleted_model.step",
                "has_head": True,
                "has_current": False,
                "quality": "coarse",
            },
        )
        self.assertEqual(res.status_code, 202)
        job_id = res.json()["job_id"]

        status_data = self._wait_job(job_id)
        self.assertEqual(status_data["status"], "done")
        self.assertEqual(status_data.get("single_mode"), "old")
        self.assertIsNotNone(status_data["stats"].get("old"))

        # /mesh/old からVDM1バイナリを取得できること
        mesh_res = self.client.get(f"/api/3d/jobs/{job_id}/mesh/old")
        self.assertEqual(mesh_res.status_code, 200)
        self.assertTrue(mesh_res.content.startswith(b"VDM1"))


if __name__ == "__main__":
    unittest.main()
