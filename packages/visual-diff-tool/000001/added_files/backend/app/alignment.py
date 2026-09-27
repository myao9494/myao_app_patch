"""
画像の位置合わせ（アライメント）処理仕様。
SIFT / AKAZE / ORB 特徴量検出とホモグラフィ／アフィン変換行列の推定、
および ECC による微調整を行う。特徴量検出は ThreadPoolExecutor により並列実行する。
"""

from __future__ import annotations

import concurrent.futures
from dataclasses import dataclass

import cv2
import numpy as np


CATEGORY_PARAMS = {
    "汎用": {"features": 7000, "ratio": 0.74, "min_matches": 12, "ransac": 3.0},
    "図面": {"features": 10000, "ratio": 0.78, "min_matches": 14, "ransac": 2.5},
    "グラフ": {"features": 8000, "ratio": 0.76, "min_matches": 12, "ransac": 3.0},
    "書類": {"features": 9000, "ratio": 0.74, "min_matches": 10, "ransac": 2.5},
}


@dataclass
class AlignmentResult:
    image: np.ndarray
    reference_image: np.ndarray | None
    success: bool
    method: str
    warning: str | None
    matches: int
    inliers: int
    matrix: list[list[float]] | None


def align_to_reference(
    reference_bgr: np.ndarray,
    candidate_bgr: np.ndarray,
    category: str = "汎用",
    anchor_region: dict | None = None,
) -> AlignmentResult:
    if anchor_region:
        anchored = _align_with_anchor_region(reference_bgr, candidate_bgr, category, anchor_region)
        if anchored.success:
            return anchored

    params = CATEGORY_PARAMS.get(category, CATEGORY_PARAMS["汎用"])
    fixed = _prepare_gray(reference_bgr, category)
    moving = _prepare_gray(candidate_bgr, category)
    detector_scale = _detector_scale(reference_bgr.shape[:2], candidate_bgr.shape[:2])
    fixed_for_features = _resize_for_registration(fixed, detector_scale)
    moving_for_features = _resize_for_registration(moving, detector_scale)

    attempts = []
    for detector_name, detector_a, detector_b, norm, ratio_scale in _detector_candidates(params["features"]):
        # 画像Aと画像Bの特徴量抽出をスレッド並列で同時実行
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            fut_a = executor.submit(detector_a.detectAndCompute, fixed_for_features, None)
            fut_b = executor.submit(detector_b.detectAndCompute, moving_for_features, None)
            kp_a, des_a = fut_a.result()
            kp_b, des_b = fut_b.result()
        if des_a is None or des_b is None or len(kp_a) < 4 or len(kp_b) < 4:
            continue

        good = _match_descriptors(des_b, des_a, norm, params["ratio"] * ratio_scale)
        if len(good) < params["min_matches"]:
            continue

        detector_attempts = []
        src = np.float32([kp_b[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        dst = np.float32([kp_a[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
        for transform_name, matrix, mask in _estimate_transforms(src, dst, params["ransac"]):
            if matrix is None or mask is None:
                continue
            matrix = _scale_matrix_to_full_size(matrix, detector_scale)

            inliers = int(mask.ravel().sum())
            if inliers < max(6, params["min_matches"] // 2):
                continue
            warning = _validate_homography(matrix, reference_bgr.shape[:2], candidate_bgr.shape[:2])
            if warning:
                continue
            attempt = (inliers, len(good), f"{detector_name} {transform_name}", matrix)
            attempts.append(attempt)
            detector_attempts.append(attempt)

        if _has_confident_detector_result(detector_attempts, params["min_matches"]):
            break

    if not attempts:
        return _failed(candidate_bgr, "Could not estimate a stable feature transform")

    inliers, matches, transform_label, matrix = max(attempts, key=lambda item: (item[0], item[1]))
    matrix, refined = _refine_with_ecc(fixed, moving, matrix, reference_bgr.shape[:2])

    reference_canvas, aligned = _warp_pair_to_union_canvas(reference_bgr, candidate_bgr, matrix)
    return AlignmentResult(
        image=aligned,
        reference_image=reference_canvas,
        success=True,
        method=f"{transform_label} + robust transform" + (" + ECC refine" if refined else ""),
        warning=None,
        matches=matches,
        inliers=inliers,
        matrix=matrix.tolist(),
    )


def _align_with_anchor_region(
    reference_bgr: np.ndarray,
    candidate_bgr: np.ndarray,
    category: str,
    anchor_region: dict,
) -> AlignmentResult:
    region = _clip_anchor_region(anchor_region, reference_bgr.shape[:2])
    if region is None:
        return _failed(candidate_bgr, "Selected anchor region is outside the reference image")

    params = CATEGORY_PARAMS.get(category, CATEGORY_PARAMS["汎用"])
    fixed = _prepare_gray(reference_bgr, category)
    moving = _prepare_gray(candidate_bgr, category)
    detector_scale = _detector_scale(reference_bgr.shape[:2], candidate_bgr.shape[:2])
    fixed_for_features = _resize_for_registration(fixed, detector_scale)
    moving_for_features = _resize_for_registration(moving, detector_scale)
    mask = np.zeros(fixed_for_features.shape[:2], dtype=np.uint8)
    scaled_region = {
        "x": int(round(region["x"] * detector_scale)),
        "y": int(round(region["y"] * detector_scale)),
        "width": max(1, int(round(region["width"] * detector_scale))),
        "height": max(1, int(round(region["height"] * detector_scale))),
    }
    mask[
        scaled_region["y"] : scaled_region["y"] + scaled_region["height"],
        scaled_region["x"] : scaled_region["x"] + scaled_region["width"],
    ] = 255

    attempts = []
    for detector_name, detector_a, detector_b, norm, ratio_scale in _detector_candidates(params["features"]):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            fut_a = executor.submit(detector_a.detectAndCompute, fixed_for_features, mask)
            fut_b = executor.submit(detector_b.detectAndCompute, moving_for_features, None)
            kp_a, des_a = fut_a.result()
            kp_b, des_b = fut_b.result()
        if des_a is None or des_b is None or len(kp_a) < 4 or len(kp_b) < 4:
            continue

        good = _match_descriptors(des_b, des_a, norm, params["ratio"] * ratio_scale)
        if len(good) < max(8, params["min_matches"] // 2):
            continue

        src = np.float32([kp_b[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        dst = np.float32([kp_a[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
        for transform_name, matrix, result_mask in _estimate_transforms(src, dst, params["ransac"]):
            if matrix is None or result_mask is None:
                continue
            matrix = _scale_matrix_to_full_size(matrix, detector_scale)

            inliers = int(result_mask.ravel().sum())
            if inliers < max(5, params["min_matches"] // 3):
                continue
            warning = _validate_homography(matrix, reference_bgr.shape[:2], candidate_bgr.shape[:2])
            if warning:
                continue
            attempts.append((inliers, len(good), f"anchor region {detector_name} {transform_name}", matrix))

    if attempts:
        inliers, matches, transform_label, matrix = max(attempts, key=lambda item: (item[0], item[1]))
        matrix, refined = _refine_with_ecc(fixed, moving, matrix, reference_bgr.shape[:2])
        reference_canvas, aligned = _warp_pair_to_union_canvas(reference_bgr, candidate_bgr, matrix)
        return AlignmentResult(
            image=aligned,
            reference_image=reference_canvas,
            success=True,
            method=f"{transform_label} + robust transform" + (" + ECC refine" if refined else ""),
            warning=None,
            matches=matches,
            inliers=inliers,
            matrix=matrix.tolist(),
        )

    return _template_anchor_fallback(reference_bgr, candidate_bgr, fixed, moving, region)


def _template_anchor_fallback(
    reference_bgr: np.ndarray,
    candidate_bgr: np.ndarray,
    fixed: np.ndarray,
    moving: np.ndarray,
    region: dict,
) -> AlignmentResult:
    x, y, w, h = region["x"], region["y"], region["width"], region["height"]
    template = fixed[y : y + h, x : x + w]
    if template.size == 0 or template.shape[0] < 16 or template.shape[1] < 16:
        return _failed(candidate_bgr, "Selected anchor region is too small for matching")

    max_template_side = 700.0
    shrink = min(1.0, max_template_side / max(template.shape[:2]))
    if shrink < 1.0:
        template = cv2.resize(
            template,
            (max(16, int(template.shape[1] * shrink)), max(16, int(template.shape[0] * shrink))),
            interpolation=cv2.INTER_AREA,
        )

    moving_edges = cv2.Canny(moving, 60, 160)
    best: tuple[float, int, int, int, int] | None = None
    for scale in (0.9, 0.95, 1.0, 1.05, 1.1):
        scaled_w = int(template.shape[1] * scale)
        scaled_h = int(template.shape[0] * scale)
        if scaled_w < 16 or scaled_h < 16 or scaled_w > moving.shape[1] or scaled_h > moving.shape[0]:
            continue
        scaled = cv2.resize(template, (scaled_w, scaled_h), interpolation=cv2.INTER_AREA)
        scaled_edges = cv2.Canny(scaled, 60, 160)
        try:
            result = cv2.matchTemplate(moving_edges, scaled_edges, cv2.TM_CCOEFF_NORMED)
        except cv2.error:
            continue
        _, score, _, location = cv2.minMaxLoc(result)
        if best is None or score > best[0]:
            best = (float(score), int(location[0]), int(location[1]), scaled_w, scaled_h)

    if best is None or best[0] < 0.2:
        return _failed(candidate_bgr, "Could not match the selected anchor region")

    _, match_x, match_y, match_w, match_h = best
    ref_center_x = x + w / 2.0
    ref_center_y = y + h / 2.0
    cand_center_x = match_x + match_w / 2.0
    cand_center_y = match_y + match_h / 2.0
    matrix = np.array([[1.0, 0.0, ref_center_x - cand_center_x], [0.0, 1.0, ref_center_y - cand_center_y], [0.0, 0.0, 1.0]])
    reference_canvas, aligned = _warp_pair_to_union_canvas(reference_bgr, candidate_bgr, matrix)
    return AlignmentResult(
        image=aligned,
        reference_image=reference_canvas,
        success=True,
        method="anchor region template translation",
        warning=None,
        matches=1,
        inliers=1,
        matrix=matrix.tolist(),
    )


def _detector_candidates(features: int):
    if hasattr(cv2, "SIFT_create"):
        yield (
            "SIFT",
            cv2.SIFT_create(nfeatures=features, contrastThreshold=0.025, edgeThreshold=12),
            cv2.SIFT_create(nfeatures=features, contrastThreshold=0.025, edgeThreshold=12),
            cv2.NORM_L2,
            1.0,
        )
    if hasattr(cv2, "AKAZE_create"):
        yield (
            "AKAZE",
            cv2.AKAZE_create(threshold=0.0006),
            cv2.AKAZE_create(threshold=0.0006),
            cv2.NORM_HAMMING,
            1.05,
        )
    if hasattr(cv2, "ORB_create"):
        yield (
            "ORB",
            cv2.ORB_create(nfeatures=features, fastThreshold=5, scoreType=cv2.ORB_HARRIS_SCORE),
            cv2.ORB_create(nfeatures=features, fastThreshold=5, scoreType=cv2.ORB_HARRIS_SCORE),
            cv2.NORM_HAMMING,
            1.08,
        )


def _has_confident_detector_result(attempts: list[tuple[int, int, str, np.ndarray]], min_matches: int) -> bool:
    if not attempts:
        return False
    inliers, matches, _, _ = max(attempts, key=lambda item: (item[0], item[1]))
    return inliers >= max(80, min_matches * 6) and inliers / max(1, matches) >= 0.75


def _match_descriptors(des_moving: np.ndarray, des_fixed: np.ndarray, norm: int, ratio: float):
    matcher = cv2.BFMatcher(norm)
    knn = matcher.knnMatch(des_moving, des_fixed, k=2)
    good = []
    for pair in knn:
        if len(pair) < 2:
            continue
        first, second = pair
        if first.distance < ratio * second.distance:
            good.append(first)
    return good


def _estimate_transforms(src: np.ndarray, dst: np.ndarray, ransac_threshold: float):
    method = getattr(cv2, "USAC_MAGSAC", cv2.RANSAC)
    try:
        matrix, mask = cv2.findHomography(src, dst, method, ransac_threshold, maxIters=4000, confidence=0.999)
    except cv2.error:
        try:
            matrix, mask = cv2.findHomography(src, dst, cv2.RANSAC, ransac_threshold)
        except cv2.error:
            matrix, mask = None, None
    yield "homography", matrix, mask

    try:
        affine, affine_mask = cv2.estimateAffinePartial2D(
            src,
            dst,
            method=cv2.RANSAC,
            ransacReprojThreshold=ransac_threshold,
            maxIters=4000,
            confidence=0.995,
            refineIters=20,
        )
    except cv2.error:
        affine, affine_mask = None, None
    if affine is not None:
        matrix = np.vstack([affine, [0.0, 0.0, 1.0]]).astype(np.float64)
        yield "similarity", matrix, affine_mask


def _refine_with_ecc(fixed: np.ndarray, moving: np.ndarray, matrix: np.ndarray, reference_shape: tuple[int, int]):
    ref_h, ref_w = reference_shape
    scale = min(1.0, 1200.0 / max(ref_h, ref_w))
    fixed_small = _resize_for_registration(fixed, scale)
    moving_small = _resize_for_registration(moving, scale)
    scale_matrix = np.array([[scale, 0, 0], [0, scale, 0], [0, 0, 1]], dtype=np.float32)
    try:
        inverse_matrix = np.linalg.inv(matrix)
    except np.linalg.LinAlgError:
        return matrix, False
    warp = (scale_matrix @ inverse_matrix @ np.linalg.inv(scale_matrix)).astype(np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 80, 1e-5)
    try:
        _, refined = cv2.findTransformECC(
            fixed_small,
            moving_small,
            warp,
            cv2.MOTION_HOMOGRAPHY,
            criteria,
            inputMask=None,
            gaussFiltSize=3,
        )
    except cv2.error:
        return matrix, False

    try:
        refined_full = np.linalg.inv(np.linalg.inv(scale_matrix) @ refined @ scale_matrix)
    except np.linalg.LinAlgError:
        return matrix, False
    warning = _validate_homography(refined_full, reference_shape, moving.shape[:2])
    if warning:
        return matrix, False
    return refined_full.astype(np.float64), True


def _resize_for_registration(image: np.ndarray, scale: float) -> np.ndarray:
    if scale >= 1.0:
        return image
    h, w = image.shape[:2]
    resized = cv2.resize(image, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
    return resized


def _detector_scale(reference_shape: tuple[int, int], candidate_shape: tuple[int, int]) -> float:
    max_side = max(reference_shape[0], reference_shape[1], candidate_shape[0], candidate_shape[1])
    return min(1.0, 1600.0 / max(1, max_side))


def _scale_matrix_to_full_size(matrix: np.ndarray, scale: float) -> np.ndarray:
    if scale >= 1.0:
        return matrix
    scale_matrix = np.array([[scale, 0, 0], [0, scale, 0], [0, 0, 1]], dtype=np.float64)
    return np.linalg.inv(scale_matrix) @ matrix @ scale_matrix


def _prepare_gray(image: np.ndarray, category: str) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    if category in {"図面", "書類"}:
        gray = cv2.equalizeHist(gray)
        gray = cv2.GaussianBlur(gray, (3, 3), 0)
    elif category == "グラフ":
        gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    return gray


def _failed(image: np.ndarray, warning: str, matches: int = 0, inliers: int = 0) -> AlignmentResult:
    return AlignmentResult(
        image=image,
        reference_image=None,
        success=False,
        method="none",
        warning=warning,
        matches=matches,
        inliers=inliers,
        matrix=None,
    )


def _warp_pair_to_union_canvas(
    reference_bgr: np.ndarray,
    candidate_bgr: np.ndarray,
    matrix: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    ref_h, ref_w = reference_bgr.shape[:2]
    cand_h, cand_w = candidate_bgr.shape[:2]
    ref_corners = np.float32([[0, 0], [ref_w, 0], [ref_w, ref_h], [0, ref_h]]).reshape(-1, 1, 2)
    cand_corners = np.float32([[0, 0], [cand_w, 0], [cand_w, cand_h], [0, cand_h]]).reshape(-1, 1, 2)
    projected = cv2.perspectiveTransform(cand_corners, matrix)
    all_corners = np.vstack([ref_corners, projected]).reshape(-1, 2)

    min_xy = np.floor(all_corners.min(axis=0)).astype(int)
    max_xy = np.ceil(all_corners.max(axis=0)).astype(int)
    out_w = max(1, int(max_xy[0] - min_xy[0]))
    out_h = max(1, int(max_xy[1] - min_xy[1]))
    translation = np.array([[1.0, 0.0, -min_xy[0]], [0.0, 1.0, -min_xy[1]], [0.0, 0.0, 1.0]])

    reference_canvas = np.full((out_h, out_w, 3), 255, dtype=reference_bgr.dtype)
    x = int(-min_xy[0])
    y = int(-min_xy[1])
    reference_canvas[y : y + ref_h, x : x + ref_w] = reference_bgr
    aligned = cv2.warpPerspective(
        candidate_bgr,
        translation @ matrix,
        (out_w, out_h),
        flags=cv2.INTER_LINEAR,
        borderValue=(255, 255, 255),
    )
    return reference_canvas, aligned


def _clip_anchor_region(region: dict, reference_shape: tuple[int, int]) -> dict | None:
    ref_h, ref_w = reference_shape
    try:
        x = int(round(float(region["x"])))
        y = int(round(float(region["y"])))
        width = int(round(float(region["width"])))
        height = int(round(float(region["height"])))
    except (KeyError, TypeError, ValueError):
        return None

    x1 = max(0, min(ref_w - 1, x))
    y1 = max(0, min(ref_h - 1, y))
    x2 = max(x1 + 1, min(ref_w, x + max(1, width)))
    y2 = max(y1 + 1, min(ref_h, y + max(1, height)))
    if x2 - x1 < 16 or y2 - y1 < 16:
        return None
    return {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1}


def _validate_homography(matrix: np.ndarray, reference_shape: tuple[int, int], candidate_shape: tuple[int, int]) -> str | None:
    ref_h, ref_w = reference_shape
    mov_h, mov_w = candidate_shape
    corners = np.float32([[0, 0], [mov_w, 0], [mov_w, mov_h], [0, mov_h]]).reshape(-1, 1, 2)
    projected = cv2.perspectiveTransform(corners, matrix).reshape(-1, 2)
    if not np.isfinite(projected).all():
        return "Estimated transform contains invalid coordinates"

    area = abs(cv2.contourArea(projected.astype(np.float32)))
    ref_area = float(ref_w * ref_h)
    if area < ref_area * 0.03 or area > ref_area * 8.0:
        return "Estimated transform changes image area too much"

    x_min, y_min = projected.min(axis=0)
    x_max, y_max = projected.max(axis=0)
    margin_x = ref_w * 0.75
    margin_y = ref_h * 0.75
    if x_max < -margin_x or y_max < -margin_y or x_min > ref_w + margin_x or y_min > ref_h + margin_y:
        return "Estimated transform moves image outside the reference canvas"

    top = np.linalg.norm(projected[1] - projected[0])
    bottom = np.linalg.norm(projected[2] - projected[3])
    left = np.linalg.norm(projected[3] - projected[0])
    right = np.linalg.norm(projected[2] - projected[1])
    width_ratio = max(top, bottom) / max(1.0, min(top, bottom))
    height_ratio = max(left, right) / max(1.0, min(left, right))
    if width_ratio > 2.2 or height_ratio > 2.2:
        return "Estimated transform perspective skew is too strong"

    return None
