"""
ファイル/フォルダの移動・コピー処理（同期・非同期共通の実装）

安全のための原則（ファイルが勝手に消えないこと）:
1. 移動先に同名の項目があり上書き指定がない場合は、何も変更せず
   「同名のファイルが存在します」エラーを返す（フロントエンドが上書き確認を出す）。
2. 同一ボリューム内で移動先が空いている場合は os.rename で一瞬で移動する（データのコピーなし）。
3. それ以外の移動は「全ファイルをコピー → 1件ずつサイズ（指定時はSHA256）検証 →
   移動元の全ファイルがコピー済みであることを再確認 → 移動元を削除」の順で行う。
   途中で1件でも失敗・キャンセルした場合、移動元は一切削除しない。
4. 上書きを指示された場合、置き換えられる既存ファイルはゴミ箱へ退避する
   （ゴミ箱のないネットワークドライブ上のみ完全削除）。フォルダ同士は統合（マージ）し、
   移動先にしかないファイルは残す。
5. 移動元と移動先が同じ場合は何もしない（移動: skipped / コピー: エラー）。

結果は項目（ルート）単位で返す:
    {"status": "completed", "success_count", "fail_count",
     "results": [{"path": 元パス, "dest": 移動先パス, "status": "success"|"error"|"skipped", "message"}]}
"""
from __future__ import annotations

import ctypes
import hashlib
import os
import platform
import shutil
import threading
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Optional

from app.services.paths import is_within, normalize_path
from app.services.trash import (
    clear_windows_readonly,
    is_network_path,
    remove_tree_quietly,
    rmtree,
    trash_with_retry,
)
from app.task_manager import task_manager

TransferMode = Literal["move", "copy"]

# 並列コピーのワーカー数（I/O待ちを埋めるためCPUコア数の8倍、最大64）
MAX_WORKERS = min(64, (os.cpu_count() or 4) * 8)
# 同時に投入するコピー数の上限（巨大フォルダでもメモリを使いすぎない）
MAX_PENDING_COPIES = MAX_WORKERS * 4

CONFLICT_MESSAGE = "同名のファイルが存在します"
CANCELLED_MESSAGE = "キャンセルされました"


class TransferError(Exception):
    """利用者に表示するメッセージ付きの移動/コピー失敗"""


# ---------------------------------------------------------
# 高速コピー
# ---------------------------------------------------------
def fast_copy_file(src: Path, dest: Path) -> bool:
    """
    プラットフォーム固有の最適化を使用した高速ファイルコピー（既存の dest は上書き）

    - macOS (APFS): clonefile システムコール（Copy-on-Write、瞬時）
    - Windows: CopyFileW Win32 API（ネイティブコピー）
    - Linux: sendfile システムコール（ゼロコピー）

    エラー時は shutil.copy2 にフォールバックする。

    Raises:
        FileNotFoundError: ソースファイルが存在しない場合
    """
    if not src.exists():
        raise FileNotFoundError(f"Source file not found: {src}")

    system = platform.system()
    try:
        if system == "Darwin":
            return _fast_copy_macos(src, dest)
        if system == "Windows":
            return _fast_copy_windows(src, dest)
        if system == "Linux":
            return _fast_copy_linux(src, dest)
    except Exception:
        pass
    shutil.copy2(str(src), str(dest))
    return True


def _fast_copy_macos(src: Path, dest: Path) -> bool:
    """macOS専用: clonefile（APFSのCopy-on-Write）でコピーする"""
    libc = ctypes.CDLL("/usr/lib/libc.dylib", use_errno=True)
    if os.path.lexists(dest):
        # clonefile は既存ファイルへ上書きできないため、従来の上書き挙動に合わせてコピーで処理する
        shutil.copy2(str(src), str(dest))
        return True
    result = libc.clonefile(str(src).encode("utf-8"), str(dest).encode("utf-8"), 0)
    if result == 0:
        src_stat = src.stat()
        os.utime(dest, (src_stat.st_atime, src_stat.st_mtime))
        return True
    err = ctypes.get_errno()
    # ENOTSUP (45): 非対応FS（HFS+等） / EXDEV (18): 異なるボリューム間
    if err in (45, 18):
        shutil.copy2(str(src), str(dest))
        return True
    raise OSError(err, f"clonefile failed: {os.strerror(err)}")


def _fast_copy_windows(src: Path, dest: Path) -> bool:
    """Windows専用: CopyFileW でコピーする"""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    kernel32.CopyFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_bool]
    kernel32.CopyFileW.restype = ctypes.c_bool
    if not kernel32.CopyFileW(str(src), str(dest), False):
        raise OSError(f"CopyFileW failed with error code: {ctypes.get_last_error()}")  # type: ignore[attr-defined]
    return True


