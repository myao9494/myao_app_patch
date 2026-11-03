"""
画像の位置合わせ（アライメント）処理仕様。
- 候補は「補正なし → 平行移動 → 相似変換 → ホモグラフィ」の順に単純で、実際に画素を重ねて比べ、
  より複雑な補正は食い違いが明確に減るときだけ採用する。図形が個別に動いた図を歪ませないため。
- 平行移動はインクの相互相関（FFT）で求める。整数pxの移動なら補間で線がぼけない。
- 相似変換とホモグラフィは SIFT / AKAZE / ORB の特徴点から推定し、ECC で微調整する。
  特徴量検出は ThreadPoolExecutor により並列実行する。
- 人が範囲を指定した場合は、その範囲が一致する補正を選ぶ（範囲外の変更には引きずられない）。
  見つからなければ自動補正へ戻し、warning で知らせる。
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

NOT_MOVED_METHOD = "not moved"  # 補正しない方が一致したため元の位置のまま比較した
TRANSLATION_METHOD = "translation"
MISMATCH_LEVEL = 32  # 不一致とみなす輝度差（0〜255）
SIMPLER_MODEL_MARGIN = 0.85  # より複雑な補正は、不一致画素が15%以上減るときだけ採用する
TRANSLATION_SEARCH_SIDE = 1024  # 平行移動の相互相関を計算するときの長辺（px）
ANCHOR_SEARCH_SIDE = 1200  # 指定範囲を探すときの長辺（px）
ANCHOR_MIN_SCORE = 0.5  # 指定範囲が見つかったとみなす相関値
ANCHOR_TIE_SCORE = 0.02  # 同じ形が並ぶとき、この差の候補は元の位置に近い方を選ぶ


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


@dataclass
class _Candidate:
    matrix: np.ndarray
    label: str
    matches: int = 0
    inliers: int = 0


def align_to_reference(
    reference_bgr: np.ndarray,
    candidate_bgr: np.ndarray,
    category: str = "汎用",
    anchor_region: dict | None = None,
    anchor_region_b: dict | None = None,
) -> AlignmentResult:
    anchor_warning = None
    if anchor_region:
        anchored = _align_with_anchor_region(reference_bgr, candidate_bgr, category, anchor_region, anchor_region_b)
        if anchored.success:
            return anchored
        anchor_warning = f"{anchored.warning}。自動で位置合わせしました"

    result = _align_automatically(reference_bgr, candidate_bgr, category)
    if anchor_warning:
        result.warning = anchor_warning if result.success else f"{anchor_warning}（{result.warning}）"
    return result


def _align_automatically(reference_bgr: np.ndarray, candidate_bgr: np.ndarray, category: str) -> AlignmentResult:
    params = CATEGORY_PARAMS.get(category, CATEGORY_PARAMS["汎用"])
    fixed = _prepare_gray(reference_bgr, category)
    moving = _prepare_gray(candidate_bgr, category)

    identity = _Candidate(np.eye(3), NOT_MOVED_METHOD)
    candidates = [identity]
    translation = _dominant_translation(fixed, moving)
    if translation != (0, 0):
        candidates.append(_Candidate(_translation_matrix(*translation), TRANSLATION_METHOD))
    features = _feature_candidates(fixed, moving, reference_bgr.shape[:2], candidate_bgr.shape[:2], params)
    best = _pick_simplest(candidates + features, fixed, moving)

    if best is identity and not features:
        return _failed(candidate_bgr, "共通する特徴を十分に見つけられませんでした")
    # 特徴点の数は採用した補正によらず、一致の目安として表示する
    matches, inliers = max(((item.matches, item.inliers) for item in features), default=(0, 0))
    if best is identity:
        return AlignmentResult(
            image=candidate_bgr,
            reference_image=reference_bgr,
            success=True,
            method=NOT_MOVED_METHOD,
            warning=None,
            matches=matches,
            inliers=inliers,
            matrix=np.eye(3).tolist(),
        )

    method = best.label
    matrix = best.matrix
    if best.label != TRANSLATION_METHOD:
        method = f"{best.label} + robust transform"
        refined_matrix, refined = _refine_with_ecc(fixed, moving, matrix, reference_bgr.shape[:2])
        # 変更部分に引きずられて悪化したECCの結果は捨てる
        if refined and _mismatch_pixels(fixed, moving, refined_matrix) <= _mismatch_pixels(fixed, moving, matrix):
            matrix = refined_matrix
            method += " + ECC refine"

    reference_canvas, aligned = _warp_pair_to_union_canvas(reference_bgr, candidate_bgr, matrix)
    return AlignmentResult(
        image=aligned,
        reference_image=reference_canvas,
        success=True,
        method=method,
        warning=None,
        matches=matches,
        inliers=inliers,
        matrix=matrix.tolist(),
    )


def _feature_candidates(
    fixed: np.ndarray,
    moving: np.ndarray,
    reference_shape: tuple[int, int],
    candidate_shape: tuple[int, int],
    params: dict,
    fixed_region: dict | None = None,
    moving_region: dict | None = None,
) -> list[_Candidate]:
    """特徴点から求めた補正を、相似変換・ホモグラフィの順に返す（種類ごとに最も支持の多いもの）。"""
    region_mode = fixed_region is not None
    min_matches = max(8, params["min_matches"] // 2) if region_mode else params["min_matches"]
    min_inliers = max(5, params["min_matches"] // 3) if region_mode else max(6, params["min_matches"] // 2)
    detector_scale = _detector_scale(reference_shape, candidate_shape)
    fixed_for_features = _resize_for_registration(fixed, detector_scale)
    moving_for_features = _resize_for_registration(moving, detector_scale)
    fixed_mask = _region_mask(fixed_for_features.shape[:2], fixed_region, detector_scale)
    moving_mask = _region_mask(moving_for_features.shape[:2], moving_region, detector_scale)

    attempts = []
    for detector_name, detector_a, detector_b, norm, ratio_scale in _detector_candidates(params["features"]):
        # 画像Aと画像Bの特徴量抽出をスレッド並列で同時実行
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            fut_a = executor.submit(detector_a.detectAndCompute, fixed_for_features, fixed_mask)
            fut_b = executor.submit(detector_b.detectAndCompute, moving_for_features, moving_mask)
            kp_a, des_a = fut_a.result()
            kp_b, des_b = fut_b.result()
        if des_a is None or des_b is None or len(kp_a) < 4 or len(kp_b) < 4:
            continue

        good = _match_descriptors(des_b, des_a, norm, params["ratio"] * ratio_scale)
        if len(good) < min_matches:
            continue

        detector_attempts = []
        src = np.float32([kp_b[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        dst = np.float32([kp_a[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
        for transform_name, matrix, mask in _estimate_transforms(src, dst, params["ransac"]):
            if matrix is None or mask is None:
                continue
            matrix = _scale_matrix_to_full_size(matrix, detector_scale)

            inliers = int(mask.ravel().sum())
            if inliers < min_inliers:
                continue
            if _validate_homography(matrix, reference_shape, candidate_shape):
                continue
            attempt = (transform_name, _Candidate(matrix, f"{detector_name} {transform_name}", len(good), inliers))
            attempts.append(attempt)
            detector_attempts.append(attempt[1])

        if not region_mode and _has_confident_detector_result(detector_attempts, params["min_matches"]):
            break

    best_by_transform = []
    for transform_name in ("similarity", "homography"):
        same_kind = [item for name, item in attempts if name == transform_name]
        if same_kind:
            best_by_transform.append(max(same_kind, key=lambda item: (item.inliers, item.matches)))
    return best_by_transform


def _pick_simplest(
    candidates: list[_Candidate],
    fixed: np.ndarray,
    moving: np.ndarray,
    region: dict | None = None,
) -> _Candidate:
    """単純な順に並んだ候補から、複雑な補正は不一致が明確に減るときだけ選ぶ。

    特徴点の数だけで選ぶと、図形が個別に動いた図でも全体を歪ませる補正が勝ってしまう。
    """
    best = candidates[0]
    best_score = _mismatch_pixels(fixed, moving, best.matrix, region)
    for candidate in candidates[1:]:
        score = _mismatch_pixels(fixed, moving, candidate.matrix, region)
        if score < best_score * SIMPLER_MODEL_MARGIN:
            best, best_score = candidate, score
    return best


def _mismatch_pixels(fixed: np.ndarray, moving: np.ndarray, matrix: np.ndarray, region: dict | None = None) -> int:
    """補正後に画素が食い違う数。region がなければ両画像を含むキャンバス全体で数える。"""
    if region is None:
        canvas, warped = _warp_pair_to_union_canvas(fixed, moving, matrix)
    else:
        canvas, warped = _region_pair(fixed, moving, matrix, region)
    return cv2.countNonZero(cv2.compare(cv2.absdiff(canvas, warped), MISMATCH_LEVEL, cv2.CMP_GT))


def _region_pair(fixed: np.ndarray, moving: np.ndarray, matrix: np.ndarray, region: dict) -> tuple[np.ndarray, np.ndarray]:
    x, y, w, h = region["x"], region["y"], region["width"], region["height"]
    warped = cv2.warpPerspective(moving, _translation_matrix(-x, -y) @ matrix, (w, h), flags=cv2.INTER_LINEAR, borderValue=255)
    return fixed[y : y + h, x : x + w], warped


def _dominant_translation(fixed: np.ndarray, moving: np.ndarray) -> tuple[int, int]:
    """インクが最も多く重なる平行移動量（moving → fixed）を返す。

    一部の図形だけが動いた図では、動いていない多数派の図形が重なる位置に相関の山ができる。
    """
    scale = min(1.0, TRANSLATION_SEARCH_SIDE / max(*fixed.shape[:2], *moving.shape[:2]))
    ink_a = _ink_image(_resize_for_registration(fixed, scale))
    ink_b = _ink_image(_resize_for_registration(moving, scale))
    height = cv2.getOptimalDFTSize(ink_a.shape[0] + ink_b.shape[0])
    width = cv2.getOptimalDFTSize(ink_a.shape[1] + ink_b.shape[1])
    spectrum = np.fft.rfft2(ink_a, (height, width)) * np.conj(np.fft.rfft2(ink_b, (height, width)))
    correlation = np.fft.irfft2(spectrum, (height, width))
    peak_y, peak_x = np.unravel_index(int(np.argmax(correlation)), correlation.shape)
    # FFTの巡回を、負の移動量へ戻す
    dx = peak_x - width if peak_x >= ink_a.shape[1] else peak_x
    dy = peak_y - height if peak_y >= ink_a.shape[0] else peak_y
    if scale >= 1.0:
        return int(dx), int(dy)

    margin = int(np.ceil(2.0 / scale))
    ink_full_a, ink_full_b = _ink_image(fixed), _ink_image(moving)
    return (
        _refine_axis_shift(ink_full_a.sum(axis=0), ink_full_b.sum(axis=0), int(round(dx / scale)), margin),
        _refine_axis_shift(ink_full_a.sum(axis=1), ink_full_b.sum(axis=1), int(round(dy / scale)), margin),
    )


def _ink_image(gray: np.ndarray) -> np.ndarray:
    """背景（最頻に近い中央値）からの輝度差。余白が0になるので相互相関の山がインクで決まる。"""
    return cv2.absdiff(gray, int(np.median(gray[::4, ::4]))).astype(np.float32)


def _refine_axis_shift(profile_a: np.ndarray, profile_b: np.ndarray, coarse: int, margin: int) -> int:
    """縮小画像で求めた移動量を、行・列ごとのインク量の重なりで1px単位へ詰める。"""
    def overlap(shift: int) -> float:
        start = max(0, shift)
        end = min(len(profile_a), len(profile_b) + shift)
        return float(np.dot(profile_a[start:end], profile_b[start - shift : end - shift])) if end > start else 0.0

    return max(range(coarse - margin, coarse + margin + 1), key=overlap)


def _align_with_anchor_region(
    reference_bgr: np.ndarray,
    candidate_bgr: np.ndarray,
    category: str,
    anchor_region: dict,
    anchor_region_b: dict | None = None,
) -> AlignmentResult:
    """人が指定した範囲（Aの座標）が一致するように合わせる。anchor_region_b はBでの大まかな位置。"""
    region = _clip_anchor_region(anchor_region, reference_bgr.shape[:2])
    if region is None:
        return _failed(candidate_bgr, "指定した範囲が画像の外にあるか、小さすぎます")
    search = _clip_anchor_region(anchor_region_b, candidate_bgr.shape[:2]) if anchor_region_b else None

    params = CATEGORY_PARAMS.get(category, CATEGORY_PARAMS["汎用"])
    fixed = _prepare_gray(reference_bgr, category)
    moving = _prepare_gray(candidate_bgr, category)
    template = fixed[region["y"] : region["y"] + region["height"], region["x"] : region["x"] + region["width"]]
    if template.std() < 2.0:
        return _failed(candidate_bgr, "指定した範囲に線や文字がありません")

    candidates = []
    located = _locate_template(moving, template, region, search)
    if located is not None:
        candidates.append(_Candidate(_translation_matrix(region["x"] - located[0], region["y"] - located[1]), "template translation"))
    # 射影は狭い範囲から外挿すると範囲外が大きく歪むので、同じ精度なら平行移動が残る
    candidates += _feature_candidates(
        fixed, moving, reference_bgr.shape[:2], candidate_bgr.shape[:2], params, fixed_region=region, moving_region=search,
    )
    if not candidates:
        return _failed(candidate_bgr, "指定した範囲を比較対象の中で見つけられませんでした")

    best = _pick_simplest(candidates, fixed, moving, region)
    if _region_score(fixed, moving, best.matrix, region) < ANCHOR_MIN_SCORE:
        return _failed(candidate_bgr, "指定した範囲を比較対象の中で見つけられませんでした")

    reference_canvas, aligned = _warp_pair_to_union_canvas(reference_bgr, candidate_bgr, best.matrix)
    return AlignmentResult(
        image=aligned,
        reference_image=reference_canvas,
        success=True,
        method=f"anchor region {best.label}",
        warning=None,
        matches=best.matches,
        inliers=best.inliers,
        matrix=best.matrix.tolist(),
    )


def _locate_template(moving: np.ndarray, template: np.ndarray, region: dict, search: dict | None) -> tuple[int, int] | None:
    """Aの指定範囲が moving のどこにあるかを探し、左上の座標を返す。見つからなければ None。"""
    template_h, template_w = template.shape[:2]
    window = _search_window(moving.shape[:2], template.shape[:2], search)
    if window is None:
        return None
    left, top, right, bottom = window
    area = moving[top:bottom, left:right]

    # 細い範囲でも形が潰れない倍率まで縮小して当たりを付け、等倍の周辺で詰める
    scale = min(1.0, ANCHOR_SEARCH_SIDE / max(area.shape[:2]))
    scale = min(1.0, max(scale, 16.0 / min(template_h, template_w)))
    small_area = _resize_for_registration(area, scale)
    small_template = _resize_for_registration(template, scale)
    if small_area.shape[0] < small_template.shape[0] or small_area.shape[1] < small_template.shape[1]:
        return None
    scores = cv2.matchTemplate(small_area, small_template, cv2.TM_CCOEFF_NORMED)
    best_score = float(np.nanmax(scores))
    if best_score < ANCHOR_MIN_SCORE:
        return None
    # 同じ形が並ぶ図では相関がほぼ同点になるため、元の位置に最も近いものを選ぶ
    expected_x, expected_y = (region["x"], region["y"]) if search is None else (search["x"], search["y"])
    ys, xs = np.nonzero(scores >= best_score - ANCHOR_TIE_SCORE)
    nearest = int(np.argmin((xs / scale + left - expected_x) ** 2 + (ys / scale + top - expected_y) ** 2))
    x = left + int(round(xs[nearest] / scale))
    y = top + int(round(ys[nearest] / scale))
    if scale >= 1.0:
        return x, y

    margin = int(np.ceil(2.0 / scale))
    fine_left = max(0, x - margin)
    fine_top = max(0, y - margin)
    fine_area = moving[fine_top : y + template_h + margin, fine_left : x + template_w + margin]
    if fine_area.shape[0] < template_h or fine_area.shape[1] < template_w:
        return x, y
    _, _, _, location = cv2.minMaxLoc(cv2.matchTemplate(fine_area, template, cv2.TM_CCOEFF_NORMED))
    return fine_left + location[0], fine_top + location[1]


def _search_window(
    moving_shape: tuple[int, int],
    template_shape: tuple[int, int],
    search: dict | None,
) -> tuple[int, int, int, int] | None:
    height, width = moving_shape
    template_h, template_w = template_shape
    if template_h > height or template_w > width:
        return None
    if search is None:
        return 0, 0, width, height
    # 人のドラッグは大まかなので、範囲の周囲も探す
    margin_x = max(template_w, search["width"]) // 4
    margin_y = max(template_h, search["height"]) // 4
    left = max(0, search["x"] - margin_x)
    top = max(0, search["y"] - margin_y)
    right = min(width, max(search["x"] + search["width"], search["x"] + template_w) + margin_x)
    bottom = min(height, max(search["y"] + search["height"], search["y"] + template_h) + margin_y)
    return left, top, right, bottom


def _region_score(fixed: np.ndarray, moving: np.ndarray, matrix: np.ndarray, region: dict) -> float:
    canvas, warped = _region_pair(fixed, moving, matrix, region)
    return float(cv2.matchTemplate(warped, canvas, cv2.TM_CCOEFF_NORMED)[0, 0])


def _region_mask(shape: tuple[int, int], region: dict | None, scale: float) -> np.ndarray | None:
    if region is None:
        return None
    mask = np.zeros(shape, dtype=np.uint8)
    x = int(round(region["x"] * scale))
    y = int(round(region["y"] * scale))
    mask[y : y + max(1, int(round(region["height"] * scale))), x : x + max(1, int(round(region["width"] * scale)))] = 255
    return mask


def _translation_matrix(dx: float, dy: float) -> np.ndarray:
    return np.array([[1.0, 0.0, dx], [0.0, 1.0, dy], [0.0, 0.0, 1.0]])


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


def _has_confident_detector_result(attempts: list[_Candidate], min_matches: int) -> bool:
    if not attempts:
        return False
    best = max(attempts, key=lambda item: (item.inliers, item.matches))
    return best.inliers >= max(80, min_matches * 6) and best.inliers / max(1, best.matches) >= 0.75


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
    # 差分のある画像では相関が頭打ちのまま eps に届かないことがあり、回数の上限まで回り続ける。
    # 30回と80回の補正結果の差は実測で最大0.09px（17MP図面とサンプル15組）なので、上限を30回にして待ち時間を抑える。
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 1e-5)
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

    reference_canvas = np.full((out_h, out_w, *reference_bgr.shape[2:]), 255, dtype=reference_bgr.dtype)
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
        return "補正の計算結果が不正でした"

    area = abs(cv2.contourArea(projected.astype(np.float32)))
    ref_area = float(ref_w * ref_h)
    if area < ref_area * 0.03 or area > ref_area * 8.0:
        return "補正で画像の大きさが変わりすぎます"

    x_min, y_min = projected.min(axis=0)
    x_max, y_max = projected.max(axis=0)
    margin_x = ref_w * 0.75
    margin_y = ref_h * 0.75
    if x_max < -margin_x or y_max < -margin_y or x_min > ref_w + margin_x or y_min > ref_h + margin_y:
        return "補正で画像が基準の範囲外へ移動します"

    top = np.linalg.norm(projected[1] - projected[0])
    bottom = np.linalg.norm(projected[2] - projected[3])
    left = np.linalg.norm(projected[3] - projected[0])
    right = np.linalg.norm(projected[2] - projected[1])
    width_ratio = max(top, bottom) / max(1.0, min(top, bottom))
    height_ratio = max(left, right) / max(1.0, min(left, right))
    if width_ratio > 2.2 or height_ratio > 2.2:
        return "補正の歪みが大きすぎます"

    return None
