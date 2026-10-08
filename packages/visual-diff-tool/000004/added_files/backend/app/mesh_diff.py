"""
3Dメッシュ差分の中核ロジック（位置合わせ・細分化・距離算出・バイナリ入出力）。
- 位置合わせ（新メッシュを旧メッシュの座標系へ移す4x4行列を求める）:
  - auto    : 元座標で一致率が高ければ動かさない。低ければ fit を実施し、良くなった場合のみ採用
  - none    : 動かさない（大きくずれていれば警告）
  - centroid: 面積重心を合わせる平行移動のみ
  - fit     : 面積重心＋慣性主軸の24通りの姿勢候補 → トリム付きICP（変更部分の影響を除外）
- 細分化（refine_mesh）: 辺長上限（max_edge）を超える三角形を分割し、解像度を確保（新旧並行処理）
- 差分算出（compute_mesh_diff / parallel_closest_point）:
  - 頂点群のチャンク分割によるマルチコア並列距離計算
  - 新旧メッシュの距離計算の同時並行実行
- バイナリ形式（VDM1）: メッシュ座標・面インデックス・頂点距離をWebフロントエンドと高速にやり取り
trimesh / scipy / rtree に依存する（requirements-3d.txt）。
"""

from __future__ import annotations

import itertools
import json
import math
import os
import struct
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

ALIGN_MODES = ("auto", "none", "centroid", "fit")
IDENTITY_ACCEPT_RATIO = 0.6  # 元座標の一致率がこれ以上なら「同じ座標系で作られた版違い」とみなす
SCORE_SAMPLES = 3000
PCA_SAMPLES = 20000
COARSE_SAMPLES = 1500
COARSE_ITERATIONS = 15
FINE_ITERATIONS = 60
TRIM_PERCENTILE = 85.0
SCALE_FACTORS = (25.4, 304.8, 1000.0, 100.0, 10.0)


@dataclass
class AlignmentResult:
    matrix: np.ndarray  # 新メッシュへ適用する4x4変換
    applied: str  # identity / centroid / fit
    inlier_ratio: float
    rms: float
    identity_inlier_ratio: float
    translation: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    rotation_deg: float = 0.0
    warnings: list[str] = field(default_factory=list)


@dataclass
class DiffMeshSide:
    vertices: np.ndarray  # (N, 3) float64 または float32
    faces: np.ndarray  # (M, 3) int64 または uint32
    distances: np.ndarray  # (N,) float64 または float32


@dataclass
class MeshDiffResult:
    old: DiffMeshSide
    new: DiffMeshSide
    alignment: AlignmentResult
    tolerance: float
    warnings: list[str] = field(default_factory=list)


def scale_mismatch_warning(reference_extents, moving_extents) -> str | None:
    """寸法比が単位換算係数に近ければ警告文を返す。"""
    ref = float(np.linalg.norm(reference_extents))
    mov = float(np.linalg.norm(moving_extents))
    if ref <= 0 or mov <= 0:
        return None
    ratio = max(ref, mov) / min(ref, mov)
    for factor in SCALE_FACTORS:
        if abs(math.log(ratio) - math.log(factor)) < math.log(1.05):
            return (
                f"新旧の寸法比が約{factor:g}倍です。長さ単位の不一致（mm / inch / m など）の可能性があります。"
                "スケールは自動補正していません。"
            )
    return None


def area_centroid(mesh) -> np.ndarray:
    """三角形の面積で重み付けした表面重心（水密でないメッシュでも定義できる）。"""
    areas = np.asarray(mesh.area_faces)
    total = float(areas.sum())
    if total <= 0:
        return np.asarray(mesh.vertices).mean(axis=0)
    return (np.asarray(mesh.triangles_center) * areas[:, None]).sum(axis=0) / total


