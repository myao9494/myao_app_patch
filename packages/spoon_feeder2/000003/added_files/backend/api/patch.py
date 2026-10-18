"""AI出力の差分プレビューと反映API (patch.py)"""

from __future__ import annotations

from fastapi import APIRouter

from ..external_roots import get_external_roots
from ..patcher import apply_preview, prepare_preview
from .deps import repository_root
from .schemas import PatchRequest

router = APIRouter()


@router.post("/patch/preview")
def patch_preview(request: PatchRequest) -> dict:
    root = repository_root(request.library_path)
    extra_roots = get_external_roots(root)
    return prepare_preview(root, request.ai_output, request.overrides, request.target_path, extra_roots=extra_roots)


@router.post("/patch/apply")
def patch_apply(request: PatchRequest) -> dict:
    root = repository_root(request.library_path)
    extra_roots = get_external_roots(root)
    preview = prepare_preview(root, request.ai_output, request.overrides, request.target_path, extra_roots=extra_roots)
    return apply_preview(root, preview, extra_roots=extra_roots)
