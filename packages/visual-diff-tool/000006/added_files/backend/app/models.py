"""APIのリクエスト・レスポンスモデル（画像は data URI 接頭辞なしのBase64 PNG）。"""

from __future__ import annotations

from pydantic import BaseModel, Field


class PageInfo(BaseModel):
    index: int
    width: int
    height: int
    warnings: list[str] = Field(default_factory=list)


class AnalyzeResponse(BaseModel):
    filename: str
    format: str
    page_count: int
    pages: list[PageInfo]
    warnings: list[str] = Field(default_factory=list)


class AlignmentInfo(BaseModel):
    success: bool
    method: str
    warning: str | None = None
    matches: int = 0
    inliers: int = 0
    matrix: list[list[float]] | None = None


class DiffRect(BaseModel):
    x: int
    y: int
    width: int
    height: int
    area: int


class ImagePayload(BaseModel):
    mime_type: str = "image/png"
    data: str = Field(description="Base64 encoded image data without data URI prefix")


class DiffResponse(BaseModel):
    result_id: str | None = None
    filename_a: str | None = None
    filename_b: str | None = None
    page_a: int
    page_b: int
    category: str
    width: int
    height: int
    alignment: AlignmentInfo
    image_a: ImagePayload
    image_a_original: ImagePayload
    image_b_original: ImagePayload
    image_b_aligned: ImagePayload
    overlay: ImagePayload
    mask: ImagePayload
    diff_rects: list[DiffRect]
    diff_pixels: int
    diff_ratio: float
    diff_threshold: float = 0.1
    conversion_warnings: list[str] = Field(default_factory=list)


class RediffRequest(BaseModel):
    result_id: str | None = None
    image_a: ImagePayload | None = None
    image_b_aligned: ImagePayload | None = None
    diff_threshold: float = 0.1


class RediffResponse(BaseModel):
    result_id: str | None = None
    overlay: ImagePayload
    mask: ImagePayload
    diff_rects: list[DiffRect]
    diff_pixels: int
    diff_ratio: float
    diff_threshold: float = 0.1
