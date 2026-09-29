"""
Spoonfeeder2 FastAPI メインアプリケーション (main.py)

仕様:
1. リポジトリツリーの取得、コンテキストXMLの生成、ファイルプレビュー、無視リスト管理、コードパッチ適用、テスト実行、ターミナル等のREST APIを提供。
2. 登録済みリポジトリ履歴一覧（GET /api/repositories）および履歴削除（POST /api/remove_repository）を提供。
3. SPOONFEEDER_CONFIGS_FILE 環境変数による設定ファイルの動的切り替えに対応。
4. リポジトリのGit差分取得（POST /api/git_diff）を提供。
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
from html import escape as html_escape
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .analysis import build_dependency_map
from .patcher import apply_preview, prepare_preview
from .references import discover_reference_modules
from .repository import (
    _legacy_excluded,
    build_context,
    decode_process_output,
    entries_to_tree,
    is_git_repository,
    list_repository_entries,
    load_ignore_patterns,
    load_legacy_ignore_config,
    load_settings,
    read_context_file,
    save_ignore_patterns,
    save_settings,
)
from .terminal import _environment, router as terminal_router


ROOT = Path(__file__).resolve().parents[1]


def get_settings_file() -> Path:
    return Path(os.environ.get("SPOONFEEDER_CONFIGS_FILE", ROOT / "spoonfeeder_configs.json"))


SETTINGS_LOCK = threading.RLock()
app = FastAPI(title="Spoonfeeder2", version="2.0.0")
app.include_router(terminal_router, prefix="/api")


class RepositoryRequest(BaseModel):
    library_path: str
    show_ignored: bool = False


class ContextRequest(BaseModel):
    library_path: str
    selected_files: Optional[list[str]] = None
    reference_files: list[dict] = Field(default_factory=list)


class ReferenceRequest(BaseModel):
    library_path: str
    selected_files: list[str] = Field(default_factory=list)
    python_mode: str = "normal"


class ReferenceMappingRequest(BaseModel):
    library_path: str
    module: str
    repository_path: str


class SettingsRequest(BaseModel):
    library_path: str
    selected_files: list[str] = Field(default_factory=list)
    show_ignored: bool = False


class IgnorePatternsRequest(BaseModel):
    library_path: str
    patterns: list[str] = Field(default_factory=list)


class IgnorePatternRemoveRequest(BaseModel):
    library_path: str
    path: str


class FileRequest(BaseModel):
    library_path: str
    file_path: str


class PatchRequest(BaseModel):
    library_path: str
    ai_output: str
    target_path: str = ""
    overrides: dict[str, str] = Field(default_factory=dict)


class TestRequest(BaseModel):
    library_path: str
    test_command: str = "python -m pytest"
    python_mode: str = "normal"
    embedded_python_dir: str = ""


class FeedbackRequest(BaseModel):
    library_path: str
    test_command: str
    output: str
    exit_code: Optional[int] = None


class OpenRequest(BaseModel):
    library_path: str


class GitDiffRequest(BaseModel):
    library_path: str
    command: str = "git diff HEAD -- *.py"


def repository_root(value: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise HTTPException(status_code=400, detail=f"フォルダが存在しません: {value}")
    return path


def resolve_test_command(root: Path, command: str, mode: str = "normal", embedded_python_dir: str = "") -> str:
    """Prefer the selected environment's Python for default test commands."""
    executable_name = "python.exe" if os.name == "nt" else "python"
    python_path: Path | None = None

    if mode == "embedded" and embedded_python_dir:
        embedded_path = Path(embedded_python_dir).expanduser()
        if (embedded_path / executable_name).is_file():
            python_path = embedded_path / executable_name
        elif embedded_path.is_dir():
            for sub in embedded_path.iterdir():
                if sub.is_dir() and (sub / executable_name).is_file():
                    python_path = sub / executable_name
                    break
    else:
        executable_dir = "Scripts" if os.name == "nt" else "bin"
        python_path = next(
            (root / name / executable_dir / executable_name for name in (".venv", "venv", "env")
             if (root / name / executable_dir / executable_name).is_file()),
            None
        )

    if python_path is None:
        return command

    quoted_python = f'"{python_path}"'
    stripped = command.strip()
    if re.match(r"^(?:python|python3)(?:\s|$)", stripped, re.IGNORECASE):
        return quoted_python + stripped[stripped.find(" "):] if " " in stripped else quoted_python
    if re.match(r"^pytest(?:\s|$)", stripped, re.IGNORECASE):
        return f"{quoted_python} -m {stripped}"
    return command


def remember_repository(root: Path, selected_files: list[str] | None = None, show_ignored: bool | None = None) -> None:
    with SETTINGS_LOCK:
        settings_file = get_settings_file()
        settings = load_settings(settings_file)
        repositories = settings.setdefault("repositories", {})
        config = repositories.setdefault(str(root), {})
        if selected_files is not None: config["selected_files"] = selected_files
        if show_ignored is not None: config["show_ignored"] = show_ignored
        save_settings(settings_file, settings)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/repositories")