def align_meshes(reference, moving, *, mode: str = "auto", tolerance: float) -> AlignmentResult:
    """moving（新）を reference（旧）へ重ねる変換を求める。"""
    if mode not in ALIGN_MODES:
        raise ValueError(f"未知の位置合わせモードです: {mode}（{' / '.join(ALIGN_MODES)}）")
    diag = float(max(np.linalg.norm(reference.extents), np.linalg.norm(moving.extents), 1e-9))
    inlier_tol = max(3.0 * float(tolerance), diag * 0.002)
    warnings: list[str] = []

    identity = np.eye(4)
    identity_ratio, identity_rms = _symmetric_score(reference, moving, identity, inlier_tol)

    if mode == "none":
        if identity_ratio < IDENTITY_ACCEPT_RATIO:
            warnings.append(
                f"元座標のままでは形状が大きくずれています（一致率 {identity_ratio:.0%}）。"
                "位置合わせモード「自動」を検討してください。"
            )
        return AlignmentResult(identity, "identity", identity_ratio, identity_rms, identity_ratio, warnings=warnings)

    if mode == "auto" and identity_ratio >= IDENTITY_ACCEPT_RATIO:
        return AlignmentResult(identity, "identity", identity_ratio, identity_rms, identity_ratio)

    if mode == "centroid":
        matrix = np.eye(4)
        matrix[:3, 3] = area_centroid(reference) - area_centroid(moving)
        applied = "centroid"
    else:
        matrix = _fit_transform(reference, moving, inlier_tol)
        applied = "fit"

    ratio, rms = _symmetric_score(reference, moving, matrix, inlier_tol)
    if mode == "auto" and ratio <= identity_ratio:
        warnings.append(f"自動位置合わせで一致率が改善しなかったため、元座標のまま比較します（一致率 {identity_ratio:.0%}）。")
        return AlignmentResult(identity, "identity", identity_ratio, identity_rms, identity_ratio, warnings=warnings)

    translation = [float(v) for v in matrix[:3, 3]]
    rotation_deg = _rotation_angle_deg(matrix[:3, :3])
    warnings.append(
        "原点または向きが異なるため、新版を自動で位置合わせしました"
        f"（平行移動 {translation[0]:.3f}, {translation[1]:.3f}, {translation[2]:.3f} mm / 回転 {rotation_deg:.2f}°、"
        f"一致率 {ratio:.0%}）。"
    )
    if ratio < IDENTITY_ACCEPT_RATIO:
        warnings.append(f"位置合わせ後も一致率が低いです（{ratio:.0%}）。形状が大きく異なるか、位置合わせに失敗した可能性があります。")
    return AlignmentResult(matrix, applied, ratio, rms, identity_ratio, translation, rotation_deg, warnings)


def _samples(mesh, count: int) -> np.ndarray:
    import trimesh

    points, _ = trimesh.sample.sample_surface(mesh, count, seed=0)
    return np.asarray(points, dtype=np.float64)


