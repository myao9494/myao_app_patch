"""
Git差分API（HEAD と作業ツリーの比較、テキストの編集・保存・1行復元）。
POST /api/git/images, /api/git/files, /api/git/markdown（GETも可）, /api/git/item,
/api/git/text-diff, /api/git/save-text, /api/git/revert-line, /api/git/diff
"""

from __future__ import annotations

import json
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from ..diff_pipeline import build_diff_response, git_preview_payload
from ..file_utils import encode_like_original, read_file_limited, write_bytes_atomically
from ..git_repo import (
    changed_files,
    changed_image_files,
    git_file_kind,
    git_repo_root,
    git_show,
    payload_folder,
    payload_git_scope,
    safe_git_path,
    text_extensions_from_payload,
)
from ..image_io import MAX_UPLOAD_BYTES, extract_excalidraw_json
from ..markdown_links import related_paths_for_markdown
from ..models import DiffResponse
from ..text_diff import (
    EXCALIDRAW_PLUGIN_MARKER_RE,
    MAX_TEXT_BYTES,
    build_markdown_text_diff_rows,
    decode_git_text,
)

router = APIRouter()


@router.post("/api/git/images")
def git_images(payload: dict) -> JSONResponse:
    folder, source_markdown = payload_git_scope(payload)
    repo = git_repo_root(folder)
    if source_markdown:
        related_paths = related_paths_for_markdown(repo, source_markdown)
        files = changed_image_files(repo, repo, specific_paths=related_paths)
    else:
        files = changed_image_files(repo, folder)
    return JSONResponse(
        {
            "folder": str(folder),
            "repo_root": str(repo),
            "source_markdown": source_markdown,
            "files": files,
        }
    )


@router.post("/api/git/files")
def git_files(payload: dict) -> JSONResponse:
    folder, source_markdown = payload_git_scope(payload)
    repo = git_repo_root(folder)
    text_extensions = text_extensions_from_payload(payload)
    if source_markdown:
        related_paths = related_paths_for_markdown(repo, source_markdown)
        files = changed_files(repo, repo, text_extensions, specific_paths=related_paths)
    else:
        files = changed_files(repo, folder, text_extensions)
    return JSONResponse(
        {
            "folder": str(folder),
            "repo_root": str(repo),
            "text_extensions": sorted(text_extensions),
            "source_markdown": source_markdown,
            "files": files,
        }
    )


@router.post("/api/git/markdown")
def git_markdown_diff(payload: dict, request: Request) -> JSONResponse:
    """Create a deep link for an Obsidian Markdown-rooted Git diff.

    Obsidian integrations can call this endpoint with the active note path,
    then open ``diff_url``. The web UI consumes the same path and loads the
    Markdown diff plus all changed files reachable from its links.
    """
    raw_markdown = str(
        payload.get("markdown_path")
        or payload.get("markdown_file")
        or payload.get("path")
        or payload.get("folder")
        or ""
    ).strip()
    if not raw_markdown:
        raise HTTPException(status_code=422, detail="markdown_path is required")
    folder, source_markdown = payload_git_scope({"folder": raw_markdown})
    if not source_markdown:
        raise HTTPException(status_code=422, detail="markdown_path must point to a Markdown file")
    repo = git_repo_root(folder)
    text_extensions = text_extensions_from_payload(payload)
    related_paths = related_paths_for_markdown(repo, source_markdown)
    files = changed_files(repo, repo, text_extensions, specific_paths=related_paths)
    return JSONResponse(
        {
            "folder": str(folder),
            "repo_root": str(repo),
            "source_markdown": source_markdown,
            "text_extensions": sorted(text_extensions),
            "files": files,
            "diff_url": f"{str(request.base_url).rstrip('/')}/?markdown_path={quote(source_markdown, safe='')}",
        }
    )


