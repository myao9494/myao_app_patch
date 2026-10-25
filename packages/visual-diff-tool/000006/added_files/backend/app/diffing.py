"""
位置合わせ後の2画像のピクセル差分。
- YIQ色空間の距離でしきい値判定する（しきい値 0〜1。0.1 が既定）
- 図面の1〜2px の細線差分を消さないよう、マスクへの opening は行わず、3px未満の孤立ノイズだけ除く
- インクの有無で色分けする: 削除（Aだけにある）= 赤、追加（Bだけにある）= 青、両方にある変更 = 黄
"""

from __future__ import annotations

import cv2
import numpy as np

# 差分の種類ごとの強調色（BGR）。オーバーレイでは元画像35%＋強調色65%で合成する。
REMOVED_COLOR = (40, 40, 230)  # 赤: Aだけにあるインク
ADDED_COLOR = (230, 110, 40)  # 青: Bだけにあるインク
CHANGED_COLOR = (40, 190, 255)  # 黄: 両方にインクがある変更

# BGR差分 → YIQ（輝度Y・色差I/Q）への変換行列と、YIQ各成分の重み（pixelmatch と同じ係数）
_YIQ_FROM_BGR = np.array(
    [
        [0.11448223, 0.58662247, 0.29889531],
        [-0.32180189, -0.27417610, 0.59597799],
        [0.31114694, -0.52261711, 0.21147017],
    ],
    dtype=np.float32,
)
_YIQ_WEIGHTS = np.array([[0.5053, 0.299, 0.1957]], dtype=np.float32)


def resize_to_match(reference_bgr: np.ndarray, candidate_bgr: np.ndarray) -> np.ndarray:
    h = max(reference_bgr.shape[0], candidate_bgr.shape[0])
    w = max(reference_bgr.shape[1], candidate_bgr.shape[1])
    if candidate_bgr.shape[:2] == (h, w):
        return candidate_bgr
    canvas = np.full((h, w, 3), 255, dtype=candidate_bgr.dtype)
    src_h, src_w = candidate_bgr.shape[:2]
    canvas[:src_h, :src_w] = candidate_bgr
    return canvas


def build_visual_diff(reference_bgr: np.ndarray, aligned_bgr: np.ndarray, threshold: float = 0.1) -> dict:
    reference_bgr = resize_to_match(aligned_bgr, reference_bgr)
    aligned_bgr = resize_to_match(reference_bgr, aligned_bgr)
    threshold = float(np.clip(threshold, 0.0, 1.0))
    delta = _yiq_delta(reference_bgr, aligned_bgr)
    max_delta = 35215.0 * threshold * threshold
    mask = cv2.compare(delta, max_delta, cv2.CMP_GT)  # 255 / 0 の uint8
    mask = _remove_small_components(mask, min_pixels=3)
    kernel = np.ones((3, 3), np.uint8)
    mask = cv2.dilate(mask, kernel, iterations=1)

    gray_a = cv2.cvtColor(reference_bgr, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(aligned_bgr, cv2.COLOR_BGR2GRAY)
    ink_a = cv2.inRange(gray_a, 0, 245)
    ink_b = cv2.inRange(gray_b, 0, 245)
    removed = cv2.bitwise_and(mask, cv2.bitwise_and(ink_a, cv2.bitwise_not(ink_b)))
    added = cv2.bitwise_and(mask, cv2.bitwise_and(ink_b, cv2.bitwise_not(ink_a)))
    changed = cv2.bitwise_and(mask, cv2.bitwise_and(ink_a, ink_b))

    overlay = _blend_highlights(reference_bgr, ((removed, REMOVED_COLOR), (added, ADDED_COLOR), (changed, CHANGED_COLOR)))

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    rects = []
    for contour in contours:
        area = int(cv2.contourArea(contour))
        if area < 20:
            continue
        x, y, w, h = cv2.boundingRect(contour)
        rects.append({"x": int(x), "y": int(y), "width": int(w), "height": int(h), "area": area})
        cv2.rectangle(overlay, (x, y), (x + w, y + h), (0, 80, 255), 2)

    diff_pixels = int(np.count_nonzero(mask))
    total = int(mask.shape[0] * mask.shape[1])
    return {
        "overlay": overlay,
        "mask": mask,
        "rects": sorted(rects, key=lambda item: item["area"], reverse=True),
        "diff_pixels": diff_pixels,
        "diff_ratio": diff_pixels / total if total else 0.0,
        "threshold": threshold,
    }


def _remove_small_components(mask: np.ndarray, min_pixels: int) -> np.ndarray:
    """面積が min_pixels 未満の連結成分（孤立ノイズ）を除去する。

    成分ごとに画像全体を比較すると「成分数 × 画素数」の計算量になり、文字の多い書類では
    数秒かかるため、残す成分の表を作ってラベル画像から一度に引く。
    """
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if component_count <= 1:
        return mask
    keep = stats[:, cv2.CC_STAT_AREA] >= min_pixels
    keep[0] = False  # ラベル0は背景
    return np.where(keep[labels], 255, 0).astype(mask.dtype)


def _blend_highlights(reference_bgr: np.ndarray, highlights) -> np.ndarray:
    """差分の種類ごとのマスク位置を強調色と合成したオーバーレイを返す。

    3種類のマスクは互いに重ならないため、強調色を1枚に塗り分けてから1回だけ合成し、
    マスクのある画素だけ書き戻す（全画面の合成・np.where を種類ごとに繰り返さない）。
    """
    overlay = reference_bgr.copy()
    colors = np.zeros_like(reference_bgr)
    union = np.zeros(reference_bgr.shape[:2], dtype=np.uint8)
    for mask, color in highlights:
        cv2.bitwise_or(union, mask, dst=union)
        cv2.copyTo(np.full_like(reference_bgr, color), mask, colors)
    if not cv2.countNonZero(union):
        return overlay
    blended = cv2.addWeighted(reference_bgr, 0.35, colors, 0.65, 0)
    cv2.copyTo(blended, union, overlay)
    return overlay


def _yiq_delta(image_a_bgr: np.ndarray, image_b_bgr: np.ndarray) -> np.ndarray:
    """画素ごとの色差（YIQ空間の重み付き二乗距離）。OpenCVの行列変換で一括計算する。"""
    diff = cv2.subtract(image_a_bgr, image_b_bgr, dtype=cv2.CV_32F)
    yiq = cv2.transform(diff, _YIQ_FROM_BGR)
    return cv2.transform(cv2.multiply(yiq, yiq), _YIQ_WEIGHTS)
