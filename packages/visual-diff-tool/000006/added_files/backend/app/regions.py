"""
位置合わせの基準領域（アンカー）候補の抽出。
図面の外枠・罫線で囲まれた枠・大きな矩形・線の密集領域を候補として返し、UIで選んだ領域を
/api/diff の anchor_region に渡すと、その範囲の特徴点を優先して位置合わせする。
"""

from __future__ import annotations

import cv2
import numpy as np

# 枠線候補を作るときに調べる「横線の組 × 縦線の組」の上限
MAX_FRAME_CANDIDATES = 200_000


def suggest_anchor_regions(image_bgr: np.ndarray, limit: int = 8) -> list[dict]:
    h, w = image_bgr.shape[:2]
    if h <= 0 or w <= 0:
        return []

    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    ink_mask = np.where((gray < 245) | (hsv[:, :, 1] > 35), 255, 0).astype(np.uint8)
    close_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    ink_mask = cv2.morphologyEx(ink_mask, cv2.MORPH_CLOSE, close_kernel)

    regions: list[dict] = []
    content = _bbox_from_mask(ink_mask, w, h, padding=6)
    if content:
        regions.append({**content, "label": "全体枠候補", "score": 0.9})

    edge_mask = cv2.Canny(gray, 60, 160)
    edge_mask = cv2.dilate(edge_mask, np.ones((3, 3), np.uint8), iterations=1)
    regions.extend(_line_frame_regions(gray, w, h))
    regions.extend(_large_rectangular_regions(edge_mask, w, h))
    regions.extend(_dense_detail_regions(edge_mask, w, h))

    return _dedupe_regions(regions, w, h, limit)


def _bbox_from_mask(mask: np.ndarray, image_w: int, image_h: int, padding: int) -> dict | None:
    points = cv2.findNonZero(mask)
    if points is None:
        return None
    x, y, w, h = cv2.boundingRect(points)
    area_ratio = (w * h) / max(1, image_w * image_h)
    if area_ratio < 0.015:
        return None
    return _clip_region(x - padding, y - padding, w + padding * 2, h + padding * 2, image_w, image_h)


