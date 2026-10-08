"""
3Dメッシュ差分・STEP変換の並列計算・高速化テスト仕様

1. parallel_closest_point による頂点距離計算のマルチスレッド/並列チャンク計算
   - 単一スレッド計算と完全に同一の距離・最近傍点結果を返すこと
   - クエリ頂点群のチャンク分割・結合が正しく機能すること
2. compute_mesh_diff における新旧メッシュの並行処理
   - 新旧メッシュの細分化（refine_mesh）および距離計算が並行実行され、正確な差分結果を生成すること
   - 進捗報告（progress）が正常に通知されること
3. load_step_pair_as_meshes における新旧STEPの並行読み込み・テッセレーション
   - 新旧のSTEP解析・メッシュ化が並行実行され、同一のメッシュペアが返ること
"""

import importlib.util
import unittest
from pathlib import Path
import numpy as np

HAS_MESH_DEPS = all(importlib.util.find_spec(name) is not None for name in ("trimesh", "scipy", "rtree"))
HAS_OCP = importlib.util.find_spec("OCP") is not None and HAS_MESH_DEPS


@unittest.skipUnless(HAS_MESH_DEPS, "3Dメッシュ依存ライブラリ（trimesh, scipy, rtree）が未導入")
class TestMeshParallel(unittest.TestCase):
    def test_parallel_closest_point_matches_single_thread(self):
        """並列closest_pointの計算結果が単一スレッド版と完全一致すること"""
        import trimesh
        from backend.app.mesh_diff import parallel_closest_point

        mesh = trimesh.creation.icosphere(subdivisions=3, radius=10.0)
        rng = np.random.default_rng(42)
        query_points = rng.uniform(-15, 15, size=(4000, 3))

        # 単一スレッド版
        closest_single, dist_single, _ = trimesh.proximity.closest_point(mesh, query_points)

        # 並列版（4ワーカー）
        closest_parallel, dist_parallel, _ = parallel_closest_point(mesh, query_points, max_workers=4)

        np.testing.assert_allclose(dist_parallel, dist_single, atol=1e-5)
        np.testing.assert_allclose(closest_parallel, closest_single, atol=1e-5)

    def test_compute_mesh_diff_with_parallelism(self):
        """並列化されたcompute_mesh_diffが正確な差分を算出し進捗が報告されること"""
        import trimesh
        from backend.app.mesh_diff import compute_mesh_diff

        old_mesh = trimesh.creation.box(
            extents=[80, 40, 20],
            transform=trimesh.transformations.translation_matrix([40, 20, 10]),
        )
        new_mesh = trimesh.creation.box(
            extents=[90, 40, 20],
            transform=trimesh.transformations.translation_matrix([45, 20, 10]),
        )

        progress_reports = []
        result = compute_mesh_diff(
            old_mesh.vertices,
            old_mesh.faces,
            new_mesh.vertices,
            new_mesh.faces,
            tolerance=0.05,
            progress=lambda stage, val: progress_reports.append(val),
        )

        self.assertGreater(len(progress_reports), 0)
        self.assertAlmostEqual(progress_reports[-1], 1.0)
        # 延長された部分（X >= 80）の距離が約10mmであること
        new_x = result.new.vertices[:, 0]
        self.assertAlmostEqual(result.new.distances.max(), 10.0, delta=0.2)
        self.assertLess(result.new.distances[new_x < 39].max(), 1e-4)

    @unittest.skipUnless(HAS_OCP, "OCPが未導入")
    def test_load_step_pair_as_meshes_parallel(self):
        """新旧STEPの読み込み・メッシュ化が並行実行され、正しいメッシュペアが返ること"""
        from backend.app.step_mesh import load_step_pair_as_meshes

        root = Path(__file__).resolve().parents[1]
        step_dir = root / "samples" / "step"
        old_path = step_dir / "dimension_a.step"
        new_path = step_dir / "dimension_b.step"

        progress_calls = []
        pair = load_step_pair_as_meshes(
            old_path,
            new_path,
            quality="coarse",
            progress=lambda stage, frac: progress_calls.append(frac),
        )

        self.assertEqual(pair.old.filename, "dimension_a.step")
        self.assertEqual(pair.new.filename, "dimension_b.step")
        self.assertGreater(len(pair.old.vertices), 0)
        self.assertGreater(len(pair.new.vertices), 0)
        self.assertGreater(pair.linear_deflection, 0)
