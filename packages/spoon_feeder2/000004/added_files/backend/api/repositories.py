"""リポジトリ一覧・ツリー・コンテキスト・ファイル内容・依存関係に関するAPI (repositories.py)"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException

from ..analysis import build_dependency_map
from ..mkdocs_support import detect_mkdocs_config, discover_linked_markdown_files
from ..references import discover_internal_modules
from ..repository import (
    build_context,
    entries_to_tree,
    list_repository_entries,
    load_legacy_ignore_config,
    read_context_file,
)
from ..settings_store import get_settings_file, load_settings, remember_repository, repository_config, settings_transaction
from .deps import get_export_folder, repository_root, safe_file_base_name
from .schemas import AutoSelectRequest, ContextRequest, FileRequest, RepositoryRequest, SaveContextRequest, SettingsRequest

router = APIRouter()


@router.get("/health")
def health() -> dict:
    return {"status": "ok"}


@router.get("/repositories")
def repositories() -> dict:
    settings = load_settings(get_settings_file())
    paths = [path for path in settings.get("repositories", {}) if Path(path).is_dir()]
    return {"repositories": sorted(paths)}


@router.post("/remove_repository")
def remove_repository(request: RepositoryRequest) -> dict:
    root = repository_root(request.library_path)
    with settings_transaction() as settings:
        settings.setdefault("repositories", {}).pop(str(root), None)
    return {"status": "success", "removed": str(root)}


@router.post("/repository_structure")
def repository_structure(request: RepositoryRequest) -> dict:
    root = repository_root(request.library_path)
    try:
        entries, git_repo = list_repository_entries(root, request.show_ignored)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    config = repository_config(load_settings(get_settings_file()), root)
    legacy_config = load_legacy_ignore_config(root)
    mkdocs_info = detect_mkdocs_config(root)
    remember_repository(root, show_ignored=request.show_ignored)
    return {
        "files": entries_to_tree(entries),
        "selected_files": config.get("selected_files") or legacy_config.get("selected_files", []),
        "is_git_repository": git_repo,
        "git_root": str(root) if git_repo else "",
        "is_mkdocs_repository": mkdocs_info["is_mkdocs"],
        "mkdocs_config": mkdocs_info,
    }


@router.post("/repository_context")
def repository_context(request: ContextRequest) -> dict:
    root = repository_root(request.library_path)
    context, file_count, reference_file_count = build_context(root, request.selected_files, request.reference_files)
    remember_repository(root, selected_files=request.selected_files or [])
    return {"context": context, "file_count": file_count, "reference_file_count": reference_file_count}


@router.post("/save_context")
def save_context(request: SaveContextRequest) -> dict:
    root = repository_root(request.library_path)
    save_dir = Path(request.target_dir.strip() or get_export_folder()).expanduser().resolve()
    try:
        save_dir.mkdir(parents=True, exist_ok=True)
        base_name = safe_file_base_name(request.file_base_name.strip() or root.name or "repository", ".txt") or "repository"
        target = save_dir / f"{base_name}_context.txt"
        target.write_text(request.context, encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"コンテキストを保存できませんでした: {exc}") from exc
    return {"status": "success", "folder_path": str(save_dir), "file_path": str(target), "file_name": target.name}


@router.post("/save_settings")
def save_repository_settings(request: SettingsRequest) -> dict:
    root = repository_root(request.library_path)
    remember_repository(root, request.selected_files, request.show_ignored)
    return {"status": "success"}


@router.post("/file_content")
def file_content(request: FileRequest) -> dict:
    root = repository_root(request.library_path)
    try:
        content = read_context_file(root, request.file_path)
        target = (root / request.file_path.replace("\\", "/")).resolve()
        return {"content": content, "size": target.stat().st_size}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=404, detail=f"ファイルを読み込めませんでした: {exc}") from exc


@router.post("/dependency_map")
def dependency_map(request: RepositoryRequest) -> dict:
    return build_dependency_map(repository_root(request.library_path))


@router.post("/auto_select_modules")
def auto_select_modules(request: AutoSelectRequest) -> dict:
    root = repository_root(request.library_path)
    detected = sorted(set(discover_internal_modules(root, request.selected_files)) | set(discover_linked_markdown_files(root, request.selected_files)))
    already_selected = set(request.selected_files)
    return {
        "selected_files": sorted(already_selected | set(detected)),
        "added_files": [path for path in detected if path not in already_selected],
    }