def repositories() -> dict:
    settings = load_settings(get_settings_file())
    paths = [path for path in settings.get("repositories", {}) if Path(path).is_dir()]
    return {"repositories": sorted(paths)}


@app.post("/api/remove_repository")
def remove_repository(request: RepositoryRequest) -> dict:
    root = repository_root(request.library_path)
    with SETTINGS_LOCK:
        settings_file = get_settings_file()
        settings = load_settings(settings_file)
        repositories = settings.setdefault("repositories", {})
        repositories.pop(str(root), None)
        save_settings(settings_file, settings)
    return {"status": "success", "removed": str(root)}


@app.post("/api/repository_structure")
def repository_structure(request: RepositoryRequest) -> dict:
    root = repository_root(request.library_path)
    try:
        entries, git_repo = list_repository_entries(root, request.show_ignored)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    settings = load_settings(get_settings_file())
    config = settings.get("repositories", {}).get(str(root), {})
    legacy_config = load_legacy_ignore_config(root)
    remember_repository(root, show_ignored=request.show_ignored)
    return {
        "files": entries_to_tree(entries),
        "selected_files": config.get("selected_files") or legacy_config.get("selected_files", []),
        "is_git_repository": git_repo,
        "git_root": str(root) if git_repo else "",
    }


@app.post("/api/repository_context")
def repository_context(request: ContextRequest) -> dict:
    root = repository_root(request.library_path)
    context, file_count, reference_file_count = build_context(root, request.selected_files, request.reference_files)
    remember_repository(root, selected_files=request.selected_files or [])
    return {"context": context, "file_count": file_count, "reference_file_count": reference_file_count}


@app.post("/api/reference_modules")
def reference_modules(request: ReferenceRequest) -> dict:
    root = repository_root(request.library_path)
    settings = load_settings(get_settings_file())
    config = settings.get("repositories", {}).get(str(root), {})
    manual_references = config.get("manual_references", {})
    if not isinstance(manual_references, dict):
        manual_references = {}
    manual_references = {
        str(module): str(path) for module, path in manual_references.items()
        if str(module).strip() and str(path).strip()
    }
    try:
        return discover_reference_modules(root, request.selected_files, request.python_mode, manual_references)
    except (OSError, subprocess.SubprocessError) as exc:
        # Optional discovery must not block the main repository workflow.
        return {
            "enabled": request.python_mode != "embedded",
            "repositories": [],
            "unresolved": [],
            "manual_references": manual_references,
            "warnings": [f"参照リポジトリを自動解析できませんでした: {exc}"],
        }


@app.post("/api/save_reference_mapping")
def save_reference_mapping(request: ReferenceMappingRequest) -> dict:
    root = repository_root(request.library_path)
    reference_root = repository_root(request.repository_path)
    module = request.module.strip()
    if not module:
        raise HTTPException(status_code=400, detail="未解決モジュールが指定されていません。")
    if reference_root == root:
        raise HTTPException(status_code=400, detail="メインリポジトリは参照先に指定できません。")
    with SETTINGS_LOCK:
        settings_file = get_settings_file()
        settings = load_settings(settings_file)
        config = settings.setdefault("repositories", {}).setdefault(str(root), {})
        mappings = config.get("manual_references")
        if not isinstance(mappings, dict):
            mappings = {}
            config["manual_references"] = mappings
        mappings[module] = str(reference_root)
        save_settings(settings_file, settings)
    return {"status": "success", "module": module, "repository_path": str(reference_root)}


@app.post("/api/remove_reference_mapping")
def remove_reference_mapping(request: ReferenceMappingRequest) -> dict:
    root = repository_root(request.library_path)
    with SETTINGS_LOCK:
        settings_file = get_settings_file()
        settings = load_settings(settings_file)
        config = settings.setdefault("repositories", {}).setdefault(str(root), {})
        mappings = config.get("manual_references")
        if not isinstance(mappings, dict):
            mappings = {}
            config["manual_references"] = mappings
        mappings.pop(request.module.strip(), None)
        save_settings(settings_file, settings)
    return {"status": "success"}


@app.post("/api/save_settings")
def save_repository_settings(request: SettingsRequest) -> dict:
    root = repository_root(request.library_path)
    remember_repository(root, request.selected_files, request.show_ignored)
    return {"status": "success"}


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


@app.post("/api/ignore_patterns")
def ignore_patterns(request: RepositoryRequest) -> dict:
    root = repository_root(request.library_path)
    patterns, config_file = load_ignore_patterns(root)
    return {"patterns": patterns, "config_file": config_file}


@app.post("/api/save_ignore_patterns")
def save_repository_ignore_patterns(request: IgnorePatternsRequest) -> dict:
    root = repository_root(request.library_path)
    patterns = normalize_ignore_patterns(request.patterns)
    try:
        config_file = save_ignore_patterns(root, patterns)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"無視リストを保存できませんでした: {exc}") from exc
    return {"status": "success", "patterns": patterns, "config_file": config_file}