@router.get("/api/git/markdown")
def get_git_markdown_diff(request: Request, path: str | None = None, markdown_path: str | None = None) -> JSONResponse:
    """GET convenience form for integrations that only have a note path."""
    return git_markdown_diff({"markdown_path": markdown_path or path or ""}, request)


@router.post("/api/git/item")
def git_item(payload: dict) -> JSONResponse:
    folder = payload_folder(payload)
    repo = git_repo_root(folder)
    path = str(payload.get("path") or "")
    if not path:
        raise HTTPException(status_code=422, detail="path is required")
    rel_path = safe_git_path(repo, path, restrict_to_images=False)
    head_path = str(payload.get("head_path") or path)
    head_rel_path = safe_git_path(repo, head_path, restrict_to_images=False)
    text_extensions = text_extensions_from_payload(payload)
    kind = git_file_kind(rel_path, text_extensions)
    if kind is None:
        raise HTTPException(status_code=422, detail="path extension is not enabled")

    has_head = bool(payload.get("has_head", True))
    has_current = bool(payload.get("has_current", True))
    max_bytes = MAX_UPLOAD_BYTES if kind in ("image", "3d") else MAX_TEXT_BYTES
    previous = git_show(repo, head_rel_path, max_bytes=max_bytes) if has_head else None
    current_path = repo / rel_path
    current = None
    if has_current:
        if not current_path.exists() or not current_path.is_file():
            raise HTTPException(status_code=404, detail=f"Current file not found: {rel_path}")
        current = read_file_limited(current_path, max_bytes, rel_path)

    response: dict = {"path": rel_path, "head_path": head_rel_path, "kind": kind}
    if kind == "image":
        response["image_head"] = git_preview_payload(head_rel_path, previous) if previous is not None else None
        response["image_current"] = git_preview_payload(rel_path, current) if current is not None else None
    elif kind == "3d":
        response["step_available"] = True
        response["has_head"] = has_head and previous is not None
        response["has_current"] = has_current and current is not None
    else:
        old_text, old_encoding = decode_git_text(previous) if previous is not None else ("", None)
        new_text, new_encoding = decode_git_text(current) if current is not None else ("", None)
        response.update({"encoding_head": old_encoding, "encoding_current": new_encoding, "rows": build_markdown_text_diff_rows(old_text, new_text)})
        if payload.get("include_text", True):
            response.update({"text_head": old_text, "text_current": new_text})
    return JSONResponse(response)


@router.post("/api/git/text-diff")
def git_text_diff(payload: dict) -> JSONResponse:
    """Build a preview diff for an edited working-tree text value."""
    folder = payload_folder(payload)
    repo = git_repo_root(folder)
    rel_path = safe_git_path(repo, str(payload.get("path") or ""), restrict_to_images=False)
    head_rel_path = safe_git_path(repo, str(payload.get("head_path") or rel_path), restrict_to_images=False)
    text_extensions = text_extensions_from_payload(payload)
    if git_file_kind(rel_path, text_extensions) != "text":
        raise HTTPException(status_code=422, detail="Only enabled text files can be previewed")
    has_head = bool(payload.get("has_head", True))
    previous = git_show(repo, head_rel_path, max_bytes=MAX_TEXT_BYTES) if has_head else None
    old_text, _ = decode_git_text(previous) if previous is not None else ("", "utf-8")
    new_text = str(payload.get("text") or "")
    return JSONResponse({"path": rel_path, "rows": build_markdown_text_diff_rows(old_text, new_text), "text_current": new_text})