def _fast_copy_linux(src: Path, dest: Path) -> bool:
    """Linux専用: sendfile でカーネル内コピーする"""
    if not hasattr(os, "sendfile"):
        shutil.copy2(str(src), str(dest))
        return True

    src_fd = os.open(str(src), os.O_RDONLY)
    try:
        src_stat = os.fstat(src_fd)
        dest_fd = os.open(str(dest), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, src_stat.st_mode)
        try:
            offset = 0
            while offset < src_stat.st_size:
                sent = os.sendfile(dest_fd, src_fd, offset, src_stat.st_size - offset)
                if sent == 0:
                    break
                offset += sent
        finally:
            os.close(dest_fd)
        os.utime(dest, (src_stat.st_atime, src_stat.st_mtime))
    finally:
        os.close(src_fd)
    return True


def calculate_file_checksum(file_path: Path, chunk_size: int = 1024 * 1024) -> str:
    """ファイルのSHA256チェックサムを計算する"""
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(chunk_size), b""):
            sha256_hash.update(chunk)
    return sha256_hash.hexdigest()


# ---------------------------------------------------------
# 進捗管理
# ---------------------------------------------------------
@dataclass
class _Progress:
    """タスクの進捗（総数はスキャンしながら増える）"""

    task_id: Optional[str]
    total: int = 0
    done: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)

    def add_total(self, count: int) -> None:
        with self.lock:
            self.total += count
            total = self.total
        if self.task_id:
            task_manager.set_total(self.task_id, total)

    def advance(self, name: str) -> None:
        with self.lock:
            self.done += 1
            done = self.done
        if self.task_id:
            task_manager.update_progress(self.task_id, processed_files=done, current_file=name)

    def message(self, text: str) -> None:
        if self.task_id:
            with self.lock:
                done = self.done
            task_manager.update_progress(self.task_id, processed_files=done, current_file=text)

    def cancelled(self) -> bool:
        return bool(self.task_id) and task_manager.is_cancelled(self.task_id)  # type: ignore[arg-type]


# ---------------------------------------------------------
# 内部ヘルパー
# ---------------------------------------------------------
def _same_location(src: Path, dest: Path) -> bool:
    """同じ場所（大文字小文字違い・ハードリンクを含む）を指しているか"""
    try:
        if os.path.lexists(dest):
            return os.path.samefile(src, dest) if not src.is_symlink() else (
                os.path.normcase(os.path.abspath(src)) == os.path.normcase(os.path.abspath(dest))
            )
    except OSError:
        pass
    return os.path.normcase(os.path.abspath(src)) == os.path.normcase(os.path.abspath(dest))


def _is_real_dir(path: Path) -> bool:
    return path.is_dir() and not path.is_symlink()


def discard_existing(path: Path) -> None:
    """
    上書きで置き換えられる既存項目を退避する。
    ローカル: ゴミ箱へ移動（失敗したら例外。勝手に完全削除しない）
    ネットワークドライブ: ゴミ箱が使えないため完全削除（利用者が上書きを確認済み）
    """
    if is_network_path(path):
        if _is_real_dir(path):
            rmtree(path)
        else:
            clear_windows_readonly(path)
            path.unlink()
        return
    trash_with_retry(path)


def _try_rename(src: Path, dest: Path) -> bool:
    """同一ボリュームなら os.rename で移動する。できなければ False（コピー方式へ）。"""
    try:
        if os.stat(src, follow_symlinks=False).st_dev != os.stat(dest.parent).st_dev:
            return False
        if os.path.lexists(dest):
            return False
        os.rename(src, dest)
        return True
    except OSError:
        return False


def _copy_entry(src_file: Path, dest_file: Path, verify_checksum: bool) -> None:
    """1件コピーして検証する。失敗時は作りかけのコピー先を片付けて例外を送出する。"""
    if os.path.lexists(dest_file):
        # 統合（マージ）時に限り到達する。上書き確認済みなので既存項目を退避してから置き換える
        discard_existing(dest_file)

    try:
        if src_file.is_symlink() and not src_file.is_file():
            # フォルダへのリンクやリンク切れはリンクとして再作成する（中身を辿らない）
            os.symlink(os.readlink(src_file), dest_file, target_is_directory=src_file.is_dir())
            return

        fast_copy_file(src_file, dest_file)
        src_size = src_file.stat().st_size
        dest_size = dest_file.stat().st_size
        if src_size != dest_size:
            raise TransferError(f"サイズが一致しません (元: {src_size}, 先: {dest_size})")
        if verify_checksum and calculate_file_checksum(src_file) != calculate_file_checksum(dest_file):
            raise TransferError("チェックサムが一致しません")
    except BaseException:
        if os.path.lexists(dest_file):
            remove_tree_quietly(dest_file)
        raise


