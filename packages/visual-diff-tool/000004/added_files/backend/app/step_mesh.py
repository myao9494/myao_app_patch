"""
STEPファイルを三角形メッシュへ変換するモジュール（3D差分 段階1）。
- OCP（OpenCASCADE）の STEPControl_Reader で読み込み、OCCTの設定によりmmへ換算する
- STEPヘッダの GLOBAL_UNIT_ASSIGNED_CONTEXT などから元の長さ単位を検出し、新旧で違えば警告する
- 新旧2ファイルに同じ線形許容差（テッセレーション精度）を適用する（精度が違うと同じ形状でも差分が出るため）
- 新旧STEPの読み込みおよびメッシュ化（テッセレーション）をThreadPoolExecutorで並行実行し高速化
- 失敗時は「旧ファイル(名前): 原因」の形式の StepConversionError を送出する
OCPは重いため、このモジュールは3D差分の処理内（子プロセス）でのみimportする。
"""

from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

# 品質プリセット: 線形許容差 = 2モデルのバウンディングボックス対角長(最大) × 比率
QUALITY_RATIOS = {"coarse": 0.002, "standard": 0.001, "fine": 0.0004}
DEFAULT_ANGULAR_DEFLECTION = 0.26  # rad（約15°）。曲面の分割細かさの上限
MIN_LINEAR_DEFLECTION = 1e-4  # mm

ProgressCallback = Callable[[str, float], None]

_SI_PREFIX_UNITS = {
    b"$": "m",
    b".MILLI.": "mm",
    b".CENTI.": "cm",
    b".DECI.": "dm",
    b".MICRO.": "um",
    b".KILO.": "km",
}
_SI_LENGTH_RE = re.compile(rb"SI_UNIT\s*\(\s*(\$|\.[A-Z]+\.)\s*,\s*\.METRE\.\s*\)")
_CONVERSION_RE = re.compile(rb"CONVERSION_BASED_UNIT\s*\(\s*'([^']*)'")
_GLOBAL_UNIT_RE = re.compile(rb"GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(\s*\(([^)]*)\)")


class StepConversionError(Exception):
    """STEPの読み込み・メッシュ化に失敗したことを表す（メッセージはUIにそのまま表示する）。"""


@dataclass
class StepMesh:
    filename: str
    vertices: np.ndarray  # (N, 3) float64, mm
    faces: np.ndarray  # (M, 3) int64
    unit: str | None  # STEPに記録された元の長さ単位（"mm", "inch" など）
    solid_count: int
    linear_deflection: float
    bbox_diagonal: float


@dataclass
class StepPairMeshes:
    old: StepMesh
    new: StepMesh
    linear_deflection: float
    angular_deflection: float
    warnings: list[str] = field(default_factory=list)


@dataclass
class StepSingleMeshResult:
    mesh: StepMesh
    linear_deflection: float
    angular_deflection: float
    warnings: list[str] = field(default_factory=list)


def linear_deflection_for(diagonal: float, quality: str) -> float:
    """モデル寸法と品質プリセットから線形許容差(mm)を求める。"""
    if quality not in QUALITY_RATIOS:
        raise ValueError(f"未知のメッシュ品質です: {quality}（coarse / standard / fine のいずれか）")
    return max(float(diagonal) * QUALITY_RATIOS[quality], MIN_LINEAR_DEFLECTION)


def detect_step_unit(content: bytes) -> str | None:
    """STEPの内容から長さ単位を判定する。判定できなければ None。"""
    # 1. 製品コンテキストが参照する単位エンティティを優先する（変換単位の基準SI単位を誤検出しないため）
    for match in _GLOBAL_UNIT_RE.finditer(content):
        for ref in re.findall(rb"#(\d+)", match.group(1)):
            entity = re.search(rb"#" + ref + rb"\s*=\s*([^;]*);", content)
            if entity and b"LENGTH_UNIT" in entity.group(1):
                unit = _unit_from_entity(entity.group(1))
                if unit:
                    return unit
    # 2. フォールバック: LENGTH_UNIT を含むエンティティを探す（変換単位を優先）
    entities = [m.group(0) for m in re.finditer(rb"[^;]*LENGTH_UNIT[^;]*", content)]
    for entity in entities:
        if _CONVERSION_RE.search(entity):
            return _unit_from_entity(entity)
    for entity in entities:
        unit = _unit_from_entity(entity)
        if unit:
            return unit
    return None