@app.post("/api/remove_ignore_pattern")
def remove_repository_ignore_pattern(request: IgnorePatternRemoveRequest) -> dict:
    root = repository_root(request.library_path)
    target = request.path.replace("\\", "/").strip("/")
    if not target:
        raise HTTPException(status_code=400, detail="除外するパスが指定されていません。")
    patterns, config_file = load_ignore_patterns(root)
    matching = [pattern for pattern in patterns if _legacy_excluded(target, [pattern])[0]]
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


@app.post("/api/file_content")
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


@app.post("/api/dependency_map")
def dependency_map(request: RepositoryRequest) -> dict:
    return build_dependency_map(repository_root(request.library_path))


@app.post("/api/patch/preview")
def patch_preview(request: PatchRequest) -> dict:
    return prepare_preview(repository_root(request.library_path), request.ai_output, request.overrides, request.target_path)


@app.post("/api/patch/apply")
def patch_apply(request: PatchRequest) -> dict:
    root = repository_root(request.library_path)
    preview = prepare_preview(root, request.ai_output, request.overrides, request.target_path)
    return apply_preview(root, preview)


@app.post("/api/test")
def run_test(request: TestRequest) -> dict:
    root = repository_root(request.library_path)
    resolved_command = resolve_test_command(root, request.test_command, request.python_mode, request.embedded_python_dir)
    env = _environment(root, request.python_mode, request.embedded_python_dir)
    try:
        result = subprocess.run(resolved_command, cwd=root, env=env, shell=True, capture_output=True, text=False, timeout=300)
        return {
            "status": "success" if result.returncode == 0 else "failed",
            "exit_code": result.returncode,
            "stdout": decode_process_output(result.stdout),
            "stderr": decode_process_output(result.stderr),
            "resolved_command": resolved_command,
        }
    except subprocess.TimeoutExpired as exc:
        return {"status": "failed", "exit_code": None, "stdout": decode_process_output(exc.stdout), "stderr": "テストが300秒でタイムアウトしました。"}


@app.post("/api/feedback_context")
def feedback_context(request: FeedbackRequest) -> dict:
    root = repository_root(request.library_path)
    safe_output = request.output.replace("]]>", "]]]]><![CDATA[>")
    context = f"""<test_feedback>
<repository>{html_escape(str(root))}</repository>
<test_command>{html_escape(request.test_command)}</test_command>
<exit_code>{request.exit_code}</exit_code>
<test_output><![CDATA[
{safe_output}
]]></test_output>
<request>上記の失敗原因を特定し、必要最小限の修正を行ってください。</request>
</test_feedback>"""
    return {"context": context}


@app.post("/api/git_diff")
def git_diff(request: GitDiffRequest) -> dict:
    root = repository_root(request.library_path)
    if not is_git_repository(root):
        raise HTTPException(status_code=400, detail="Gitリポジトリではありません。")
    cmd = request.command.strip() if request.command and request.command.strip() else "git diff HEAD -- *.py"
    if not cmd.startswith("git ") and cmd != "git":
        raise HTTPException(status_code=400, detail="gitコマンドのみ実行可能です。")
    try:
        result = subprocess.run(cmd, cwd=root, shell=True, capture_output=True, text=False, timeout=60)
        if result.returncode != 0:
            stderr = decode_process_output(result.stderr)
            raise HTTPException(status_code=400, detail=f"Gitコマンドが失敗しました: {stderr}")
        return {
            "status": "success",
            "diff": decode_process_output(result.stdout),
            "command": cmd,
        }
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=408, detail="Gitコマンドが60秒でタイムアウトしました。") from exc


@app.post("/api/git_init")
def git_init(request: OpenRequest) -> dict:
    root = repository_root(request.library_path)
    if is_git_repository(root): return {"status": "success", "message": "すでにGitリポジトリです。"}
    result = subprocess.run(["git", "-C", str(root), "init"], capture_output=True, text=False)
    return {"status": "success" if result.returncode == 0 else "error", "message": decode_process_output(result.stdout or result.stderr)}


@app.post("/api/open_in_code")
def open_in_code(request: OpenRequest) -> dict:
    root = repository_root(request.library_path)
    command = shutil.which("code")
    try:
        if command:
            subprocess.Popen([command, str(root)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif sys_platform() == "darwin" and Path("/Applications/Visual Studio Code.app").exists():
            subprocess.Popen(["open", "-a", "Visual Studio Code", str(root)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            return {"status": "error", "message": "VS Codeのcodeコマンドが見つかりません。"}
        return {"status": "success", "message": "VS Codeで開きました。"}
    except OSError as exc:
        return {"status": "error", "message": str(exc)}


def sys_platform() -> str:
    import sys
    return sys.platform


DIST = ROOT / "frontend" / "dist"
if DIST.exists():
    @app.get("/map")
    def map_page():
        return FileResponse(DIST / "index.html")

    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")