def _prepare_dest_dir(dest_dir: Path) -> None:
    """コピー先フォルダを用意する（同名のファイルがあれば上書き確認済みとして退避）"""
    if os.path.lexists(dest_dir) and not _is_real_dir(dest_dir):
        discard_existing(dest_dir)
    dest_dir.mkdir(exist_ok=True)


def _copy_tree(src: Path, dest: Path, verify_checksum: bool, progress: _Progress, label: str) -> None:
    """
    フォルダを並列コピーする（スキャンしながらコピーを開始して待ち時間を短縮）。
    失敗が1件でもあれば TransferError、キャンセル時は CANCELLED_MESSAGE の TransferError。
    """
    errors: list[str] = []
    errors_lock = threading.Lock()

    def worker(src_file: Path, dest_file: Path) -> None:
        if progress.cancelled():
            return
        try:
            _copy_entry(src_file, dest_file, verify_checksum)
        except Exception as e:
            with errors_lock:
                errors.append(f"{src_file.relative_to(src)}: {e}")
        finally:
            progress.advance(f"{label}: {src_file.name}")

    _prepare_dest_dir(dest)
    pending: set[Future] = set()
    with ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="file-transfer") as executor:
        for root, dirs, files in os.walk(src):
            if progress.cancelled():
                break
            root_path = Path(root)
            dest_root = dest / root_path.relative_to(src)

            entries: list[Path] = []
            for name in list(dirs):
                dir_path = root_path / name
                if dir_path.is_symlink():
                    entries.append(dir_path)  # リンクとして再作成する
                    continue
                try:
                    _prepare_dest_dir(dest_root / name)
                except Exception as e:
                    with errors_lock:
                        errors.append(f"{dir_path.relative_to(src)}: {e}")
                    dirs.remove(name)  # 作れなかったフォルダの中身はコピーしない
            entries.extend(root_path / name for name in files)

            progress.add_total(len(entries))
            for entry in entries:
                if len(pending) >= MAX_PENDING_COPIES:
                    _, pending = wait(pending, return_when=FIRST_COMPLETED)
                pending.add(executor.submit(worker, entry, dest_root / entry.name))
        wait(pending)

    if progress.cancelled():
        raise TransferError(CANCELLED_MESSAGE)
    if errors:
        raise TransferError(f"一部のファイルで{label}に失敗しました（{len(errors)}件）: " + " / ".join(errors[:3]))


def _find_uncopied_source_entry(src: Path, dest: Path) -> Optional[str]:
    """移動元の全項目がコピー先に揃っているかを再確認し、欠けている項目の相対パスを返す。"""
    if not _is_real_dir(src):
        if not os.path.lexists(dest):
            return src.name
        if src.is_file() and not src.is_symlink() and src.stat().st_size != dest.stat().st_size:
            return src.name
        return None

    for root, dirs, files in os.walk(src):
        root_path = Path(root)
        dest_root = dest / root_path.relative_to(src)
        for name in files + [d for d in dirs if (root_path / d).is_symlink()]:
            src_entry = root_path / name
            dest_entry = dest_root / name
            if not os.path.lexists(dest_entry):
                return str(src_entry.relative_to(src))
            if src_entry.is_file() and not src_entry.is_symlink():
                if src_entry.stat().st_size != dest_entry.stat().st_size:
                    return str(src_entry.relative_to(src))
        for name in dirs:
            if not os.path.lexists(dest_root / name):
                return str((root_path / name).relative_to(src))
    return None


def _remove_moved_source(src: Path) -> None:
    """コピーと検証が済んだ移動元を削除する"""
    if _is_real_dir(src):
        rmtree(src)
    else:
        clear_windows_readonly(src)
        src.unlink()


