"""
画像差分の共通パイプライン（変換 → 位置合わせ → 差分 → PNGエンコード）とアップロード処理。
- 画像A/Bの変換・ラスタライズ、レスポンス用PNGのエンコードはスレッドで並列実行する
  （OpenCV・zlib は処理中にGILを解放するため、CPUコアを並列に使える）
- 補正済み画像は result_cache に保持し、しきい値変更（rediff）では位置合わせをやり直さない
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import webbrowser

from fastapi import BackgroundTasks, HTTPException, Request, UploadFile

from .alignment import align_to_reference
from .diffing import build_visual_diff, resize_to_match
from .image_io import (
    MAX_UPLOAD_BYTES,
    MULTIPAGE_FORMATS,
    ConversionError,
    PageRangeError,
    RasterInfo,
    analyze_upload,
    cv_to_pil,
    decode_png,
    encode_png,
    pil_to_cv,
    sniff_format,
)
from .models import AlignmentInfo, DiffResponse, ImagePayload, RediffRequest
from .raster_cache import rasterize_upload_page_cached
from .result_cache import store_diff_images

READ_CHUNK_SIZE = 1024 * 1024


def read_upload_or_413(file: UploadFile) -> bytes:
    # 重い画像処理を行うエンドポイントは同期関数（スレッドプール実行）にしているため、
    # アップロード本体（SpooledTemporaryFile）も同期で読む。async 内で同期処理を行うと
    # 処理中は他の全リクエスト（3D進捗の確認など）が止まってしまう。
    chunks = []
    total = 0
    while True:
        chunk = file.file.read(READ_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            limit_mb = MAX_UPLOAD_BYTES / (1024 * 1024)
            raise HTTPException(status_code=413, detail=f"Upload is too large; limit is {limit_mb:.0f} MB per file")
        chunks.append(chunk)
    return b"".join(chunks)


def analyze_or_400(filename: str, content: bytes):
    try:
        if sniff_format(filename, content) in MULTIPAGE_FORMATS:
            # PDF/TIFF はページ画像を作らずにメタデータだけ読む
            return analyze_upload(filename, content)
        # 単一ページ形式は解析にも画像化が必要なので、ラスター化キャッシュを通す。
        # 直後に呼ばれる /api/convert・/api/diff が同じ変換をやり直さずに済む。
        fmt, page = rasterize_upload_page_cached(filename, content, page=0)
        return fmt, [RasterInfo(index=page.index, width=page.image.width, height=page.image.height, warnings=page.warnings)]
    except PageRangeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ConversionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not read {filename}: {exc}") from exc


def convert_page_or_400(filename: str, content: bytes, page: int):
    try:
        return rasterize_upload_page_cached(filename, content, page=page)
    except PageRangeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ConversionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not read {filename}: {exc}") from exc


def page_warnings(pages) -> list[str]:
    warnings = []
    for page in pages:
        for warning in getattr(page, "warnings", ()):
            if warning not in warnings:
                warnings.append(warning)
    return warnings


def parse_anchor_region(anchor_region: str | None) -> dict | None:
    if not anchor_region:
        return None
    try:
        value = json.loads(anchor_region)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="anchor_region must be JSON") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="anchor_region must be an object")
    return value


def build_diff_response(
    *,
    filename_a: str,
    content_a: bytes,
    filename_b: str,
    content_b: bytes,
    category: str,
    diff_threshold: float,
    page_a: int = 0,
    page_b: int = 0,
    anchor_region: dict | None = None,
) -> DiffResponse:
    """変換 → 位置合わせ → 差分 → PNGエンコードを行う、/api/diff と /api/git/diff の共通処理。"""
    # 画像Aと画像Bの変換・ラスタライズを並列実行
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        future_a = executor.submit(convert_page_or_400, filename_a, content_a, page_a)
        future_b = executor.submit(convert_page_or_400, filename_b, content_b, page_b)
        _, raster_a = future_a.result()
        _, raster_b = future_b.result()

    image_a = pil_to_cv(raster_a.image)
    image_b = pil_to_cv(raster_b.image)
    alignment = align_to_reference(image_a, image_b, category=category, anchor_region=anchor_region)
    comparison_a = alignment.reference_image if alignment.reference_image is not None else image_a
    comparison_a = resize_to_match(alignment.image, comparison_a)
    comparison_b = resize_to_match(comparison_a, alignment.image)
    diff_result = build_visual_diff(comparison_a, comparison_b, threshold=diff_threshold)
    result_id = store_diff_images(
        comparison_a,
        comparison_b,
        filename_a=filename_a,
        filename_b=filename_b,
        page_a=raster_a.index,
        page_b=raster_b.index,
        category=category,
    )

    # 6枚のPNGエンコード（圧縮）をスレッド並列実行してレスポンス生成を高速化
    encoded_comp_a, encoded_orig_a, encoded_orig_b, encoded_comp_b, encoded_overlay, encoded_mask = encode_pngs_parallel(
        comparison_a, image_a, image_b, comparison_b, diff_result["overlay"], diff_result["mask"]
    )

    return DiffResponse(
        result_id=result_id,
        filename_a=filename_a,
        filename_b=filename_b,
        page_a=raster_a.index,
        page_b=raster_b.index,
        category=category,
        width=comparison_a.shape[1],
        height=comparison_a.shape[0],
        alignment=AlignmentInfo(
            success=alignment.success,
            method=alignment.method,
            warning=alignment.warning,
            matches=alignment.matches,
            inliers=alignment.inliers,
            matrix=alignment.matrix,
        ),
        image_a=ImagePayload(data=encoded_comp_a),
        image_a_original=ImagePayload(data=encoded_orig_a),
        image_b_original=ImagePayload(data=encoded_orig_b),
        image_b_aligned=ImagePayload(data=encoded_comp_b),
        overlay=ImagePayload(data=encoded_overlay),
        mask=ImagePayload(data=encoded_mask),
        diff_rects=diff_result["rects"],
        diff_pixels=diff_result["diff_pixels"],
        diff_ratio=diff_result["diff_ratio"],
        diff_threshold=diff_result["threshold"],
        conversion_warnings=page_warnings([raster_a, raster_b]),
    )


def build_cached_diff_response(result_id: str, cached, diff_threshold: float) -> DiffResponse:
    comparison_a = resize_to_match(cached.image_b_aligned, cached.image_a)
    comparison_b = resize_to_match(comparison_a, cached.image_b_aligned)
    diff_result = build_visual_diff(comparison_a, comparison_b, threshold=diff_threshold)
    # キャッシュには補正済み画像しかないため、元画像欄にも同じ画像を返す（エンコードは1回ずつ）。
    encoded_a, encoded_b, encoded_overlay, encoded_mask = encode_pngs_parallel(
        comparison_a, comparison_b, diff_result["overlay"], diff_result["mask"]
    )
    return DiffResponse(
        result_id=result_id,
        filename_a=cached.filename_a,
        filename_b=cached.filename_b,
        page_a=cached.page_a,
        page_b=cached.page_b,
        category=cached.category,
        width=comparison_a.shape[1],
        height=comparison_a.shape[0],
        alignment=AlignmentInfo(
            success=True,
            method="cached",
            warning=None,
            matches=0,
            inliers=0,
            matrix=None,
        ),
        image_a=ImagePayload(data=encoded_a),
        image_a_original=ImagePayload(data=encoded_a),
        image_b_original=ImagePayload(data=encoded_b),
        image_b_aligned=ImagePayload(data=encoded_b),
        overlay=ImagePayload(data=encoded_overlay),
        mask=ImagePayload(data=encoded_mask),
        diff_rects=diff_result["rects"],
        diff_pixels=diff_result["diff_pixels"],
        diff_ratio=diff_result["diff_ratio"],
        diff_threshold=diff_result["threshold"],
        conversion_warnings=[],
    )


def encode_pngs_parallel(*images_bgr) -> list[str]:
    """OpenCV画像（BGR/グレー）をBase64 PNGへ並列エンコードする。zlib圧縮中はGILが解放される。"""
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(images_bgr))) as executor:
        return list(executor.map(lambda image: encode_png(cv_to_pil(image)), images_bgr))


def decode_rediff_images(payload: RediffRequest):
    if payload.image_a is None or payload.image_b_aligned is None:
        raise HTTPException(status_code=422, detail="result_id or both diff images are required")
    try:
        return pil_to_cv(decode_png(payload.image_a.data)), pil_to_cv(decode_png(payload.image_b_aligned.data))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not read diff images: {exc}") from exc


def schedule_open_result(background_tasks: BackgroundTasks, request: Request, result_id: str | None) -> None:
    if not result_id:
        return
    if os.environ.get("VISUAL_DIFF_OPEN_BROWSER", "1").lower() in {"0", "false", "no"}:
        return
    if request.url.hostname not in {"127.0.0.1", "localhost"}:
        return
    url = str(request.base_url.include_query_params(result_id=result_id))
    background_tasks.add_task(_open_browser, url)


def _open_browser(url: str) -> None:
    try:
        webbrowser.open(url, new=2, autoraise=True)
    except Exception:
        pass


def git_preview_payload(filename: str, content: bytes) -> dict:
    _, page = convert_page_or_400(filename, content, 0)
    return {"mime_type": "image/png", "data": encode_png(page.image)}
