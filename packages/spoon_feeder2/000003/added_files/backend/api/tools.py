"""テスト実行・テスト結果のフィードバック・Git操作・エディタ起動API (tools.py)"""

from __future__ import annotations

import shutil
import subprocess
import sys
from html import escape as html_escape
from pathlib import Path

from fastapi import APIRouter, HTTPException

from ..repository import decode_process_output, is_git_repository
from ..runner import resolve_test_command, run_shell_command
from ..security import DEFAULT_GIT_DIFF_COMMAND, UnsafeCommandError, parse_git_command
from ..terminal import build_environment
from .deps import repository_root
from .schemas import FeedbackRequest, GitDiffRequest, OpenRequest, RunTestRequest

router = APIRouter()


@router.post("/test")
def run_test(request: RunTestRequest) -> dict:
    root = repository_root(request.library_path)
    resolved_command = resolve_test_command(root, request.test_command, request.python_mode, request.embedded_python_dir)
    env = build_environment(root, request.python_mode, request.embedded_python_dir)
    exit_code, stdout, stderr = run_shell_command(resolved_command, root, env, request.timeout_sec)
    if exit_code is None:
        return {
            "status": "failed", "exit_code": None,
            "stdout": decode_process_output(stdout), "stderr": f"テストが{request.timeout_sec}秒でタイムアウトしました。",
            "resolved_command": resolved_command,
        }
    return {
        "status": "success" if exit_code == 0 else "failed",
        "exit_code": exit_code,
        "stdout": decode_process_output(stdout),
        "stderr": decode_process_output(stderr),
        "resolved_command": resolved_command,
    }


@router.post("/feedback_context")
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


@router.post("/git_diff")
def git_diff(request: GitDiffRequest) -> dict:
    root = repository_root(request.library_path)
    if not is_git_repository(root):
        raise HTTPException(status_code=400, detail="Gitリポジトリではありません。")
    cmd = request.command.strip() if request.command and request.command.strip() else DEFAULT_GIT_DIFF_COMMAND
    try:
        args = parse_git_command(cmd)
    except UnsafeCommandError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        result = subprocess.run(args, cwd=root, shell=False, capture_output=True, text=False, timeout=60)
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=408, detail="Gitコマンドが60秒でタイムアウトしました。") from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail="gitコマンドが見つかりません。") from exc
    if result.returncode != 0:
        raise HTTPException(status_code=400, detail=f"Gitコマンドが失敗しました: {decode_process_output(result.stderr)}")
    return {"status": "success", "diff": decode_process_output(result.stdout), "command": cmd}


@router.post("/git_init")
def git_init(request: OpenRequest) -> dict:
    root = repository_root(request.library_path)
    if is_git_repository(root):
        return {"status": "success", "message": "すでにGitリポジトリです。"}
    result = subprocess.run(["git", "-C", str(root), "init"], capture_output=True, text=False)
    return {"status": "success" if result.returncode == 0 else "error", "message": decode_process_output(result.stdout or result.stderr)}


@router.post("/open_in_code")
def open_in_code(request: OpenRequest) -> dict:
    root = repository_root(request.library_path)
    command = shutil.which("code")
    try:
        if command:
            subprocess.Popen([command, str(root)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif sys.platform == "darwin" and Path("/Applications/Visual Studio Code.app").exists():
            subprocess.Popen(["open", "-a", "Visual Studio Code", str(root)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            return {"status": "error", "message": "VS Codeのcodeコマンドが見つかりません。"}
        return {"status": "success", "message": "VS Codeで開きました。"}
    except OSError as exc:
        return {"status": "error", "message": str(exc)}