@router.post("/api/git/save-text")
def save_git_text(payload: dict) -> JSONResponse:
    """Save an edited text draft back to the working-tree file."""
    folder = payload_folder(payload)
    repo = git_repo_root(folder)
    rel_path = safe_git_path(repo, str(payload.get("path") or ""), restrict_to_images=False)
    head_rel_path = safe_git_path(repo, str(payload.get("head_path") or rel_path), restrict_to_images=False)
    text_extensions = text_extensions_from_payload(payload)
    if git_file_kind(rel_path, text_extensions) != "text":
        raise HTTPException(status_code=422, detail="Only enabled text files can be saved")
    current_path = repo / rel_path
    if not current_path.is_file():
        raise HTTPException(status_code=404, detail=f"Current file not found: {rel_path}")

    current_bytes = read_file_limited(current_path, MAX_TEXT_BYTES, rel_path)
    current_text, current_encoding = decode_git_text(current_bytes)
    normalized_current_text = current_text.replace("\r\n", "\n").replace("\r", "\n")
    base_text = payload.get("base_text")
    if isinstance(base_text, str) and normalized_current_text != base_text:
        raise HTTPException(status_code=409, detail="The file changed outside this editor. Reload the preview before saving")
    edited_text = str(payload.get("text") or "")
    newline = "\r\n" if b"\r\n" in current_bytes else "\n"
    normalized_text = edited_text.replace("\r\n", "\n").replace("\r", "\n")
    serialized_text = normalized_text.replace("\n", newline)
    saved_bytes = encode_like_original(serialized_text, current_encoding, "Edited text")
    write_bytes_atomically(current_path, saved_bytes, "Could not save the working-tree file")

    old_bytes = git_show(repo, head_rel_path, max_bytes=MAX_TEXT_BYTES) if bool(payload.get("has_head", True)) else None
    old_text, _ = decode_git_text(old_bytes) if old_bytes is not None else ("", "utf-8")
    return JSONResponse(
        {
            "path": rel_path,
            "text_current": normalized_text,
            "rows": build_markdown_text_diff_rows(old_text, normalized_text),
            "encoding_current": current_encoding,
        }
    )


@router.post("/api/git/revert-line")
def git_revert_line(payload: dict) -> JSONResponse:
    """Restore one displayed working-tree diff row to its HEAD value."""
    folder = payload_folder(payload)
    repo = git_repo_root(folder)
    rel_path = safe_git_path(repo, str(payload.get("path") or ""), restrict_to_images=False)
    head_rel_path = safe_git_path(repo, str(payload.get("head_path") or rel_path), restrict_to_images=False)
    text_extensions = text_extensions_from_payload(payload)
    if git_file_kind(rel_path, text_extensions) != "text":
        raise HTTPException(status_code=422, detail="Only enabled text files can be restored by line")
    current_path = repo / rel_path
    if not current_path.is_file():
        raise HTTPException(status_code=404, detail=f"Current file not found: {rel_path}")

    old_text, _ = decode_git_text(git_show(repo, head_rel_path, max_bytes=MAX_TEXT_BYTES))
    current_bytes = read_file_limited(current_path, MAX_TEXT_BYTES, rel_path)
    new_text, current_encoding = decode_git_text(current_bytes)
    requested = payload.get("row")
    if not isinstance(requested, dict) or requested.get("kind") not in {"replace", "insert", "delete"}:
        raise HTTPException(status_code=422, detail="A changed diff row is required")
    requested_old_index = requested.get("old_index")
    requested_new_index = requested.get("new_index")
    if (
        not isinstance(requested_old_index, int)
        or isinstance(requested_old_index, bool)
        or not isinstance(requested_new_index, int)
        or isinstance(requested_new_index, bool)
    ):
        raise HTTPException(status_code=422, detail="Diff row indexes are required")

    candidates = [
        row for row in build_markdown_text_diff_rows(old_text, new_text)
        if row.get("kind") == requested.get("kind")
        and row.get("old") == requested.get("old")
        and row.get("new") == requested.get("new")
        and row.get("old_index") == requested_old_index
        and row.get("new_index") == requested_new_index
    ]
    if not candidates:
        raise HTTPException(status_code=409, detail="The file changed after the preview. Reload the preview and try again")
    row = candidates[0]
    lines = new_text.splitlines()
    index = int(row["new_index"])
    if row["kind"] == "insert":
        if index >= len(lines):
            raise HTTPException(status_code=409, detail="The target line no longer exists")
        lines.pop(index)
    elif row["kind"] == "delete":
        lines.insert(min(index, len(lines)), str(row.get("old") or ""))
    else:
        if index >= len(lines):
            raise HTTPException(status_code=409, detail="The target line no longer exists")
        lines[index] = str(row.get("old") or "")

    newline = "\r\n" if b"\r\n" in current_bytes else "\n"
    restored_text = newline.join(lines)
    if new_text.endswith(("\n", "\r")):
        restored_text += newline
    restored_bytes = encode_like_original(restored_text, current_encoding, "Restored text")
    write_bytes_atomically(current_path, restored_bytes, "Could not update the working-tree file")
    # text_current は改行をLFに正規化した復元後の全文。編集中でなければUIの本文もこれで更新できる。
    return JSONResponse(
        {
            "path": rel_path,
            "rows": build_markdown_text_diff_rows(old_text, restored_text),
            "text_current": restored_text.replace("\r\n", "\n").replace("\r", "\n"),
        }
    )


