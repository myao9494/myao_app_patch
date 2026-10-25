"""
API の入力検証・安定性に関する回帰テスト。
- 3DジョブIDは uuid4 の16進32文字だけを受け付け、`..` などでジョブ領域外を読み書き・削除させない
- 3Dサンプル読み込みは定義済みIDだけを受け付ける
- 静的ファイル配信は frontend/dist 直下のファイルだけを返す
- 単体プレビュー（片側だけのSTEP）で失敗しても、原因を status.json に残して入力を削除する
- Excalidraw埋め込みMarkdownのテキスト差分にも行数上限を適用する
- Markdown起点の git status はパス指定を分割しても同じ結果になる
"""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.app import git_repo, main
from backend.app.git_repo import changed_files, chunk_paths_by_length
from backend.app.main import app
from backend.app.mesh_jobs import (
    MeshDiffJobManager,
    _worker_entrypoint,
    is_valid_job_id,
)
from backend.app.routes import three_d
from backend.app.text_diff import MAX_TEXT_DIFF_LINES, build_markdown_text_diff_rows


class TestMeshJobIdValidation(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.parent = Path(self.temp_dir.name)
        self.sentinel = self.parent / "sentinel.txt"
        self.sentinel.write_text("keep", encoding="utf-8")
        self.manager = MeshDiffJobManager(self.parent / "jobs", retention_minutes=30)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_only_uuid_hex_ids_are_valid(self):
        self.assertTrue(is_valid_job_id("0123456789abcdef0123456789abcdef"))
        for job_id in ("..", ".", "", "../jobs", "does-not-exist", "0123456789ABCDEF0123456789ABCDEF"):
            self.assertFalse(is_valid_job_id(job_id), job_id)

    def test_parent_directory_is_never_deleted_or_read(self):
        self.assertFalse(self.manager.delete_job(".."))
        self.assertIsNone(self.manager.get_status(".."))
        self.assertIsNone(self.manager.get_mesh_binary("..", "old"))
        self.assertTrue(self.sentinel.exists())
        self.assertTrue((self.parent / "jobs").exists())
        with self.assertRaises(ValueError):
            self.manager.job_dir("..")

    def test_api_rejects_dot_segments(self):
        client = TestClient(app)
        with patch.object(three_d, "mesh_job_manager", self.manager):
            self.assertEqual(client.delete("/api/3d/jobs/%2e%2e").status_code, 404)
            self.assertEqual(client.get("/api/3d/jobs/%2e%2e").status_code, 404)
            self.assertEqual(client.get("/api/3d/jobs/%2e%2e/mesh/old").status_code, 404)
        self.assertTrue(self.sentinel.exists())


class TestSampleAndStaticValidation(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_unknown_or_path_like_sample_id_is_404(self):
        for sample_id in ("../step/hole_position", "unknown", ""):
            response = self.client.post("/api/3d/samples/load", json={"sample_id": sample_id})
            self.assertEqual(response.status_code, 404, sample_id)

    def test_static_files_are_limited_to_dist_root(self):
        self.assertIsNone(main._resolve_dist_file("../README.md"))
        self.assertIsNone(main._resolve_dist_file(".."))
        self.assertIsNone(main._resolve_dist_file("assets"))
        if (main.DIST_DIR / "favicon.svg").exists():
            self.assertEqual(main._resolve_dist_file("favicon.svg"), (main.DIST_DIR / "favicon.svg").resolve())


class TestSingleStepJobFailure(unittest.TestCase):
    def test_single_side_failure_writes_error_status_and_removes_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            job_dir = Path(tmp)
            (job_dir / "status.json").write_text(json.dumps({"status": "running"}), encoding="utf-8")
            broken = job_dir / "input_new.step"
            broken.write_bytes(b"ISO-10303-21;\nbroken")
            # 以前は片側が空のとき、エラー処理中に None.unlink() で二重例外となり原因が失われていた。
            _worker_entrypoint(str(job_dir), "", str(broken), "", "broken.step", "coarse", "auto", None)
            status = json.loads((job_dir / "status.json").read_text(encoding="utf-8"))
            self.assertEqual(status["status"], "error")
            self.assertTrue(status["error"])
            self.assertFalse(broken.exists())


class TestTextDiffLimits(unittest.TestCase):
    def test_embedded_excalidraw_markdown_respects_line_limit(self):
        marker = "---\nexcalidraw-plugin: parsed\n---\n"
        huge = marker + "\n".join(f"line {index}" for index in range(MAX_TEXT_DIFF_LINES + 1))
        with self.assertRaises(HTTPException) as caught:
            build_markdown_text_diff_rows("", huge)
        self.assertEqual(caught.exception.status_code, 413)


class TestGitStatusChunking(unittest.TestCase):
    def test_chunk_paths_by_length(self):
        paths = [f"dir/file_{index:03d}.md" for index in range(50)]
        chunks = chunk_paths_by_length(paths, 100)
        self.assertEqual([path for chunk in chunks for path in chunk], paths)
        self.assertTrue(all(sum(len(path) + 1 for path in chunk) <= 100 for chunk in chunks))
        self.assertEqual(chunk_paths_by_length(["x" * 300], 100), [["x" * 300]])

    def test_chunked_status_matches_single_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
            for index in range(12):
                (repo / f"note_{index:02d}.md").write_text(f"note {index}\n", encoding="utf-8")
            paths = {f"note_{index:02d}.md" for index in range(12)}
            expected = changed_files(repo, repo, {".md"}, specific_paths=paths)
            with patch.object(git_repo, "GIT_PATHSPEC_CHUNK_CHARS", 30):
                chunked = changed_files(repo, repo, {".md"}, specific_paths=paths)
            self.assertEqual(len(expected), 12)
            self.assertEqual(chunked, expected)


if __name__ == "__main__":
    unittest.main()
