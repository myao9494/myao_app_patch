"""無視リスト(.spoonfeeder.json)の取得・保存・削除API (ignore.py)"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..repository import load_ignore_patterns, match_ignore_patterns, save_ignore_patterns
from .deps import repository_root
from .schemas import IgnorePatternRemoveRequest, IgnorePatternsRequest, RepositoryRequest

router = APIRouter()


def normalize_ignore_patterns(patterns: list[str]) -> list[str]:
    normalized: list[str] = []
    for raw in patterns:
        pattern = str(raw).replace("\\", "/").strip()
        if pattern.startswith("!"):
            pattern = "!" + pattern[1:].strip("/")
        else:
            pattern = pattern.strip("/")
        if pattern and pattern not in normalized:
            normalized.append(pattern)
    return normalized


@router.post("/ignore_patterns")
def ignore_patterns(request: RepositoryRequest) -> dict:
    root = repository_root(request.library_path)
    patterns, config_file = load_ignore_patterns(root)
    return {"patterns": patterns, "config_file": config_file}


@router.post("/save_ignore_patterns")
def save_repository_ignore_patterns(request: IgnorePatternsRequest) -> dict:
    root = repository_root(request.library_path)
    patterns = normalize_ignore_patterns(request.patterns)
    try:
        config_file = save_ignore_patterns(root, patterns)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"無視リストを保存できませんでした: {exc}") from exc
    return {"status": "success", "patterns": patterns, "config_file": config_file}


@router.post("/remove_ignore_pattern")
def remove_repository_ignore_pattern(request: IgnorePatternRemoveRequest) -> dict:
    root = repository_root(request.library_path)
    target = request.path.replace("\\", "/").strip("/")
    if not target:
        raise HTTPException(status_code=400, detail="除外するパスが指定されていません。")
    patterns, config_file = load_ignore_patterns(root)
    matching = [pattern for pattern in patterns if match_ignore_patterns(target, [pattern])[0]]
    if target in patterns:
        removed_pattern = target
    elif len(matching) == 1:
        removed_pattern = matching[0]
    else:
        return {"status": "unchanged", "patterns": patterns, "config_file": config_file, "message": "このパスは無視リストに登録されていません。Gitのignore設定はここから変更できません。"}
    patterns = [pattern for pattern in patterns if pattern != removed_pattern]
    try:
        config_file = save_ignore_patterns(root, patterns)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"無視リストを保存できませんでした: {exc}") from exc
    return {"status": "success", "patterns": patterns, "config_file": config_file}
