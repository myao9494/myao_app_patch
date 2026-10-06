"""
3D差分 段階3（API）: 非同期ジョブAPIのテスト。
- GET  /api/3d/status            : 3D依存の導入状況
- POST /api/3d/jobs              : 新旧STEPを受け取り job_id を即時返却（重い処理は子プロセス）
- GET  /api/3d/jobs/{id}         : 状態・進捗・警告・エラー・統計
- GET  /api/3d/jobs/{id}/mesh/{side} : 位置合わせ済みメッシュと頂点距離（VDM1バイナリ）
- DELETE /api/3d/jobs/{id}       : 結果の即時破棄
アップロードされたSTEPは変換後に削除され、結果は保持期間経過後に削除されること。
"""

import importlib.util
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from backend.app.main import app

ROOT = Path(__file__).resolve().parents[1]
STEP_DIR = ROOT / "samples" / "step"
HAS_3D = all(importlib.util.find_spec(name) is not None for name in ("OCP", "trimesh", "scipy", "rtree"))


def _files(old: Path, new: Path, old_bytes: bytes | None = None):
    return {
        "file_old": (old.name, old_bytes if old_bytes is not None else old.read_bytes(), "application/octet-stream"),
        "file_new": (new.name, new.read_bytes(), "application/octet-stream"),
    }


class TestMeshApiValidation(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_status_reports_availability(self):
        response = self.client.get("/api/3d/status")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["available"], HAS_3D)
        self.assertIn("missing", body)
        self.assertIn("requirements-3d.txt", body["install_hint"])

    def test_rejects_non_step_extension(self):
        files = {
            "file_old": ("drawing.png", b"x", "image/png"),
            "file_new": ("part_b.step", b"ISO-10303-21;", "application/octet-stream"),
        }
        response = self.client.post("/api/3d/jobs", files=files)
        self.assertEqual(response.status_code, 400)
        self.assertIn("STEP", response.json()["detail"])

    @unittest.skipUnless(HAS_3D, "requirements-3d.txt が未導入")
    def test_rejects_unknown_quality(self):
        files = _files(STEP_DIR / "dimension_a.step", STEP_DIR / "dimension_b.step")
        response = self.client.post("/api/3d/jobs", files=files, data={"quality": "ultra"})
        self.assertEqual(response.status_code, 400)

    def test_unknown_job_is_404(self):
        self.assertEqual(self.client.get("/api/3d/jobs/does-not-exist").status_code, 404)


