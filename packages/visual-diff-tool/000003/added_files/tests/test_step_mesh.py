"""
3D差分 段階1: STEP→メッシュ変換のテスト。
- samples/step/ に検証用STEPペア（穴位置・寸法・追加形状・位置ズレ・単位違い）が存在すること
- STEPヘッダから元の長さ単位を検出できること
- 新旧に同じテッセレーション精度（線形許容差）が適用されること
- 不正なSTEPは原因が分かる StepConversionError になること
OCP（requirements-3d.txt）が未導入の環境では変換系テストをスキップする。
"""

import importlib.util
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
STEP_SAMPLES_DIR = ROOT / "samples" / "step"
EXPECTED_STEP_PAIRS = ["hole_position", "dimension", "added_boss", "moved_rotated", "moved_rotated_diff", "unit_inch"]
HAS_OCP = importlib.util.find_spec("OCP") is not None and importlib.util.find_spec("trimesh") is not None


class TestStepSamples(unittest.TestCase):
    def test_step_sample_pairs_exist(self):
        for name in EXPECTED_STEP_PAIRS:
            for side in ("a", "b"):
                path = STEP_SAMPLES_DIR / f"{name}_{side}.step"
                self.assertTrue(path.exists(), f"{path} がありません")
                head = path.read_bytes()[:64]
                self.assertIn(b"ISO-10303-21", head)


class TestStepUnitDetection(unittest.TestCase):
    def test_detects_millimetre(self):
        from backend.app.step_mesh import detect_step_unit

        content = b"#10=( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );"
        self.assertEqual(detect_step_unit(content), "mm")

    def test_detects_metre_and_inch(self):
        from backend.app.step_mesh import detect_step_unit

        self.assertEqual(detect_step_unit(b"( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.) )"), "m")
        inch = b"#5=( CONVERSION_BASED_UNIT('INCH',#6) LENGTH_UNIT() NAMED_UNIT(#7) );"
        self.assertEqual(detect_step_unit(inch), "inch")

    def test_unknown_unit_returns_none(self):
        from backend.app.step_mesh import detect_step_unit

        self.assertIsNone(detect_step_unit(b"ISO-10303-21; no unit here"))

    def test_quality_to_deflection_is_relative_to_size(self):
        from backend.app.step_mesh import linear_deflection_for

        standard = linear_deflection_for(100.0, "standard")
        self.assertGreater(linear_deflection_for(100.0, "coarse"), standard)
        self.assertLess(linear_deflection_for(100.0, "fine"), standard)
        self.assertAlmostEqual(linear_deflection_for(200.0, "standard"), standard * 2)
        with self.assertRaises(ValueError):
            linear_deflection_for(100.0, "ultra")


@unittest.skipUnless(HAS_OCP, "requirements-3d.txt が未導入")
class TestStepConversion(unittest.TestCase):
    def test_load_and_tessellate_pair_with_same_deflection(self):
        from backend.app.step_mesh import load_step_pair_as_meshes

        result = load_step_pair_as_meshes(
            STEP_SAMPLES_DIR / "hole_position_a.step",
            STEP_SAMPLES_DIR / "hole_position_b.step",
            quality="standard",
        )
        self.assertGreater(result.linear_deflection, 0)
        for side in (result.old, result.new):
            # 新旧で同じ精度値を使ったことを記録している
            self.assertEqual(side.linear_deflection, result.linear_deflection)
            self.assertEqual(side.vertices.shape[1], 3)
            self.assertEqual(side.faces.shape[1], 3)
            self.assertGreater(len(side.faces), 10)
            self.assertEqual(side.unit, "mm")
            self.assertGreaterEqual(side.solid_count, 1)
        # サンプルの板は 100 x 60 x 10 mm
        extents = result.old.vertices.max(axis=0) - result.old.vertices.min(axis=0)
        np.testing.assert_allclose(sorted(extents), [10, 60, 100], atol=0.05)

    def test_inch_file_is_converted_to_mm_and_warned(self):
        from backend.app.step_mesh import load_step_pair_as_meshes

        result = load_step_pair_as_meshes(
            STEP_SAMPLES_DIR / "unit_inch_a.step",
            STEP_SAMPLES_DIR / "unit_inch_b.step",
            quality="coarse",
        )
        self.assertEqual(result.old.unit, "mm")
        self.assertEqual(result.new.unit, "inch")
        ext_a = result.old.vertices.max(axis=0) - result.old.vertices.min(axis=0)
        ext_b = result.new.vertices.max(axis=0) - result.new.vertices.min(axis=0)
        # OCCTが読み込み時にmmへ換算するため寸法は一致する
        np.testing.assert_allclose(ext_a, ext_b, atol=0.05)
        self.assertTrue(any("単位" in warning for warning in result.warnings))

    def test_explicit_deflection_overrides_quality(self):
        from backend.app.step_mesh import load_step_pair_as_meshes

        result = load_step_pair_as_meshes(
            STEP_SAMPLES_DIR / "dimension_a.step",
            STEP_SAMPLES_DIR / "dimension_b.step",
            quality="standard",
            linear_deflection=0.25,
        )
        self.assertAlmostEqual(result.linear_deflection, 0.25)

    def test_invalid_step_raises_readable_error(self):
        import tempfile

        from backend.app.step_mesh import StepConversionError, load_step_pair_as_meshes

        with tempfile.TemporaryDirectory() as tmp:
            broken = Path(tmp) / "broken.step"
            broken.write_bytes(b"ISO-10303-21;\nHEADER;\nthis is not valid\n")
            with self.assertRaises(StepConversionError) as ctx:
                load_step_pair_as_meshes(broken, STEP_SAMPLES_DIR / "dimension_b.step")
            self.assertIn("旧ファイル", str(ctx.exception))
            self.assertIn("broken.step", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
