"""
3D差分 段階3（中核ロジック）: 頂点ごとの相手メッシュ表面までの距離、細分化、バイナリ形式のテスト。
- 同一形状は距離ほぼ0
- 寸法変更（長さ80→90）では、延長部分だけ距離が大きい
- 形状の位置移動では、移動した部分だけがしきい値を超える
- 細分化は辺長上限と頂点数上限を守る
- 位置・向きがずれた同一形状は、位置合わせ後に距離がほぼ0
- VDM1バイナリ（ヘッダJSON＋float32座標＋uint32インデックス＋float32距離）が往復変換できる
"""

import importlib.util
import math
import unittest

import numpy as np

HAS_MESH_DEPS = all(importlib.util.find_spec(name) is not None for name in ("trimesh", "scipy", "rtree"))


def _box(x0, y0, z0, dx, dy, dz):
    import trimesh

    return trimesh.creation.box(
        extents=[dx, dy, dz],
        transform=trimesh.transformations.translation_matrix([x0 + dx / 2, y0 + dy / 2, z0 + dz / 2]),
    )


def _plate_with_boss(boss_x):
    import trimesh

    plate = _box(0, 0, 0, 100, 60, 10)
    boss = trimesh.creation.cylinder(radius=8, height=10, transform=trimesh.transformations.translation_matrix([boss_x, 30, 15]))
    return trimesh.util.concatenate([plate, boss])


@unittest.skipUnless(HAS_MESH_DEPS, "requirements-3d.txt が未導入")
class TestSurfaceDistances(unittest.TestCase):
    def test_identical_meshes_have_zero_distance(self):
        from backend.app.mesh_diff import compute_mesh_diff

        mesh = _plate_with_boss(30)
        result = compute_mesh_diff(mesh.vertices, mesh.faces, mesh.vertices, mesh.faces, tolerance=0.05)
        self.assertLess(result.old.distances.max(), 1e-6)
        self.assertLess(result.new.distances.max(), 1e-6)
        self.assertEqual(result.alignment.applied, "identity")

    def test_dimension_change_only_extension_differs(self):
        from backend.app.mesh_diff import compute_mesh_diff

        old = _box(0, 0, 0, 80, 40, 20)
        new = _box(0, 0, 0, 90, 40, 20)
        result = compute_mesh_diff(old.vertices, old.faces, new.vertices, new.faces, tolerance=0.05)
        new_x = result.new.vertices[:, 0]
        self.assertLess(result.new.distances[new_x < 79].max(), 1e-6)
        self.assertAlmostEqual(result.new.distances.max(), 10.0, delta=0.1)
        old_x = result.old.vertices[:, 0]
        self.assertLess(result.old.distances[old_x < 79].max(), 1e-6)
        self.assertGreater(result.old.distances[old_x > 79.9].max(), 5.0)

    def test_moved_feature_exceeds_threshold_only_locally(self):
        from backend.app.mesh_diff import compute_mesh_diff

        old = _plate_with_boss(20)
        new = _plate_with_boss(70)
        threshold = 0.2
        result = compute_mesh_diff(old.vertices, old.faces, new.vertices, new.faces, tolerance=0.05)
        old_v = result.old.vertices
        near_old_boss = np.hypot(old_v[:, 0] - 20, old_v[:, 1] - 30) <= 8.5
        far_from_bosses = (np.hypot(old_v[:, 0] - 20, old_v[:, 1] - 30) > 9) & (np.hypot(old_v[:, 0] - 70, old_v[:, 1] - 30) > 9)
        self.assertLess(result.old.distances[far_from_bosses].max(), threshold)
        boss_side = near_old_boss & (old_v[:, 2] > 12)
        self.assertTrue((result.old.distances[boss_side] > threshold).all())
        new_v = result.new.vertices
        new_boss_top = (np.hypot(new_v[:, 0] - 70, new_v[:, 1] - 30) <= 8.5) & (new_v[:, 2] > 19.9)
        self.assertTrue((result.new.distances[new_boss_top] > threshold).all())

    def test_moved_and_rotated_identical_shape_is_near_zero_after_alignment(self):
        import trimesh

        from backend.app.mesh_diff import compute_mesh_diff

        old = trimesh.util.concatenate([_box(0, 0, 0, 60, 40, 8), _box(0, 0, 0, 8, 40, 50), _box(10, 3, 8, 20, 4, 20)])
        new = old.copy()
        new.apply_transform(trimesh.transformations.rotation_matrix(math.radians(40), [0, 1, 1]))
        new.apply_translation([30, -20, 15])
        result = compute_mesh_diff(old.vertices, old.faces, new.vertices, new.faces, tolerance=0.05)
        self.assertEqual(result.alignment.applied, "fit")
        diag = float(np.linalg.norm(old.extents))
        self.assertLess(result.new.distances.max(), diag * 2e-3)
        self.assertLess(result.old.distances.max(), diag * 2e-3)
        # 位置合わせ済み座標が返る（旧メッシュの範囲に重なる）
        np.testing.assert_allclose(result.new.vertices.min(axis=0), old.bounds[0], atol=diag * 2e-3)

    def test_progress_is_reported_monotonically(self):
        from backend.app.mesh_diff import compute_mesh_diff

        mesh = _box(0, 0, 0, 10, 10, 10)
        reports = []
        compute_mesh_diff(mesh.vertices, mesh.faces, mesh.vertices, mesh.faces, tolerance=0.01, progress=lambda stage, value: reports.append(value))
        self.assertGreater(len(reports), 2)
        self.assertEqual(reports, sorted(reports))
        self.assertAlmostEqual(reports[-1], 1.0)


