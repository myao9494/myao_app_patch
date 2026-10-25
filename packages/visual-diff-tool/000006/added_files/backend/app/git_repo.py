"""
Gitリポジトリ操作（変更ファイル一覧・HEAD側Blobの取得・パス検証）。

Windowsではプロセス起動とファイル走査が桁違いに遅いため、次の方針で git の起動回数を減らしている。
- リポジトリルートは `.git` を親方向に探して判定し、見つからない場合だけ `rev-parse` を起動する
- HEAD側Blobは `cat-file blob` を1回だけ起動し、上限+1バイトで読み切りを打ち切る
- 複数Blobを読む処理は `cat-file --batch` の常駐1プロセス（GitBlobBatch）に集約する
- Git for Windows のランチャー `cmd\\git.exe` を避けて実体を直接起動する（VISUAL_DIFF_GIT_EXE で指定可）
- `--no-optional-locks` で読み取り時に index を書き換えない
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
from pathlib import Path

from fastapi import HTTPException

from .text_diff import EXCALIDRAW_PLUGIN_MARKER_RE

IMAGE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".bmp",
    ".gif",
    ".tif",
    ".tiff",
    ".svg",
    ".pdf",
    ".excalidraw",
}
STEP_EXTENSIONS = {".step", ".stp"}
EXCALIDRAW_MARKDOWN_SUFFIXES = (".excalidraw.md", "_excalidraw.md")
DEFAULT_TEXT_EXTENSIONS = {".md", ".txt", ".csv", ".json", ".yaml", ".yml"}
EXTENSION_RE = re.compile(r"^\.[a-z0-9][a-z0-9._+-]{0,15}$")
DUBIOUS_OWNERSHIP_RE = re.compile(r"detected dubious ownership in repository at '([^']+)'")
GIT_PATHSPEC_CHUNK_CHARS = 8_000


def payload_folder(payload: dict) -> Path:
    folder, _ = payload_git_scope(payload)
    return folder


def payload_git_scope(payload: dict) -> tuple[Path, str | None]:
    raw_folder = str(payload.get("folder") or "").strip()
    if not raw_folder:
        raise HTTPException(status_code=422, detail="folder is required")
    folder = Path(raw_folder).expanduser()
    try:
        folder = folder.resolve(strict=True)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Folder or Markdown file not found") from exc
    if folder.is_dir():
        return folder, None
    if folder.is_file() and folder.suffix.lower() == ".md":
        return folder.parent, str(folder)
    raise HTTPException(status_code=422, detail="folder must be a directory or a Markdown file")


def find_repo_root_from_filesystem(folder: Path) -> Path | None:
    """`.git` を親方向に探してリポジトリルートを求める（git起動なし）。

    すべてのGit系APIは冒頭で `rev-parse --show-toplevel` を起動していたため、
    Windowsでは毎回数百msを失っていた。通常のリポジトリ・worktree・submoduleは
    いずれも作業ツリー直下に `.git`（ディレクトリまたはファイル）を持つ。
    """
    if ".git" in folder.parts:
        return None
    for candidate in (folder, *folder.parents):
        try:
            if (candidate / ".git").exists():
                return candidate
        except OSError:
            return None
    return None


def git_repo_root(folder: Path) -> Path:
    fast_root = find_repo_root_from_filesystem(Path(folder))
    if fast_root is not None:
        return fast_root.resolve()
    try:
        completed = run_git_process(
            folder,
            ["rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except subprocess.CalledProcessError as exc:
        if _is_dubious_ownership_error(exc):
            safe_directory = _safe_directory_from_error(exc, folder)
            try:
                completed = run_git_process(
                    folder,
                    ["rev-parse", "--show-toplevel"],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=10,
                    safe_directory=safe_directory,
                )
            except subprocess.CalledProcessError as retry_exc:
                raise HTTPException(status_code=422, detail=retry_exc.stderr.strip() or "指定フォルダはgitリポジトリではありません") from retry_exc
        else:
            raise HTTPException(status_code=422, detail="指定フォルダはgitリポジトリではありません") from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="git repository check timed out") from exc
    output = completed.stdout or ""
    if not output.strip():
        raise HTTPException(status_code=422, detail="git repository root could not be determined")
    return Path(output.strip()).resolve()


def changed_image_files(repo: Path, folder: Path, specific_paths: set[str] | list[str] | None = None) -> list[dict]:
    images = []
    for item in changed_files(repo, folder, set(), specific_paths=specific_paths):
        if item["kind"] != "image":
            continue
        comparable = item["diffable"]
        images.append(
            {
                **item,
                "comparable": comparable,
                "reason": None if comparable else "HEAD側または作業フォルダ側の画像がないため比較できません",
            }
        )
    return images


def changed_files(
    repo: Path,
    folder: Path,
    text_extensions: set[str],
    specific_paths: set[str] | list[str] | None = None,
) -> list[dict]:
    if specific_paths is not None:
        valid_paths = sorted(p for p in specific_paths if p)
        if not valid_paths:
            return []
        # Windows のコマンドライン長上限（約32,000文字）を超えないよう、パス指定を分割して実行する。
        output = "".join(
            git_output(["status", "--porcelain=v1", "-z", "--", *chunk], repo)
            for chunk in chunk_paths_by_length(valid_paths, GIT_PATHSPEC_CHUNK_CHARS)
        )
    else:
        output = git_output(["status", "--porcelain=v1", "-z", "--", str(folder)], repo)
    entries = [item for item in output.split("\0") if item]
    files = []
    i = 0
    while i < len(entries):
        entry = entries[i]
        status = entry[:2]
        path = entry[3:]
        head_path = path
        if status.startswith("R") or status.startswith("C"):
            i += 1
            if i < len(entries):
                head_path = entries[i]
        i += 1
        kind = git_file_kind(path, text_extensions)
        if kind is None:
            continue
        has_head = "?" not in status and "A" not in status
        has_current = "D" not in status
        if "?" in status:
            change_type = "untracked"
        elif "R" in status:
            change_type = "renamed"
        elif "C" in status:
            change_type = "copied"
        elif not has_head:
            change_type = "added"
        elif not has_current:
            change_type = "deleted"
        else:
            change_type = "modified"
        files.append(
            {
                "path": path,
                "head_path": head_path,
                "status": status.strip() or "M",
                "kind": kind,
                "change_type": change_type,
                "has_head": has_head,
                "has_current": has_current,
                "diffable": has_head and has_current,
                "comparable": True,
                "reason": None,
                "embedded_excalidraw": has_embedded_excalidraw(
                    repo,
                    path,
                    head_path,
                    has_head=has_head,
                    has_current=has_current,
                )
                if kind == "text"
                else False,
            }
        )
    return files


def chunk_paths_by_length(paths: list[str], max_chars: int) -> list[list[str]]:
    chunks: list[list[str]] = []
    current: list[str] = []
    length = 0
    for path in paths:
        if current and length + len(path) + 1 > max_chars:
            chunks.append(current)
            current, length = [], 0
        current.append(path)
        length += len(path) + 1
    if current:
        chunks.append(current)
    return chunks


def safe_git_path(repo: Path, path: str, *, restrict_to_images: bool = True) -> str:
    rel = Path(path)
    if rel.is_absolute() or ".." in rel.parts:
        raise HTTPException(status_code=422, detail="path must be a repository-relative path")
    resolved = (repo / rel).resolve()
    if repo != resolved and repo not in resolved.parents:
        raise HTTPException(status_code=422, detail="path is outside repository")
    if restrict_to_images and not is_git_image_path(rel.as_posix()):
        raise HTTPException(status_code=422, detail="path is not a supported image file")
    return rel.as_posix()


def is_git_image_path(path: str) -> bool:
    lower_path = path.lower()
    return lower_path.endswith(EXCALIDRAW_MARKDOWN_SUFFIXES) or Path(lower_path).suffix in IMAGE_EXTENSIONS


def is_git_3d_path(path: str) -> bool:
    return Path(path.lower()).suffix in STEP_EXTENSIONS


def git_file_kind(path: str, text_extensions: set[str]) -> str | None:
    if is_git_image_path(path):
        return "image"
    if is_git_3d_path(path):
        return "3d"
    return "text" if Path(path).suffix.lower() in text_extensions else None


def has_embedded_excalidraw(
    repo: Path,
    current_rel_path: str,
    head_rel_path: str,
    *,
    has_head: bool,
    has_current: bool,
) -> bool:
    """Return whether either side of a Markdown diff contains an Excalidraw block."""
    lower_path = current_rel_path.lower()
    if not lower_path.endswith(".md"):
        return False
    if lower_path.endswith(EXCALIDRAW_MARKDOWN_SUFFIXES):
        return True

    # 作業コピー（ローカルファイル）が存在する場合、高速にローカル内容を先頭サンプリングして判定
    current_path = repo / current_rel_path
    if has_current and current_path.is_file():
        try:
            with open(current_path, "rb") as f:
                sample = f.read(65536)
            if EXCALIDRAW_PLUGIN_MARKER_RE.search(sample.decode("utf-8", errors="ignore")):
                return True
        except OSError:
            pass
        # ローカルファイルが存在する場合、全件一覧作成時に不要な git show を同期実行しない
        return False

    # 作業コピーがない（削除された）場合のみ、HEAD 側を確認
    if has_head and not has_current:
        try:
            sample = git_show(repo, head_rel_path, max_bytes=65536)
            return bool(EXCALIDRAW_PLUGIN_MARKER_RE.search(sample.decode("utf-8", errors="ignore")))
        except HTTPException:
            pass
    return False


def text_extensions_from_payload(payload: dict) -> set[str]:
    raw = payload.get("text_extensions")
    if raw is None:
        return set(DEFAULT_TEXT_EXTENSIONS)
    if not isinstance(raw, list) or len(raw) > 50:
        raise HTTPException(status_code=422, detail="text_extensions must be a list of at most 50 extensions")
    result = set()
    for item in raw:
        extension = str(item).strip().lower()
        if extension and not extension.startswith("."):
            extension = f".{extension}"
        if not EXTENSION_RE.fullmatch(extension):
            raise HTTPException(status_code=422, detail=f"invalid text extension: {item}")
        if extension not in IMAGE_EXTENSIONS:
            result.add(extension)
    return result


def git_show(repo: Path, rel_path: str, *, max_bytes: int | None = None) -> bytes:
    """HEAD側のBlobを1回のgit起動で読み出す。

    以前はサイズ確認の `cat-file -s` と `show` で2プロセス起動していた。Windowsは
    プロセス起動が重いため、1プロセスで読みつつ上限超過時点で打ち切る。
    """
    command = git_command(repo, ["cat-file", "blob", f"HEAD:{rel_path}"], safe_directory=repo)
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError as exc:
        raise HTTPException(status_code=404, detail=f"HEAD側の画像を取得できません: {rel_path}") from exc

    # 読み出しが滞った場合に備え、既存の timeout=20 と同じ時間で強制終了する。
    timed_out = threading.Event()

    def _kill_on_timeout() -> None:
        timed_out.set()
        process.kill()

    timer = threading.Timer(20, _kill_on_timeout)
    timer.start()
    oversized = False
    try:
        if max_bytes is None:
            content = process.stdout.read()
        else:
            content = process.stdout.read(max_bytes + 1)
            oversized = len(content) > max_bytes
            if oversized:
                process.kill()
    finally:
        timer.cancel()
        process.stdout.close()
        returncode = process.wait()
    if oversized:
        raise HTTPException(status_code=413, detail=f"HEAD:{rel_path} exceeds {max_bytes // (1024 * 1024)} MB")
    if timed_out.is_set():
        raise HTTPException(status_code=504, detail="git show timed out")
    if returncode != 0:
        raise HTTPException(status_code=404, detail=f"HEAD側の画像を取得できません: {rel_path}")
    return content


class GitBlobBatch:
    """`git cat-file --batch` を1プロセスだけ起動し、複数のHEAD Blobを連続で読む。

    Markdownのリンクを辿るときはノート数だけ `git show` を起動していたが、
    Windowsでは1起動あたり数十〜数百msかかるため、常駐1プロセスに集約する。
    起動できない環境では従来どおり `git_show` へフォールバックする。
    """

    def __init__(self, repo: Path) -> None:
        self.repo = repo
        self._process: subprocess.Popen | None = None

    def __enter__(self) -> "GitBlobBatch":
        try:
            self._process = subprocess.Popen(
                git_command(self.repo, ["cat-file", "--batch"], safe_directory=self.repo),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except OSError:
            self._process = None
        return self

    def __exit__(self, *exc_info) -> None:
        process, self._process = self._process, None
        if process is not None:
            self._close(process)

    @staticmethod
    def _close(process: subprocess.Popen, *, kill: bool = False) -> None:
        if kill:
            try:
                process.kill()
            except OSError:
                pass
        for stream in (process.stdin, process.stdout):
            try:
                if stream is not None:
                    stream.close()
            except OSError:
                pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()

    def read(self, rel_path: str, max_bytes: int) -> bytes | None:
        """HEADにBlobがあれば内容を返す。無い・上限超過なら None。"""
        process = self._process
        if process is None:
            try:
                return git_show(self.repo, rel_path, max_bytes=max_bytes)
            except HTTPException:
                return None
        if "\n" in rel_path:
            return None
        try:
            process.stdin.write(f"HEAD:{rel_path}\n".encode("utf-8"))
            process.stdin.flush()
            header = process.stdout.readline().decode("utf-8", errors="replace").split()
            if len(header) != 3 or header[1] != "blob":
                if len(header) == 3:
                    # tree/commit 等: 本文を読み捨てて同期を保つ
                    self._discard(process, int(header[2]) + 1)
                return None
            size = int(header[2])
            if size > max_bytes:
                self._discard(process, size + 1)
                return None
            data = self._read_exact(process, size + 1)
            return data[:-1]
        except (OSError, ValueError):
            # パイプが壊れた場合は以降を単発起動へ切り替える。
            self._process = None
            self._close(process, kill=True)
            try:
                return git_show(self.repo, rel_path, max_bytes=max_bytes)
            except HTTPException:
                return None

    @staticmethod
    def _read_exact(process: subprocess.Popen, count: int) -> bytes:
        chunks = []
        remaining = count
        while remaining > 0:
            chunk = process.stdout.read(min(remaining, 1024 * 1024))
            if not chunk:
                raise OSError("git cat-file --batch closed unexpectedly")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _discard(self, process: subprocess.Popen, count: int) -> None:
        remaining = count
        while remaining > 0:
            chunk = process.stdout.read(min(remaining, 1024 * 1024))
            if not chunk:
                raise OSError("git cat-file --batch closed unexpectedly")
            remaining -= len(chunk)


def git_output(args: list[str], repo: Path) -> str:
    try:
        completed = run_git_process(
            repo,
            args,
            check=True,
            capture_output=True,
            text=True,
            timeout=20,
            safe_directory=repo,
        )
    except subprocess.CalledProcessError as exc:
        raise HTTPException(status_code=422, detail=exc.stderr.strip() or "git command failed") from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="git command timed out") from exc
    # A subprocess reader can leave stdout as None after an interrupted/failed
    # read. Keep callers such as changed_image_files safe from a secondary
    # AttributeError while still treating the command as having no output.
    return completed.stdout or ""


def run_git_process(
    cwd: Path,
    args: list[str],
    *,
    safe_directory: Path | str | None = None,
    **kwargs,
) -> subprocess.CompletedProcess:
    # Git emits machine-readable text (including -z status output) as UTF-8.
    # Do not let subprocess choose the Windows locale encoding (often CP932).
    if kwargs.get("text") or kwargs.get("universal_newlines"):
        kwargs.setdefault("encoding", "utf-8")
    return subprocess.run(git_command(cwd, args, safe_directory=safe_directory), **kwargs)


_GIT_EXECUTABLE: str | None = None


def resolve_git_executable() -> str:
    """起動するgit実行ファイルを決める（結果はプロセス内でキャッシュ）。

    Git for Windows の PATH 上の `cmd\\git.exe` は `mingw64\\bin\\git.exe` を再度起動する
    ランチャーで、1回のgit呼び出しごとにプロセスが2つ生成される。実体を直接指定して
    起動コストを半減させる。見つからない・動作確認できない場合は "git" を使う。
    `VISUAL_DIFF_GIT_EXE` で明示指定も可能。
    """
    global _GIT_EXECUTABLE
    if _GIT_EXECUTABLE is not None:
        return _GIT_EXECUTABLE
    candidate = os.environ.get("VISUAL_DIFF_GIT_EXE", "").strip()
    if not candidate and os.name == "nt":
        found = shutil.which("git")
        if found:
            launcher = Path(found)
            if launcher.parent.name.lower() == "cmd":
                real = launcher.parent.parent / "mingw64" / "bin" / "git.exe"
                if real.is_file():
                    candidate = str(real)
    if candidate:
        try:
            probe = subprocess.run([candidate, "--version"], capture_output=True, timeout=10)
            if probe.returncode == 0:
                _GIT_EXECUTABLE = candidate
                return candidate
        except (OSError, subprocess.SubprocessError):
            pass
    _GIT_EXECUTABLE = "git"
    return _GIT_EXECUTABLE


def git_command(cwd: Path | str, args: list[str], *, safe_directory: Path | str | None = None) -> list[str]:
    # --no-optional-locks: 読み取り専用の操作でindexを書き換えず、他のgit/エディタ連携と競合しない。
    # core.preloadindex / core.fscache: Windowsでのindex・ファイル状態の読み込みを並列化・キャッシュする。
    command = [
        resolve_git_executable(),
        "--no-optional-locks",
        "-c", "core.quotepath=false",
        "-c", "core.preloadindex=true",
        "-c", "core.fscache=true",
    ]
    if safe_directory is not None:
        command.extend(["-c", f"safe.directory={Path(safe_directory).resolve().as_posix()}"])
    command.extend(["-C", str(cwd), *args])
    return command


def _is_dubious_ownership_error(exc: subprocess.CalledProcessError) -> bool:
    return "dubious ownership" in (exc.stderr or "")


def _safe_directory_from_error(exc: subprocess.CalledProcessError, fallback: Path) -> Path:
    match = DUBIOUS_OWNERSHIP_RE.search(exc.stderr or "")
    if match:
        return Path(match.group(1)).resolve()
    return fallback.resolve()