def _line_frame_regions(gray: np.ndarray, image_w: int, image_h: int) -> list[dict]:
    dark = cv2.inRange(gray, 0, 95)
    horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, image_w // 12), 1))
    vertical_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(20, image_h // 12)))
    horizontal = cv2.morphologyEx(dark, cv2.MORPH_OPEN, horizontal_kernel)
    vertical = cv2.morphologyEx(dark, cv2.MORPH_OPEN, vertical_kernel)

    horizontal_lines = _line_components(horizontal, "horizontal", image_w, image_h)
    vertical_lines = _line_components(vertical, "vertical", image_w, image_h)
    horizontal_lines, vertical_lines = _limit_frame_candidates(horizontal_lines, vertical_lines)
    if len(horizontal_lines) < 2 or len(vertical_lines) < 2:
        return []

    # 縦線の組（左 < 右）を、元の二重ループと同じ順序（left_index 昇順 → right 昇順）で配列にする。
    # 上下の横線の組ごとに、全ての左右の組を numpy で一括判定する（判定式・出力順は従来と同じ）。
    left_idx, right_idx = np.triu_indices(len(vertical_lines), k=1)
    v_center = np.array([line["center"] for line in vertical_lines], dtype=np.int64)
    v_start = np.array([line["start"] for line in vertical_lines], dtype=np.int64)
    v_end = np.array([line["end"] for line in vertical_lines], dtype=np.int64)
    left_center, right_center = v_center[left_idx], v_center[right_idx]
    frame_w = right_center - left_center
    pair_min_end = np.minimum(v_end[left_idx], v_end[right_idx])
    pair_max_start = np.maximum(v_start[left_idx], v_start[right_idx])
    wide_enough = frame_w >= image_w * 0.18

    regions = []
    image_area = image_w * image_h
    for top_index, top in enumerate(horizontal_lines):
        for bottom in horizontal_lines[top_index + 1 :]:
            frame_h = bottom["center"] - top["center"]
            if frame_h < image_h * 0.18:
                continue
            # _lines_form_frame と同じ判定（横線が左右の縦線間の72%以上、縦線が上下の横線間の72%以上を覆う）
            horizontal_overlap = (
                np.minimum(min(top["end"], bottom["end"]), right_center + 8)
                - np.maximum(max(top["start"], bottom["start"]), left_center - 8)
            )
            vertical_overlap = np.minimum(pair_min_end, bottom["center"] + 8) - np.maximum(pair_max_start, top["center"] - 8)
            frames = (
                wide_enough
                & (frame_w > 0)
                & (horizontal_overlap >= frame_w * 0.72)
                & (vertical_overlap >= frame_h * 0.72)
            )
            for pair in np.flatnonzero(frames):
                left = vertical_lines[left_idx[pair]]
                region = _clip_region(
                    left["center"] - 4,
                    top["center"] - 4,
                    int(frame_w[pair]) + 8,
                    frame_h + 8,
                    image_w,
                    image_h,
                )
                area_ratio = (region["width"] * region["height"]) / max(1, image_area)
                if area_ratio < 0.03 or area_ratio > 0.96:
                    continue
                score = min(0.985, 0.9 + area_ratio * 0.12)
                regions.append({**region, "label": "枠線候補", "score": score})
    return regions


def _limit_frame_candidates(horizontal_lines: list[dict], vertical_lines: list[dict]) -> tuple[list[dict], list[dict]]:
    """枠の候補（横線の組 × 縦線の組）が多すぎる場合だけ、短い線から除いて上限に収める。

    方眼のグラフや罫線の多い表では組み合わせが数千万になり、候補抽出が数分以上止まっていた。
    通常の図面（線が数十本まで）は上限に届かず、結果は変わらない。
    """
    def pair_count(lines: list[dict]) -> int:
        return len(lines) * (len(lines) - 1) // 2

    horizontal = list(horizontal_lines)
    vertical = list(vertical_lines)
    while pair_count(horizontal) * pair_count(vertical) > MAX_FRAME_CANDIDATES:
        target = horizontal if pair_count(horizontal) >= pair_count(vertical) else vertical
        shortest = min(range(len(target)), key=lambda index: (target[index]["length"], target[index]["area"]))
        target.pop(shortest)
    return horizontal, vertical


def _line_components(mask: np.ndarray, orientation: str, image_w: int, image_h: int) -> list[dict]:
    _, _, stats, _ = cv2.connectedComponentsWithStats(mask)
    lines = []
    for x, y, w, h, area in stats[1:]:
        if orientation == "horizontal":
            if w < image_w * 0.25 or h > 8:
                continue
            lines.append({"start": int(x), "end": int(x + w), "center": int(y + h // 2), "length": int(w), "area": int(area)})
        else:
            if h < image_h * 0.25 or w > 8:
                continue
            lines.append({"start": int(y), "end": int(y + h), "center": int(x + w // 2), "length": int(h), "area": int(area)})
    return sorted(lines, key=lambda item: item["center"])


def _large_rectangular_regions(mask: np.ndarray, image_w: int, image_h: int) -> list[dict]:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    regions = []
    image_area = image_w * image_h
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < image_area * 0.025:
            continue
        x, y, w, h = cv2.boundingRect(contour)
        fill_ratio = area / max(1, w * h)
        if w < image_w * 0.18 or h < image_h * 0.18:
            continue
        if fill_ratio < 0.03:
            continue
        score = min(0.9, 0.58 + area / max(1, image_area))
        regions.append({**_clip_region(x - 4, y - 4, w + 8, h + 8, image_w, image_h), "label": "枠候補", "score": score})
    return regions


def _dense_detail_regions(mask: np.ndarray, image_w: int, image_h: int) -> list[dict]:
    regions = []
    image_area = image_w * image_h
    for cols, rows, base_score in ((3, 3, 0.68), (4, 4, 0.62)):
        cell_w = image_w / cols
        cell_h = image_h / rows
        scored = []
        for row in range(rows):
            for col in range(cols):
                x1 = int(round(col * cell_w))
                y1 = int(round(row * cell_h))
                x2 = int(round((col + 1) * cell_w))
                y2 = int(round((row + 1) * cell_h))
                cell = mask[y1:y2, x1:x2]
                density = float(np.count_nonzero(cell)) / max(1, cell.size)
                if density <= 0.015:
                    continue
                scored.append((density, x1, y1, x2 - x1, y2 - y1))
        for density, x, y, w, h in sorted(scored, reverse=True)[:3]:
            pad_x = int(w * 0.18)
            pad_y = int(h * 0.18)
            region = _clip_region(x - pad_x, y - pad_y, w + pad_x * 2, h + pad_y * 2, image_w, image_h)
            if region["width"] * region["height"] < image_area * 0.04:
                continue
            regions.append({**region, "label": "特徴密度候補", "score": min(0.86, base_score + density)})
    return regions


def _dedupe_regions(regions: list[dict], image_w: int, image_h: int, limit: int) -> list[dict]:
    """スコアの高い順に、既に選んだ候補と大きく重なる（IoU > 0.72）ものを除いて最大 limit 件選ぶ。"""
    normalized = []
    for region in regions:
        clipped = _clip_region(region["x"], region["y"], region["width"], region["height"], image_w, image_h)
        if clipped["width"] < 20 or clipped["height"] < 20:
            continue
        normalized.append({**clipped, "label": region["label"], "score": float(region["score"])})

    selected: list[dict] = []
    for region in sorted(normalized, key=lambda item: item["score"], reverse=True):
        if any(_iou(region, existing) > 0.72 for existing in selected):
            continue
        selected.append(region)
        # 返すのは先頭 limit 件だけなので、それ以上は比較しない（候補が多い画像で二乗の計算量になるため）
        if len(selected) >= limit:
            break
    return selected


def _clip_region(x: int, y: int, width: int, height: int, image_w: int, image_h: int) -> dict:
    x1 = max(0, min(image_w - 1, int(round(x))))
    y1 = max(0, min(image_h - 1, int(round(y))))
    x2 = max(x1 + 1, min(image_w, int(round(x + width))))
    y2 = max(y1 + 1, min(image_h, int(round(y + height))))
    return {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1}


def _iou(a: dict, b: dict) -> float:
    ax2 = a["x"] + a["width"]
    ay2 = a["y"] + a["height"]
    bx2 = b["x"] + b["width"]
    by2 = b["y"] + b["height"]
    ix1 = max(a["x"], b["x"])
    iy1 = max(a["y"], b["y"])
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    union = a["width"] * a["height"] + b["width"] * b["height"] - inter
    return inter / union if union else 0.0