@unittest.skipUnless(HAS_MESH_DEPS, "requirements-3d.txt が未導入")
class TestRefineMesh(unittest.TestCase):
    def test_respects_max_edge(self):
        from backend.app.mesh_diff import refine_mesh

        mesh = _box(0, 0, 0, 100, 60, 10)
        vertices, faces = refine_mesh(mesh.vertices, mesh.faces, max_edge=5.0, max_vertices=1_000_000)
        edges = vertices[faces[:, [1, 2, 0]]] - vertices[faces]
        self.assertLessEqual(np.linalg.norm(edges, axis=2).max(), 5.0 + 1e-9)

    def test_respects_vertex_cap(self):
        from backend.app.mesh_diff import refine_mesh

        mesh = _box(0, 0, 0, 100, 60, 10)
        vertices, _ = refine_mesh(mesh.vertices, mesh.faces, max_edge=0.5, max_vertices=5000)
        self.assertLessEqual(len(vertices), 5000)
        self.assertGreater(len(vertices), len(mesh.vertices))


class TestMeshBinary(unittest.TestCase):
    def test_round_trip(self):
        from backend.app.mesh_diff import pack_mesh_binary, unpack_mesh_binary

        vertices = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=np.float64)
        faces = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int64)
        distances = np.array([0.0, 0.5, 1.5, 2.0])
        data = pack_mesh_binary(vertices, faces, distances, {"side": "old"})
        self.assertEqual(data[:4], b"VDM1")
        self.assertEqual(len(data) % 4, 0)
        decoded = unpack_mesh_binary(data)
        self.assertEqual(decoded["header"]["vertex_count"], 4)
        self.assertEqual(decoded["header"]["face_count"], 2)
        self.assertEqual(decoded["header"]["side"], "old")
        np.testing.assert_allclose(decoded["positions"].reshape(-1, 3), vertices)
        np.testing.assert_array_equal(decoded["indices"].reshape(-1, 3), faces)
        np.testing.assert_allclose(decoded["distances"], distances)
        self.assertEqual(decoded["positions"].dtype, np.float32)
        self.assertEqual(decoded["indices"].dtype, np.uint32)


if __name__ == "__main__":
    unittest.main()