def _transform_points(points: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    return points @ matrix[:3, :3].T + matrix[:3, 3]


def _surface_distance(mesh, points: np.ndarray) -> np.ndarray:
    import trimesh

    _, distance, _ = trimesh.proximity.closest_point(mesh, points)
    return np.asarray(distance, dtype=np.float64)


def _symmetric_score(reference, moving, matrix: np.ndarray, inlier_tol: float) -> tuple[float, float]:
    """双方向の一致率と、一致点のRMS距離を返す。"""
    moving_points = _transform_points(_samples(moving, SCORE_SAMPLES), matrix)
    forward = _surface_distance(reference, moving_points)
    inverse = np.linalg.inv(matrix)
    reference_points = _transform_points(_samples(reference, SCORE_SAMPLES), inverse)
    backward = _surface_distance(moving, reference_points)
    distances = np.concatenate([forward, backward])
    inliers = distances <= inlier_tol
    ratio = float(inliers.mean())
    rms = float(np.sqrt(np.mean(distances[inliers] ** 2))) if inliers.any() else float("inf")
    return ratio, rms


def _kabsch(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    """source を target へ重ねる剛体変換（4x4）を最小二乗で求める。"""
    source_center = source.mean(axis=0)
    target_center = target.mean(axis=0)
    h = (source - source_center).T @ (target - target_center)
    u, _, vt = np.linalg.svd(h)
    d = np.sign(np.linalg.det(vt.T @ u.T)) or 1.0
    rotation = vt.T @ np.diag([1.0, 1.0, d]) @ u.T
    matrix = np.eye(4)
    matrix[:3, :3] = rotation
    matrix[:3, 3] = target_center - rotation @ source_center
    return matrix


def _rotation_angle_deg(rotation: np.ndarray) -> float:
    cos_angle = (np.trace(rotation) - 1.0) / 2.0
    return float(math.degrees(math.acos(min(1.0, max(-1.0, cos_angle)))))


def _signed_permutations() -> list[np.ndarray]:
    """行列式+1の符号付き置換行列（立方体の回転群、24通り）。"""
    matrices = []
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product((1.0, -1.0), repeat=3):
            matrix = np.zeros((3, 3))
            for row, col in enumerate(perm):
                matrix[row, col] = signs[row]
            if np.linalg.det(matrix) > 0:
                matrices.append(matrix)
    return matrices


def _principal_axes(points: np.ndarray, center: np.ndarray) -> np.ndarray:
    centered = points - center
    _, vectors = np.linalg.eigh(centered.T @ centered)
    axes = vectors[:, ::-1]  # 分散の大きい順
    if np.linalg.det(axes) < 0:
        axes[:, 2] *= -1
    return axes


def _trimmed_icp(source: np.ndarray, matrix: np.ndarray, nearest, iterations: int) -> tuple[np.ndarray, float]:
    """トリム付きICP。nearest(points) は (対応点, 距離) を返す。距離上位の対応は除外する。"""
    score = float("inf")
    for _ in range(iterations):
        moved = _transform_points(source, matrix)
        targets, distances = nearest(moved)
        keep = distances <= np.percentile(distances, TRIM_PERCENTILE)
        if keep.sum() < 6:
            break
        step = _kabsch(moved[keep], targets[keep])
        matrix = step @ matrix
        score = float(np.mean(distances[keep]))
        if np.linalg.norm(step[:3, 3]) < 1e-9 and _rotation_angle_deg(step[:3, :3]) < 1e-7:
            break
    return matrix, score


def _fit_transform(reference, moving, inlier_tol: float) -> np.ndarray:
    import trimesh
    from scipy.spatial import cKDTree

    reference_dense = _samples(reference, PCA_SAMPLES)
    moving_dense = _samples(moving, PCA_SAMPLES)
    reference_center = area_centroid(reference)
    moving_center = area_centroid(moving)
    reference_axes = _principal_axes(reference_dense, reference_center)
    moving_axes = _principal_axes(moving_dense, moving_center)

    tree = cKDTree(reference_dense)

    def coarse_nearest(points: np.ndarray):
        distances, indices = tree.query(points)
        return reference_dense[indices], distances

    coarse_source = moving_dense[:: max(1, PCA_SAMPLES // COARSE_SAMPLES)]
    best_matrix, best_score = np.eye(4), float("inf")
    # 主軸の向き（符号・順序）は形状だけでは一意に決まらないため24通りを試す
    for permutation in _signed_permutations():
        rotation = reference_axes @ permutation @ moving_axes.T
        candidate = np.eye(4)
        candidate[:3, :3] = rotation
        candidate[:3, 3] = reference_center - rotation @ moving_center
        candidate, score = _trimmed_icp(coarse_source, candidate, coarse_nearest, COARSE_ITERATIONS)
        if score < best_score:
            best_matrix, best_score = candidate, score

    # 仕上げ: 参照メッシュ表面上の厳密な最近傍点で収束させる
    fine_source = _samples(moving, SCORE_SAMPLES)

    def exact_nearest(points: np.ndarray):
        closest, distances, _ = trimesh.proximity.closest_point(reference, points)
        return np.asarray(closest), np.asarray(distances)

    matrix, _ = _trimmed_icp(fine_source, best_matrix, exact_nearest, FINE_ITERATIONS)
    return matrix


def refine_mesh(
    vertices: np.ndarray,
    faces: np.ndarray,
    *,
    max_edge: float,
    max_vertices: int = 1_000_000,
    max_iter: int = 25,
) -> tuple[np.ndarray, np.ndarray]:
    """辺長が max_edge を超える三角形を分割し、解像度を向上させる。"""
    import trimesh

    vertices = np.array(vertices, dtype=np.float64, copy=True)
    faces = np.array(faces, dtype=np.int64, copy=True)

    for _ in range(max_iter):
        edges = np.sort(trimesh.remesh.faces_to_edges(faces), axis=1)
        unique, inverse = trimesh.grouping.unique_rows(edges)
        edges_unique = edges[unique]
        lengths = np.linalg.norm(
            vertices[edges_unique[:, 0], :3] - vertices[edges_unique[:, 1], :3], axis=1
        )
        long_edge = lengths > max_edge
        if not long_edge.any():
            break
        num_new = int(long_edge.sum())
        if len(vertices) + num_new > max_vertices:
            break

        midpoint = np.full(len(unique), -1, dtype=np.int64)
        midpoint[long_edge] = np.arange(num_new) + len(vertices)
        vertices = np.vstack((vertices, vertices[edges_unique[long_edge]].mean(axis=1)))

        face_mid = midpoint[inverse].reshape((-1, 3))
        split = face_mid >= 0
        count = split.sum(axis=1)

        keep = count == 0
        faces_keep = faces[keep]

        one = count == 1
        j = np.argmax(split[one], axis=1)
        r = np.arange(len(j))
        f1, mid1 = faces[one], face_mid[one]
        a, b, c = f1[r, j], f1[r, (j + 1) % 3], f1[r, (j + 2) % 3]
        p = mid1[r, j]
        faces_one = np.column_stack((a, p, c, p, b, c)).reshape((-1, 3))

        two = count == 2
        j = (np.argmin(split[two], axis=1) + 1) % 3
        r = np.arange(len(j))
        f2, mid2 = faces[two], face_mid[two]
        a, b, c = f2[r, j], f2[r, (j + 1) % 3], f2[r, (j + 2) % 3]
        p, q = mid2[r, j], mid2[r, (j + 1) % 3]
        use_aq = (
            ((vertices[a, :3] - vertices[q, :3]) ** 2).sum(axis=1)
            <= ((vertices[p, :3] - vertices[c, :3]) ** 2).sum(axis=1)
        )[:, None]
        corner = np.column_stack((p, b, q))
        quad_a = np.where(use_aq, np.column_stack((a, p, q)), np.column_stack((a, p, c)))
        quad_b = np.where(use_aq, np.column_stack((a, q, c)), np.column_stack((p, q, c)))
        faces_two = np.vstack((corner, quad_a, quad_b))

        three = count == 3
        f3, mid3 = faces[three], face_mid[three]
        v0, v1, v2 = f3.T
        m0, m1, m2 = mid3.T
        faces_three = np.column_stack(
            (v0, m0, m2, m0, v1, m1, m2, m1, v2, m0, m1, m2)
        ).reshape((-1, 3))

        faces = np.vstack((faces_keep, faces_one, faces_two, faces_three)).astype(np.int64)

    return vertices, faces


DIFF_EDGE_RATIOS = {"coarse": 0.03, "standard": 0.015, "fine": 0.008}


def parallel_closest_point(
    mesh,
    points: np.ndarray,
    *,
    max_workers: int | None = None,
    min_chunk_size: int = 1000,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """点群からメッシュ表面への最近傍点・最短距離・面インデックスをマルチコア並列で計算する。
    各スレッドに独立したメッシュインスタンスを渡すことで、libspatialindexのCポインタ競合を回避する。
    """
    import trimesh

    points = np.asarray(points, dtype=np.float64)
    n_points = len(points)
    if n_points == 0:
        return np.empty((0, 3)), np.empty(0), np.empty(0, dtype=np.int64)

    cpu_count = os.cpu_count() or 4
    workers = max_workers or min(cpu_count, 8)

    # 点数が少ないかワーカーが1以下の場合は直接実行してオーバーヘッドを回避
    if n_points <= min_chunk_size or workers <= 1:
        closest, distances, triangle_ids = trimesh.proximity.closest_point(mesh, points)
        return np.asarray(closest), np.asarray(distances), np.asarray(triangle_ids)

    n_chunks = min(workers, max(1, n_points // min_chunk_size))
    chunks = np.array_split(points, n_chunks)
    # スレッドごとの独立インスタンス（process=Falseで軽量コピー）
    mesh_copies = [trimesh.Trimesh(vertices=mesh.vertices, faces=mesh.faces, process=False) for _ in range(n_chunks)]

    def _query(args):
        m, chunk_pts = args
        c, d, t = trimesh.proximity.closest_point(m, chunk_pts)
        return np.asarray(c), np.asarray(d), np.asarray(t)

    with ThreadPoolExecutor(max_workers=n_chunks) as executor:
        results = list(executor.map(_query, zip(mesh_copies, chunks)))

    closest_all = np.vstack([r[0] for r in results])
    dist_all = np.concatenate([r[1] for r in results])
    tri_all = np.concatenate([r[2] for r in results])
    return closest_all, dist_all, tri_all


def compute_mesh_diff(
    old_vertices: np.ndarray,
    old_faces: np.ndarray,
    new_vertices: np.ndarray,
    new_faces: np.ndarray,
    *,
    tolerance: float = 0.05,
    align_mode: str = "auto",
    quality: str = "standard",
    max_edge: float | None = None,
    max_vertices: int = 1_000_000,
    progress: Callable[[str, float], None] | None = None,
) -> MeshDiffResult:
    """旧メッシュと新メッシュを位置合わせし、相手表面までの最短距離を計算する。"""
    import trimesh

    report = progress or (lambda stage, val: None)
    warnings: list[str] = []

    old_mesh_raw = trimesh.Trimesh(vertices=old_vertices, faces=old_faces, process=False)
    new_mesh_raw = trimesh.Trimesh(vertices=new_vertices, faces=new_faces, process=False)

    scale_warning = scale_mismatch_warning(old_mesh_raw.extents, new_mesh_raw.extents)
    if scale_warning:
        warnings.append(scale_warning)

    report("位置合わせの計算中", 0.15)
    alignment = align_meshes(old_mesh_raw, new_mesh_raw, mode=align_mode, tolerance=tolerance)
    warnings.extend(alignment.warnings)

    new_vertices_aligned = _transform_points(new_vertices, alignment.matrix)

    diag = float(max(np.linalg.norm(old_mesh_raw.extents), np.linalg.norm(new_mesh_raw.extents), 1e-9))
    if max_edge is not None:
        target_max_edge = float(max_edge)
    else:
        edge_ratio = DIFF_EDGE_RATIOS.get(quality, 0.015)
        target_max_edge = max(diag * edge_ratio, 1e-3)

    if target_max_edge > 0:
        report("メッシュの細分化中", 0.35)
        # 新旧メッシュの細分化を並行実行
        with ThreadPoolExecutor(max_workers=2) as executor:
            fut_old = executor.submit(
                refine_mesh, old_vertices, old_faces, max_edge=target_max_edge, max_vertices=max_vertices
            )
            fut_new = executor.submit(
                refine_mesh, new_vertices_aligned, new_faces, max_edge=target_max_edge, max_vertices=max_vertices
            )
            old_v_refined, old_f_refined = fut_old.result()
            new_v_refined, new_f_refined = fut_new.result()
    else:
        old_v_refined, old_f_refined = old_vertices, old_faces
        new_v_refined, new_f_refined = new_vertices_aligned, new_faces

    # 相手メッシュへの最近傍距離計算（マルチコア並列化）
    old_mesh_for_dist = trimesh.Trimesh(vertices=old_vertices, faces=old_faces, process=False)
    new_mesh_for_dist = trimesh.Trimesh(vertices=new_vertices_aligned, faces=new_faces, process=False)

    report("旧メッシュの距離を計算中", 0.65)
    # 新旧それぞれの距離計算を並行実行（各内部でも頂点チャンク並列化）
    workers_per_side = max(1, (os.cpu_count() or 4) // 2)
    with ThreadPoolExecutor(max_workers=2) as executor:
        fut_old_dist = executor.submit(parallel_closest_point, new_mesh_for_dist, old_v_refined, max_workers=workers_per_side)
        fut_new_dist = executor.submit(parallel_closest_point, old_mesh_for_dist, new_v_refined, max_workers=workers_per_side)
        _, old_distances, _ = fut_old_dist.result()
        report("新メッシュの距離を計算中", 0.85)
        _, new_distances, _ = fut_new_dist.result()

    report("差分計算完了", 1.0)

    old_side = DiffMeshSide(
        vertices=np.asarray(old_v_refined, dtype=np.float64),
        faces=np.asarray(old_f_refined, dtype=np.int64),
        distances=np.asarray(old_distances, dtype=np.float64),
    )
    new_side = DiffMeshSide(
        vertices=np.asarray(new_v_refined, dtype=np.float64),
        faces=np.asarray(new_f_refined, dtype=np.int64),
        distances=np.asarray(new_distances, dtype=np.float64),
    )

    return MeshDiffResult(
        old=old_side,
        new=new_side,
        alignment=alignment,
        tolerance=tolerance,
        warnings=warnings,
    )


def pack_mesh_binary(
    vertices: np.ndarray,
    faces: np.ndarray,
    distances: np.ndarray,
    meta: dict | None = None,
) -> bytes:
    """メッシュデータ（頂点、面、頂点距離）をVDM1バイナリ形式にパックする。"""
    vertices = np.ascontiguousarray(vertices, dtype=np.float32).reshape(-1, 3)
    faces = np.ascontiguousarray(faces, dtype=np.uint32).reshape(-1, 3)
    distances = np.ascontiguousarray(distances, dtype=np.float32).reshape(-1)

    header = dict(meta or {})
    header["vertex_count"] = int(len(vertices))
    header["face_count"] = int(len(faces))

    json_bytes = json.dumps(header, ensure_ascii=False).encode("utf-8")
    json_len = len(json_bytes)
    pad_len = (4 - (json_len % 4)) % 4

    header_block = struct.pack("<4sI", b"VDM1", json_len) + json_bytes + (b"\x00" * pad_len)
    pos_bytes = vertices.tobytes()
    idx_bytes = faces.tobytes()
    dist_bytes = distances.tobytes()

    return header_block + pos_bytes + idx_bytes + dist_bytes


def unpack_mesh_binary(data: bytes) -> dict:
    """VDM1バイナリ形式からメッシュデータを復元する。"""
    if len(data) < 8 or data[:4] != b"VDM1":
        raise ValueError("有効なVDM1バイナリ形式ではありません。")
    magic, json_len = struct.unpack_from("<4sI", data, 0)
    json_bytes = data[8 : 8 + json_len]
    header = json.loads(json_bytes.decode("utf-8"))
    pad_len = (4 - (json_len % 4)) % 4
    offset = 8 + json_len + pad_len

    v_count = header["vertex_count"]
    f_count = header["face_count"]

    pos_size = v_count * 3 * 4
    positions = np.frombuffer(data[offset : offset + pos_size], dtype=np.float32).reshape(-1, 3)
    offset += pos_size

    idx_size = f_count * 3 * 4
    indices = np.frombuffer(data[offset : offset + idx_size], dtype=np.uint32).reshape(-1, 3)
    offset += idx_size

    dist_size = v_count * 4
    distances = np.frombuffer(data[offset : offset + dist_size], dtype=np.float32)

    return {
        "header": header,
        "positions": positions,
        "indices": indices,
        "distances": distances,
    }
