"""
ファイル差分（アップロード画像の比較）API。
POST /api/attachments, /api/analyze, /api/convert, /api/diff, /api/rediff, GET /api/diff/{result_id}
"""

from __future__ import annotations

import concurrent.futures

from fastapi import (
    APIRouter,
    BackgroundTasks,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.responses import JSONResponse

from ..attachments import RETENTION_DAYS, cleanup_expired_attachments, save_attachment
from ..diff_pipeline import (
    analyze_or_400,
    build_cached_diff_response,
    build_diff_response,
    convert_page_or_400,
    decode_rediff_images,
    encode_pngs_parallel,
    page_warnings,
    parse_anchor_region,
    read_upload_or_413,
    schedule_open_result,
)
from ..diffing import build_visual_diff
from ..image_io import encode_png, pil_to_cv
from ..models import (
    AnalyzeResponse,
    DiffResponse,
    ImagePayload,
    PageInfo,
    RediffRequest,
    RediffResponse,
)
from ..regions import suggest_anchor_regions
from ..result_cache import get_diff_images, store_diff_images

router = APIRouter()


@router.post("/api/attachments")
def upload_attachment(file: UploadFile = File(...)) -> JSONResponse:
    content = read_upload_or_413(file)
    if not content:
        raise HTTPException(status_code=400, detail="Attachment is empty")
    deleted_expired = cleanup_expired_attachments()
    path = save_attachment(file.filename or "clipboard.png", content)
    return JSONResponse(
        {
            "filename": file.filename or "clipboard.png",
            "stored_as": path.name,
            "size": len(content),
            "retention_days": RETENTION_DAYS,
            "deleted_expired": deleted_expired,
        }
    )


@router.post("/api/analyze", response_model=AnalyzeResponse)
def analyze(file: UploadFile = File(...)) -> AnalyzeResponse:
    content = read_upload_or_413(file)
    fmt, pages = analyze_or_400(file.filename or "upload", content)
    warnings = page_warnings(pages)
    return AnalyzeResponse(
        filename=file.filename or "upload",
        format=fmt,
        page_count=len(pages),
        pages=[PageInfo(index=page.index, width=page.width, height=page.height, warnings=list(page.warnings)) for page in pages],
        warnings=warnings,
    )


@router.post("/api/convert")
def convert(file: UploadFile = File(...), page: int = Form(0)) -> JSONResponse:
    content = read_upload_or_413(file)
    fmt, selected = convert_page_or_400(file.filename or "upload", content, page)
    # プレビューPNGのエンコードと基準領域候補の抽出は独立しているので並列に行う（どちらもGILを解放する）
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        encoded = executor.submit(encode_png, selected.image)
        regions = executor.submit(lambda: suggest_anchor_regions(pil_to_cv(selected.image)))
        image_data, region_list = encoded.result(), regions.result()
    return JSONResponse(
        {
            "filename": file.filename,
            "format": fmt,
            "page": selected.index,
            "width": selected.image.width,
            "height": selected.image.height,
            "image": {"mime_type": "image/png", "data": image_data},
            "regions": region_list,
            "warnings": list(selected.warnings),
        }
    )


@router.post("/api/diff", response_model=DiffResponse)
def diff(
    background_tasks: BackgroundTasks,
    request: Request,
    file_a: UploadFile = File(...),
    file_b: UploadFile = File(...),
    page_a: int = Form(0),
    page_b: int = Form(0),
    category: str = Form("汎用"),
    diff_threshold: float = Form(0.1),
    anchor_region: str | None = Form(None),
) -> DiffResponse:
    response = build_diff_response(
        filename_a=file_a.filename or "a",
        content_a=read_upload_or_413(file_a),
        filename_b=file_b.filename or "b",
        content_b=read_upload_or_413(file_b),
        category=category,
        diff_threshold=diff_threshold,
        page_a=page_a,
        page_b=page_b,
        anchor_region=parse_anchor_region(anchor_region),
    )
    schedule_open_result(background_tasks, request, response.result_id)
    return response


@router.post("/api/rediff", response_model=RediffResponse)
def rediff(payload: RediffRequest) -> RediffResponse:
    result_id = payload.result_id
    if payload.result_id:
        cached = get_diff_images(payload.result_id)
        if cached:
            image_a = cached.image_a
            image_b_aligned = cached.image_b_aligned
        elif payload.image_a is None or payload.image_b_aligned is None:
            raise HTTPException(status_code=404, detail="Diff result cache expired")
        else:
            image_a, image_b_aligned = decode_rediff_images(payload)
            result_id = store_diff_images(image_a, image_b_aligned)
    else:
        image_a, image_b_aligned = decode_rediff_images(payload)
        result_id = store_diff_images(image_a, image_b_aligned)
    diff_result = build_visual_diff(image_a, image_b_aligned, threshold=payload.diff_threshold)
    encoded_overlay, encoded_mask = encode_pngs_parallel(diff_result["overlay"], diff_result["mask"])
    return RediffResponse(
        result_id=result_id,
        overlay=ImagePayload(data=encoded_overlay),
        mask=ImagePayload(data=encoded_mask),
        diff_rects=diff_result["rects"],
        diff_pixels=diff_result["diff_pixels"],
        diff_ratio=diff_result["diff_ratio"],
        diff_threshold=diff_result["threshold"],
    )


@router.get("/api/diff/{result_id}", response_model=DiffResponse)
def get_diff_result(result_id: str, diff_threshold: float = 0.1) -> DiffResponse:
    cached = get_diff_images(result_id)
    if not cached:
        raise HTTPException(status_code=404, detail="Diff result cache expired")
    return build_cached_diff_response(result_id, cached, diff_threshold)