def _unit_from_entity(entity: bytes) -> str | None:
    conversion = _CONVERSION_RE.search(entity)
    if conversion:
        name = conversion.group(1).decode("ascii", "ignore").strip().lower()
        if "inch" in name:
            return "inch"
        if "foot" in name or "feet" in name:
            return "ft"
        return name or None
    si = _SI_LENGTH_RE.search(entity)
    if si:
        return _SI_PREFIX_UNITS.get(si.group(1), si.group(1).decode("ascii", "ignore").strip(".").lower())
    return None


def load_step_pair_as_meshes(
    old_path: str | Path,
    new_path: str | Path,
    *,
    quality: str = "standard",
    linear_deflection: float | None = None,
    angular_deflection: float = DEFAULT_ANGULAR_DEFLECTION,
    progress: ProgressCallback | None = None,
    old_label: str | None = None,
    new_label: str | None = None,
) -> StepPairMeshes:
    """新旧STEPを読み込み、同じ精度でメッシュ化する。"""
    report = progress or (lambda stage, fraction: None)
    old_path, new_path = Path(old_path), Path(new_path)
    old_name = old_label or old_path.name
    new_name = new_label or new_path.name

    report("STEPファイルを読み込み中", 0.0)
    try:
        from OCP.Interface import Interface_Static

        Interface_Static.SetCVal_s("xstep.cascade.unit", "MM")
    except Exception:
        pass

    with ThreadPoolExecutor(max_workers=2) as executor:
        old_read_fut = executor.submit(_read_step, old_path, f"旧ファイル({old_name})")
        new_read_fut = executor.submit(_read_step, new_path, f"新ファイル({new_name})")
        old_shape, old_unit, old_solids = old_read_fut.result()
        new_shape, new_unit, new_solids = new_read_fut.result()

    report("STEP読み込み完了", 0.4)

    old_diag = _bbox_diagonal(old_shape)
    new_diag = _bbox_diagonal(new_shape)
    if linear_deflection is not None:
        if not linear_deflection > 0:
            raise StepConversionError("メッシュ精度(mm)には正の値を指定してください。")
        deflection = float(linear_deflection)
    else:
        # 新旧どちらにも同じ値を使う（大きい方の寸法基準）
        deflection = linear_deflection_for(max(old_diag, new_diag), quality)

    report("形状をメッシュ化中", 0.5)
    with ThreadPoolExecutor(max_workers=2) as executor:
        old_tess_fut = executor.submit(
            _tessellate, old_shape, deflection, angular_deflection, f"旧ファイル({old_name})"
        )
        new_tess_fut = executor.submit(
            _tessellate, new_shape, deflection, angular_deflection, f"新ファイル({new_name})"
        )
        old_vertices, old_faces, old_missing = old_tess_fut.result()
        new_vertices, new_faces, new_missing = new_tess_fut.result()

    old_mesh = StepMesh(old_name, old_vertices, old_faces, old_unit, old_solids, deflection, old_diag)
    new_mesh = StepMesh(new_name, new_vertices, new_faces, new_unit, new_solids, deflection, new_diag)
    warnings = _conversion_warnings(old_mesh, new_mesh, old_missing, new_missing)
    report("メッシュ化完了", 1.0)
    return StepPairMeshes(old_mesh, new_mesh, deflection, angular_deflection, warnings)


