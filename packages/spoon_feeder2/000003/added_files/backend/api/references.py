"""参照リポジトリ解析と手動対応付けAPI (references.py)"""

from __future__ import annotations

import subprocess

from fastapi import APIRouter, HTTPException

from ..references import discover_reference_modules
from ..settings_store import get_settings_file, load_settings, manual_references, settings_transaction
from .deps import repository_root
from .schemas import ReferenceMappingRequest, ReferenceRequest

router = APIRouter()


@router.post("/reference_modules")
def reference_modules(request: ReferenceRequest) -> dict:
    root = repository_root(request.library_path)
    references = manual_references(load_settings(get_settings_file()), root)
    try:
        return discover_reference_modules(root, request.selected_files, request.python_mode, references)
    except (OSError, subprocess.SubprocessError) as exc:
        # Optional discovery must not block the main repository workflow.
        return {
            "enabled": request.python_mode != "embedded",
            "repositories": [],
            "unresolved": [],
            "manual_references": references,
            "warnings": [f"参照リポジトリを自動解析できませんでした: {exc}"],
        }


def _manual_reference_map(settings: dict, root_key: str) -> dict:
    config = settings.setdefault("repositories", {}).setdefault(root_key, {})
    if not isinstance(config.get("manual_references"), dict):
        config["manual_references"] = {}
    return config["manual_references"]


@router.post("/save_reference_mapping")
def save_reference_mapping(request: ReferenceMappingRequest) -> dict:
    root = repository_root(request.library_path)
    reference_root = repository_root(request.repository_path)
    module = request.module.strip()
    if not module:
        raise HTTPException(status_code=400, detail="未解決モジュールが指定されていません。")
    if reference_root == root:
        raise HTTPException(status_code=400, detail="メインリポジトリは参照先に指定できません。")
    with settings_transaction() as settings:
        _manual_reference_map(settings, str(root))[module] = str(reference_root)
    return {"status": "success", "module": module, "repository_path": str(reference_root)}


@router.post("/remove_reference_mapping")
def remove_reference_mapping(request: ReferenceMappingRequest) -> dict:
    root = repository_root(request.library_path)
    with settings_transaction() as settings:
        _manual_reference_map(settings, str(root)).pop(request.module.strip(), None)
    return {"status": "success"}