@router.post("/api/git/diff", response_model=DiffResponse)
def git_diff(payload: dict) -> DiffResponse:
    folder = payload_folder(payload)
    repo = git_repo_root(folder)
    path = str(payload.get("path") or "")
    if not path:
        raise HTTPException(status_code=422, detail="path is required")
    subresource = str(payload.get("subresource") or "").strip().lower()
    if subresource == "excalidraw":
        rel_path = safe_git_path(repo, path, restrict_to_images=False)
        if not rel_path.lower().endswith(".md"):
            raise HTTPException(status_code=422, detail="Excalidraw subresource requires a Markdown file")
        current_path = repo / rel_path
        if not current_path.exists() or not current_path.is_file():
            raise HTTPException(status_code=404, detail=f"Current file not found: {rel_path}")
        head_path = str(payload.get("head_path") or path)
        head_rel_path = safe_git_path(repo, head_path, restrict_to_images=False)
        previous = git_show(repo, head_rel_path, max_bytes=MAX_TEXT_BYTES)
        current = read_file_limited(current_path, MAX_TEXT_BYTES, rel_path)
        return build_diff_response(
            filename_a=f"HEAD:{head_rel_path}.excalidraw",
            content_a=_embedded_excalidraw_json_bytes(previous),
            filename_b=f"{rel_path}.excalidraw",
            content_b=_embedded_excalidraw_json_bytes(current),
            category=str(payload.get("category") or "図面"),
            diff_threshold=float(payload.get("diff_threshold") or 0.1),
        )

    rel_path = safe_git_path(repo, path)
    head_path = str(payload.get("head_path") or path)
    head_rel_path = safe_git_path(repo, head_path)
    current_path = repo / rel_path
    if not current_path.exists() or not current_path.is_file():
        raise HTTPException(status_code=404, detail=f"Current file not found: {rel_path}")
    previous = git_show(repo, head_rel_path, max_bytes=MAX_UPLOAD_BYTES)
    current = read_file_limited(current_path, MAX_UPLOAD_BYTES, rel_path)
    return build_diff_response(
        filename_a=f"HEAD:{head_rel_path}",
        content_a=previous,
        filename_b=rel_path,
        content_b=current,
        category=str(payload.get("category") or "汎用"),
        diff_threshold=float(payload.get("diff_threshold") or 0.1),
    )


def _embedded_excalidraw_json_bytes(content: bytes) -> bytes:
    """Extract a note's drawing as standalone JSON for the normal image pipeline."""
    text = content.decode("utf-8", errors="ignore")
    if not EXCALIDRAW_PLUGIN_MARKER_RE.search(text):
        return b'{"type":"excalidraw","elements":[],"appState":{}}'
    try:
        payload = extract_excalidraw_json(content)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not find Excalidraw JSON in Markdown: {exc}") from exc
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")
