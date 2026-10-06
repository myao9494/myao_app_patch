"""
3D差分 段階2: 位置合わせ（重心・慣性主軸による粗合わせ＋トリム付きICP）のテスト。
- 元座標が一致していれば変換しない（追加形状で重心がずれても全体を動かさない）
- 平行移動・回転でずれた同一形状を復元できる
- 変更部分を含んでいても、共通部分で位置が合う
- mode="none" は常に恒等変換
- バウンディングボックス比から単位不一致（inch/m）の疑いを警告する
外部ファイルに依存しないよう、trimeshで合成したメッシュを使う。
"""

import importlib.util
import math
import unittest

import numpy as np

HAS_MESH_DEPS = all(importlib.util.find_spec(name) is not None for name in ("trimesh", "scipy", "rtree"))


def _rotation(z_deg: float, x_deg: float) -> np.ndarray:
    import trimesh

    rz = trimesh.transformations.rotation_matrix(math.radians(z_deg), [0, 0, 1])
    rx = trimesh.transformations.rotation_matrix(math.radians(x_deg), [1, 0, 0])
    return rx @ rz


def _bracket():
    """非対称なL字ブラケット（主軸が一意に決まる形状）。"""
    import trimesh

    base = trimesh.creation.box(extents=[60, 40, 8], transform=trimesh.transformations.translation_matrix([30, 20, 4]))
    wall = trimesh.creation.box(extents=[8, 40, 50], transform=trimesh.transformations.translation_matrix([4, 20, 25]))
    rib = trimesh.creation.box(extents=[20, 4, 20], transform=trimesh.transformations.translation_matrix([18, 5, 18]))
    return trimesh.util.concatenate([base, wall, rib])


def _boss():
    import trimesh

    return trimesh.creation.cylinder(radius=8, height=12, transform=trimesh.transformations.translation_matrix([45, 30, 14]))


def _max_vertex_error(mesh_a, mesh_b) -> float:
    return float(np.abs(np.asarray(mesh_a.vertices) - np.asarray(mesh_b.vertices)).max())


@unittest.skipUnless(HAS_MESH_DEPS, "requirements-3d.txt が未導入")
class TestAlignment(unittest.TestCase):
    def test_identical_meshes_keep_identity(self):
        from backend.app.mesh_diff import align_meshes

        old = _bracket()
        result = align_meshes(old, old.copy(), mode="auto", tolerance=0.05)
        self.assertEqual(result.applied, "identity")
        np.testing.assert_allclose(result.matrix, np.eye(4), atol=1e-12)
        self.assertGreater(result.inlier_ratio, 0.99)
        self.assertEqual(result.warnings, [])

    def test_added_feature_in_same_coordinates_does_not_shift(self):
        import trimesh

        from backend.app.mesh_diff import align_meshes

        old = _bracket()
        new = trimesh.util.concatenate([_bracket(), _boss()])
        result = align_meshes(old, new, mode="auto", tolerance=0.05)
        self.assertEqual(result.applied, "identity")
        np.testing.assert_allclose(result.matrix, np.eye(4), atol=1e-12)

    def test_recovers_translation_and_rotation(self):
        from backend.app.mesh_diff import align_meshes

        old = _bracket()
        moved = old.copy()
        moved.apply_transform(_rotation(35, 15))
        moved.apply_translation([25, -10, 5])
        result = align_meshes(old, moved, mode="auto", tolerance=0.05)
        self.assertEqual(result.applied, "fit")
        restored = moved.copy()
        restored.apply_transform(result.matrix)
        diag = float(np.linalg.norm(old.extents))
        self.assertLess(_max_vertex_error(old, restored), diag * 1e-3)
        self.assertGreater(result.inlier_ratio, 0.95)
        self.assertTrue(any("位置合わせ" in warning for warning in result.warnings))
        self.assertGreater(result.rotation_deg, 10)

    def test_alignment_ignores_changed_region(self):
        import trimesh

        from backend.app.mesh_diff import align_meshes

        old = _bracket()
        new = trimesh.util.concatenate([_bracket(), _boss()])
        transform = trimesh.transformations.translation_matrix([12, 30, -7]) @ _rotation(-50, 20)
        new.apply_transform(transform)
        result = align_meshes(old, new, mode="auto", tolerance=0.05)
        # 共通部分（ブラケット本体）が元位置へ戻ること
        body = _bracket()
        body.apply_transform(transform)
        body.apply_transform(result.matrix)
        diag = float(np.linalg.norm(old.extents))
        self.assertLess(_max_vertex_error(_bracket(), body), diag * 2e-3)

    def test_mode_none_never_moves(self):
        from backend.app.mesh_diff import align_meshes

        old = _bracket()
        moved = old.copy()
        moved.apply_translation([40, 0, 0])
        result = align_meshes(old, moved, mode="none", tolerance=0.05)
        self.assertEqual(result.applied, "identity")
        np.testing.assert_allclose(result.matrix, np.eye(4))
        # 元座標で大きくずれていることを警告する
        self.assertTrue(any("ずれ" in warning for warning in result.warnings))

    def test_mode_centroid_only_translates(self):
        from backend.app.mesh_diff import align_meshes

        old = _bracket()
        moved = old.copy()
        moved.apply_translation([3, -4, 5])
        result = align_meshes(old, moved, mode="centroid", tolerance=0.05)
        self.assertEqual(result.applied, "centroid")
        np.testing.assert_allclose(result.matrix[:3, :3], np.eye(3), atol=1e-12)
        np.testing.assert_allclose(result.matrix[:3, 3], [-3, 4, -5], atol=1e-6)

    def test_invalid_mode_raises(self):
        from backend.app.mesh_diff import align_meshes

        with self.assertRaises(ValueError):
            align_meshes(_bracket(), _bracket(), mode="magic", tolerance=0.05)


class TestScaleMismatchWarning(unittest.TestCase):
    def test_warns_inch_ratio(self):
        from backend.app.mesh_diff import scale_mismatch_warning

        message = scale_mismatch_warning([100, 50, 20], [100 / 25.4, 50 / 25.4, 20 / 25.4])
        self.assertIsNotNone(message)
        self.assertIn("25.4", message)

    def test_warns_metre_ratio(self):
        from backend.app.mesh_diff import scale_mismatch_warning

        self.assertIn("1000", scale_mismatch_warning([0.1, 0.05, 0.02], [100, 50, 20]))

    def test_no_warning_for_similar_size(self):
        from backend.app.mesh_diff import scale_mismatch_warning

        self.assertIsNone(scale_mismatch_warning([100, 50, 20], [110, 50, 20]))


if __name__ == "__main__":
    unittest.main()