@unittest.skipUnless(HAS_3D, "requirements-3d.txt が未導入")
class TestMeshApiJobs(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def _wait(self, job_id: str, timeout: float = 180.0) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            body = self.client.get(f"/api/3d/jobs/{job_id}").json()
            if body["status"] in {"done", "error"}:
                return body
            time.sleep(0.2)
        self.fail("ジョブがタイムアウトしました")

    def _mesh(self, job_id: str, side: str) -> dict:
        from backend.app.mesh_diff import unpack_mesh_binary

        response = self.client.get(f"/api/3d/jobs/{job_id}/mesh/{side}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/octet-stream")
        return unpack_mesh_binary(response.content)

    def test_full_job_lifecycle(self):
        from backend.app.main import mesh_job_manager

        response = self.client.post(
            "/api/3d/jobs",
            files=_files(STEP_DIR / "hole_position_a.step", STEP_DIR / "hole_position_b.step"),
            data={"quality": "standard", "align_mode": "auto"},
        )
        self.assertEqual(response.status_code, 202)
        job_id = response.json()["job_id"]
        body = self._wait(job_id)
        self.assertEqual(body["status"], "done", body.get("error"))
        self.assertAlmostEqual(body["progress"], 1.0)
        stats = body["stats"]
        self.assertGreater(stats["linear_deflection"], 0)
        self.assertEqual(stats["alignment"]["applied"], "identity")
        self.assertIn("retention_minutes", body)

        old = self._mesh(job_id, "old")
        new = self._mesh(job_id, "new")
        self.assertEqual(len(old["distances"]), old["header"]["vertex_count"])
        # 穴が30mm移動しているため、旧穴の壁面は新形状から離れている（板厚10mmの中央で最大5.0mm）
        self.assertGreaterEqual(float(old["distances"].max()), 5.0)
        self.assertGreaterEqual(float(new["distances"].max()), 5.0)
        # 大部分（板の面）は一致している
        self.assertLess(float(np.median(old["distances"])), stats["linear_deflection"])

        # アップロードされたSTEPは変換後に削除されている
        job_dir = mesh_job_manager.job_dir(job_id)
        self.assertEqual(list(job_dir.glob("*.step")) + list(job_dir.glob("*.stp")), [])

        self.assertEqual(self.client.delete(f"/api/3d/jobs/{job_id}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/3d/jobs/{job_id}").status_code, 404)
        self.assertFalse(job_dir.exists())

    def test_moved_rotated_pair_is_aligned(self):
        response = self.client.post(
            "/api/3d/jobs",
            files=_files(STEP_DIR / "moved_rotated_a.step", STEP_DIR / "moved_rotated_b.step"),
            data={"quality": "standard"},
        )
        body = self._wait(response.json()["job_id"])
        self.assertEqual(body["status"], "done", body.get("error"))
        self.assertEqual(body["stats"]["alignment"]["applied"], "fit")
        self.assertTrue(any("位置合わせ" in warning for warning in body["warnings"]))
        new = self._mesh(body["job_id"], "new")
        self.assertLess(float(new["distances"].max()), 0.5)

    def test_broken_step_reports_readable_error(self):
        response = self.client.post(
            "/api/3d/jobs",
            files=_files(STEP_DIR / "dimension_a.step", STEP_DIR / "dimension_b.step", old_bytes=b"ISO-10303-21;\nbroken"),
        )
        self.assertEqual(response.status_code, 202)
        body = self._wait(response.json()["job_id"])
        self.assertEqual(body["status"], "error")
        self.assertIn("旧ファイル", body["error"])
        self.assertIn("dimension_a.step", body["error"])
        self.assertEqual(self.client.get(f"/api/3d/jobs/{body['job_id']}/mesh/old").status_code, 409)

    def test_samples_endpoint_and_direct_load(self):
        samples_res = self.client.get("/api/3d/samples")
        self.assertEqual(samples_res.status_code, 200)
        samples = samples_res.json()
        self.assertGreaterEqual(len(samples), 5)
        self.assertTrue(any(s["id"] == "hole_position" for s in samples))

        load_res = self.client.post(
            "/api/3d/samples/load",
            json={"sample_id": "hole_position", "quality": "standard", "align_mode": "auto"},
        )
        self.assertEqual(load_res.status_code, 202)
        job_id = load_res.json()["job_id"]
        body = self._wait(job_id)
        self.assertEqual(body["status"], "done")


class TestMeshJobRetention(unittest.TestCase):
    def test_expired_jobs_are_removed(self):
        from backend.app.mesh_jobs import MeshDiffJobManager

        with tempfile.TemporaryDirectory() as tmp:
            manager = MeshDiffJobManager(Path(tmp), retention_minutes=30)
            job_id = manager.register_finished_job_for_test(finished_at=datetime.now(timezone.utc) - timedelta(minutes=31))
            self.assertTrue(manager.job_dir(job_id).exists())
            removed = manager.cleanup_expired()
            self.assertEqual(removed, 1)
            self.assertIsNone(manager.get_status(job_id))
            self.assertFalse(manager.job_dir(job_id).exists())

    def test_orphan_directories_are_removed_on_startup(self):
        from backend.app.mesh_jobs import MeshDiffJobManager

        with tempfile.TemporaryDirectory() as tmp:
            orphan = Path(tmp) / "orphan-job"
            orphan.mkdir()
            (orphan / "old.step").write_bytes(b"x")
            MeshDiffJobManager(Path(tmp), retention_minutes=30)
            self.assertFalse(orphan.exists())


if __name__ == "__main__":
    unittest.main()