def load_step_single_as_mesh(
    step_path: Path | str,
    *,
    quality: str = "standard",
    linear_deflection: float | None = None,
    angular_deflection: float = DEFAULT_ANGULAR_DEFLECTION,
    progress: ProgressCallback | None = None,
    label: str | None = None,
) -> StepSingleMeshResult:
    """単一のSTEPファイルを読み込み、メッシュ化する（新規追加・削除プレビュー用）。"""
    report = progress or (lambda stage, fraction: None)
    path = Path(step_path)
    name = label or path.name

    report("STEPファイルを読み込み中", 0.0)
    try:
        from OCP.Interface import Interface_Static

        Interface_Static.SetCVal_s("xstep.cascade.unit", "MM")
    except Exception:
        pass

    shape, unit, solids = _read_step(path, f"モデル({name})")
    report("STEP読み込み完了", 0.4)

    diag = _bbox_diagonal(shape)
    if linear_deflection is not None:
        if not linear_deflection > 0:
            raise StepConversionError("メッシュ精度(mm)には正の値を指定してください。")
        deflection = float(linear_deflection)
    else:
        deflection = linear_deflection_for(diag, quality)

    report("形状をメッシュ化中", 0.5)
    vertices, faces, missing = _tessellate(shape, deflection, angular_deflection, f"モデル({name})")

    mesh = StepMesh(name, vertices, faces, unit, solids, deflection, diag)
    warnings: list[str] = []
    if not unit:
        warnings.append("ファイルの長さ単位をSTEPから判定できませんでした（mmとして扱います）。")
    if solids == 0:
        warnings.append("ファイルにソリッドがありません（面のみ）。")
    elif solids > 1:
        warnings.append(f"ファイルは{solids}個のソリッドを含みます。1つのメッシュとして表示します。")
    if missing:
        warnings.append(f"ファイルの{missing}面はメッシュ化できなかったため除外しました。")

    report("メッシュ化完了", 1.0)
    return StepSingleMeshResult(mesh, deflection, angular_deflection, warnings)


def _conversion_warnings(old: StepMesh, new: StepMesh, old_missing: int, new_missing: int) -> list[str]:
    warnings: list[str] = []
    if old.unit and new.unit and old.unit != new.unit:
        warnings.append(f"長さ単位が異なります（旧: {old.unit} / 新: {new.unit}）。読み込み時にmmへ換算して比較します。")
    for label, mesh, missing in (("旧", old, old_missing), ("新", new, new_missing)):
        if not mesh.unit:
            warnings.append(f"{label}ファイルの長さ単位をSTEPから判定できませんでした（mmとして扱います）。")
        if mesh.solid_count == 0:
            warnings.append(f"{label}ファイルにソリッドがありません（面のみ）。面同士の距離で比較します。")
        elif mesh.solid_count > 1:
            warnings.append(f"{label}ファイルは{mesh.solid_count}個のソリッドを含みます。1つのメッシュとして比較します（アセンブリは主対象外）。")
        if missing:
            warnings.append(f"{label}ファイルの{missing}面はメッシュ化できなかったため除外しました。")
    return warnings


def _read_step(path: Path, label: str):
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_Reader
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID

    try:
        content = path.read_bytes()
    except OSError as exc:
        raise StepConversionError(f"{label}: ファイルを読み込めません（{exc}）") from exc
    if b"ISO-10303-21" not in content[:1024]:
        raise StepConversionError(f"{label}: STEPファイル（ISO-10303-21）ではありません。")
    unit = detect_step_unit(content)
    del content

    # 読み込み結果を常にmmへ換算させる
    Interface_Static.SetCVal_s("xstep.cascade.unit", "MM")
    reader = STEPControl_Reader()
    try:
        status = reader.ReadFile(str(path))
    except Exception as exc:  # OCCT内部例外
        raise StepConversionError(f"{label}: STEPの解析中にエラーが発生しました（{exc}）") from exc
    if status != IFSelect_RetDone:
        raise StepConversionError(f"{label}: STEPファイルとして読み込めませんでした（構文エラーまたは非対応の形式）。")
    try:
        reader.TransferRoots()
        shape = reader.OneShape()
    except Exception as exc:
        raise StepConversionError(f"{label}: 形状データへの変換に失敗しました（{exc}）") from exc
    if shape is None or shape.IsNull() or _count(shape, TopAbs_FACE) == 0:
        raise StepConversionError(f"{label}: 形状（面）が含まれていません。図面・PMIのみのSTEPは比較できません。")
    return shape, unit, _count(shape, TopAbs_SOLID)


