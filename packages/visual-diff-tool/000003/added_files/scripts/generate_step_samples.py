"""
3D差分（STEP比較）の動作確認用サンプルSTEPペアを生成するスクリプト。
OCP（cadquery-ocp-novtk）で単品部品を作り、samples/step/<名前>_a.step（旧版）/ _b.step（新版）へ保存する。

生成するペア:
- hole_position : 板 100x60x10 の穴(φ12)の位置が x=30 → x=60 に移動
- dimension     : ブロックの長さが 80 → 90 に変更
- added_boss    : 板の上面に円柱ボス(φ20 x 15)を追加
- moved_rotated : 同一形状のL字ブラケットを回転(Z35°, X15°)＋平行移動（位置合わせの検証用）
- unit_inch     : 同一形状の段付き軸。新版だけ長さ単位をINCHで保存（単位警告の検証用）

実行: .venv/bin/python scripts/generate_step_samples.py
"""

from __future__ import annotations

import math
from pathlib import Path

from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCP.gp import gp_Ax1, gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "samples" / "step"


def box(x: float, y: float, z: float, dx: float, dy: float, dz: float):
    return BRepPrimAPI_MakeBox(gp_Pnt(x, y, z), dx, dy, dz).Shape()


def cylinder(x: float, y: float, z: float, radius: float, height: float):
    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(x, y, z), gp_Dir(0, 0, 1)), radius, height).Shape()


def cut(a, b):
    return BRepAlgoAPI_Cut(a, b).Shape()


def fuse(a, b):
    return BRepAlgoAPI_Fuse(a, b).Shape()


def transformed(shape, rot_z_deg: float, rot_x_deg: float, translation: tuple[float, float, float]):
    rz = gp_Trsf()
    rz.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), math.radians(rot_z_deg))
    rx = gp_Trsf()
    rx.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(1, 0, 0)), math.radians(rot_x_deg))
    tr = gp_Trsf()
    tr.SetTranslation(gp_Vec(*translation))
    # 適用順: Z回転 → X回転 → 平行移動
    total = tr.Multiplied(rx.Multiplied(rz))
    return BRepBuilderAPI_Transform(shape, total, True).Shape()


def write_step(shape, path: Path, unit: str = "MM") -> None:
    Interface_Static.SetCVal_s("write.step.unit", unit)
    try:
        writer = STEPControl_Writer()
        writer.Transfer(shape, STEPControl_AsIs)
        status = writer.Write(str(path))
        if status != IFSelect_RetDone:
            raise RuntimeError(f"STEP書き出しに失敗しました: {path}")
    finally:
        Interface_Static.SetCVal_s("write.step.unit", "MM")


def plate_with_hole(hole_x: float):
    return cut(box(0, 0, 0, 100, 60, 10), cylinder(hole_x, 30, -1, 6, 12))


def block(length: float):
    return cut(box(0, 0, 0, length, 40, 20), cylinder(20, 20, -1, 5, 22))


def l_bracket():
    base = box(0, 0, 0, 60, 40, 8)
    wall = box(0, 0, 0, 8, 40, 50)
    bracket = fuse(base, wall)
    return cut(bracket, cylinder(40, 20, -1, 5, 10))


def l_bracket_with_wall_hole(hole_radius: float = 6.0):
    bracket = l_bracket()
    # 縦壁(x=0..8, y=0..40, z=0..50)の中央にX方向の貫通穴を開ける
    wall_cylinder = BRepPrimAPI_MakeCylinder(
        gp_Ax2(gp_Pnt(-1, 20, 25), gp_Dir(1, 0, 0)), hole_radius, 10
    ).Shape()
    return cut(bracket, wall_cylinder)


def stepped_shaft():
    return fuse(cylinder(0, 0, 0, 15, 40), cylinder(0, 0, 40, 10, 30))


def build_pairs() -> dict[str, tuple]:
    plate = box(0, 0, 0, 80, 60, 10)
    bracket = l_bracket()
    shaft = stepped_shaft()
    return {
        "hole_position": (plate_with_hole(30), plate_with_hole(60), "MM"),
        "dimension": (block(80), block(90), "MM"),
        "added_boss": (plate, fuse(plate, cylinder(40, 30, 10, 10, 15)), "MM"),
        "moved_rotated": (bracket, transformed(bracket, 35, 15, (25, -10, 5)), "MM"),
        "moved_rotated_diff": (bracket, transformed(l_bracket_with_wall_hole(6.0), 35, 15, (25, -10, 5)), "MM"),
        "unit_inch": (shaft, shaft, "INCH"),
    }


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, (shape_a, shape_b, unit_b) in build_pairs().items():
        write_step(shape_a, OUTPUT_DIR / f"{name}_a.step")
        write_step(shape_b, OUTPUT_DIR / f"{name}_b.step", unit=unit_b)
        print(f"generated: {name}_a.step / {name}_b.step")


if __name__ == "__main__":
    main()