# ---------------------------------------------------------
# 公開API
# ---------------------------------------------------------
def transfer_one(
    src: Path,
    final_dest: Path,
    mode: TransferMode,
    overwrite: bool = False,
    verify_checksum: bool = False,
    progress: Optional[_Progress] = None,
) -> tuple[str, str]:
    """
    1項目を移動/コピーする。戻り値は (status, message)。
    失敗時は TransferError（またはOSError）を送出し、移動元は必ず残る。
    """
    progress = progress or _Progress(task_id=None)
    is_move = mode == "move"
    label = "移動" if is_move else "コピー"

    if not os.path.lexists(src):
        raise TransferError("ファイルが見つかりません")

    if _same_location(src, final_dest):
        if is_move:
            return "skipped", "移動元と移動先が同じです"
        raise TransferError("同一ファイルへのコピーはできません")

    src_is_dir = _is_real_dir(src)
    if src_is_dir and is_within(os.path.realpath(final_dest), os.path.realpath(src)):
        raise TransferError(f"自分自身のサブディレクトリには{label}できません")

    dest_exists = os.path.lexists(final_dest)
    if dest_exists and not overwrite:
        raise TransferError(CONFLICT_MESSAGE)

    # 同一ボリュームで移動先が空いていればリネームで一瞬で終わらせる
    if is_move and not dest_exists and _try_rename(src, final_dest):
        progress.add_total(1)
        progress.advance(f"{label}: {src.name}")
        return "success", "移動完了"

    merge = dest_exists and src_is_dir and _is_real_dir(final_dest)
    if dest_exists and not merge:
        progress.message(f"上書き準備: {final_dest.name}")
        discard_existing(final_dest)
    created_dest = not merge

    try:
        if src_is_dir:
            _copy_tree(src, final_dest, verify_checksum, progress, label)
        else:
            progress.add_total(1)
            _copy_entry(src, final_dest, verify_checksum)
            progress.advance(f"{label}: {src.name}")
    except BaseException:
        # 移動の失敗・キャンセル時は、今回新規に作ったコピー先だけを片付ける（移動元は残す）
        if is_move and created_dest:
            remove_tree_quietly(final_dest)
        raise

    if not is_move:
        return "success", "コピー完了"

    missing = _find_uncopied_source_entry(src, final_dest)
    if missing is not None:
        raise TransferError(f"移動中に移動元が変更されたため、移動元を残しました: {missing}")

    progress.message(f"移動元を削除: {src.name}")
    try:
        _remove_moved_source(src)
    except OSError as e:
        raise TransferError(f"コピーは完了しましたが、移動元の削除に失敗しました: {e}")
    return "success", "移動完了"


def transfer_items(
    src_paths: list[str],
    dest_dir: Path,
    mode: TransferMode,
    overwrite: bool = False,
    verify_checksum: bool = False,
    task_id: Optional[str] = None,
    debug_mode: bool = False,
) -> dict:
    """複数項目を dest_dir 配下へ移動/コピーし、項目ごとの結果を返す。"""
    progress = _Progress(task_id=task_id)
    results: list[dict] = []

    for src_str in src_paths:
        entry: dict = {"path": src_str}
        try:
            if progress.cancelled():
                raise TransferError(CANCELLED_MESSAGE)
            src = normalize_path(src_str)
            final_dest = dest_dir / src.name
            entry["dest"] = final_dest.as_posix()
            status, message = transfer_one(src, final_dest, mode, overwrite, verify_checksum, progress)
            entry.update(status=status, message=message)
        except Exception as e:
            entry.update(status="error", message=str(e) or e.__class__.__name__)
        if debug_mode:
            print(f"[TRANSFER:{mode}] {entry}")
        results.append(entry)

    return {
        "status": "completed",
        "success_count": sum(1 for r in results if r["status"] == "success"),
        "fail_count": sum(1 for r in results if r["status"] == "error"),
        "results": results,
    }


def run_transfer_task(
    task_id: str,
    src_paths: list[str],
    dest_dir: Path,
    mode: TransferMode,
    overwrite: bool,
    verify_checksum: bool,
    debug_mode: bool,
) -> None:
    """バックグラウンドスレッドで transfer_items を実行し、結果をタスクへ保存する。"""
    task_manager.set_running(task_id)
    task_manager.set_total(task_id, 0)
    task_manager.update_progress(task_id, processed_files=0, current_file="準備中...")
    try:
        result = transfer_items(src_paths, dest_dir, mode, overwrite, verify_checksum, task_id, debug_mode)
        task_manager.complete_task(task_id, result=result)
    except Exception as e:  # 想定外の例外でもタスクを「実行中」のまま放置しない
        task_manager.fail_task(task_id, str(e))


def start_transfer_task(
    src_paths: list[str],
    dest_dir: Path,
    mode: TransferMode,
    overwrite: bool,
    verify_checksum: bool,
    debug_mode: bool,
) -> str:
    """非同期の移動/コピーを開始してタスクIDを返す。"""
    task = task_manager.create_task(total_files=len(src_paths))
    threading.Thread(
        target=run_transfer_task,
        args=(task.id, src_paths, dest_dir, mode, overwrite, verify_checksum, debug_mode),
        daemon=True,
        name=f"transfer-{task.id[:8]}",
    ).start()
    return task.id