def _count(shape, kind) -> int:
    from OCP.TopExp import TopExp_Explorer

    explorer = TopExp_Explorer(shape, kind)
    count = 0
    while explorer.More():
        count += 1
        explorer.Next()
    return count


def _bbox_diagonal(shape) -> float:
    from OCP.BRepBndLib import BRepBndLib
    from OCP.Bnd import Bnd_Box

    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    if box.IsVoid():
        return 0.0
    # OCP 8 では Bnd_Box.Get() の戻り値型が未登録のため角点から求める
    low, high = box.CornerMin(), box.CornerMax()
    return float(np.linalg.norm([high.X() - low.X(), high.Y() - low.Y(), high.Z() - low.Z()]))


def _tessellate(shape, linear: float, angular: float, label: str):
    """全フェイスを三角形化し、(頂点, 面, メッシュ化できなかった面数) を返す。"""
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS

    try:
        # 絶対値の線形許容差（isRelative=False）、並列メッシュ化
        BRepMesh_IncrementalMesh(shape, linear, False, angular, True)
    except Exception as exc:
        raise StepConversionError(f"{label}: メッシュ化に失敗しました（{exc}）") from exc

    vertex_blocks: list[np.ndarray] = []
    face_blocks: list[np.ndarray] = []
    offset = 0
    missing = 0
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    # OCP 7系は静的メソッドに "_s" が付き、8系では名前空間関数になっている
    to_face = getattr(TopoDS, "Face_s", None) or TopoDS.Face
    triangulation_of = getattr(BRep_Tool, "Triangulation_s", None) or BRep_Tool.Triangulation
    while explorer.More():
        face = to_face(explorer.Current())
        explorer.Next()
        location = TopLoc_Location()
        triangulation = triangulation_of(face, location)
        if triangulation is None or triangulation.NbTriangles() == 0:
            missing += 1
            continue
        trsf = location.Transformation()
        nodes = np.empty((triangulation.NbNodes(), 3), dtype=np.float64)
        for index in range(1, triangulation.NbNodes() + 1):
            point = triangulation.Node(index).Transformed(trsf)
            nodes[index - 1] = (point.X(), point.Y(), point.Z())
        triangles = np.empty((triangulation.NbTriangles(), 3), dtype=np.int64)
        for index in range(1, triangulation.NbTriangles() + 1):
            triangle = triangulation.Triangle(index)
            triangles[index - 1] = (triangle.Value(1), triangle.Value(2), triangle.Value(3))
        if face.Orientation() == TopAbs_REVERSED:
            triangles = triangles[:, [0, 2, 1]]  # 法線を外向きに揃える
        vertex_blocks.append(nodes)
        face_blocks.append(triangles - 1 + offset)
        offset += len(nodes)

    if not face_blocks:
        raise StepConversionError(f"{label}: メッシュ化できる面がありませんでした。")
    vertices, faces = _weld(np.vstack(vertex_blocks), np.vstack(face_blocks))
    return vertices, faces, missing


def _weld(vertices: np.ndarray, faces: np.ndarray):
    """フェイス境界で重複する頂点を統合する（距離計算・細分化の効率化のため）。"""
    import trimesh

    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=True, validate=False)
    return np.asarray(mesh.vertices, dtype=np.float64), np.asarray(mesh.faces, dtype=np.int64)
