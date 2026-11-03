"""
Windows の USN Change Journal と ReadDirectoryChangesW を薄く包む変更追跡器。

USN はボリューム単位で停止中の変更も読めるため第一候補にする。ファイル参照番号から
現在のパスを解決できない削除・移動レコードは、対象ボリューム全体を dirty にして既存の
安全な差分走査へ委ねる。USN が利用できない環境（権限不足や非NTFS等）では自動的に
ReadDirectoryChangesW へフォールバックし、全ボリュームがフォールバックされた場合は
USN ポーリングスレッドを停止して無駄なリソース消費を防ぐ。
Windows API 呼び出しは ``WindowsChangeApi`` に閉じ込め、サービス本体はテスト用の偽実装を注入できる。
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import logging
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from sqlite3 import Connection

from app.services import exclude_rules
from app.services.change_relevance import find_targets_affected_by_changes


logger = logging.getLogger(__name__)
ChangeCallback = Callable[[tuple[str, ...]], None]
FSCTL_QUERY_USN_JOURNAL = 0x000900F4
FSCTL_READ_USN_JOURNAL = 0x000900BB
USN_REASON_FILE_DELETE = 0x00000200
USN_REASON_RELEVANT = 0x00000100 | USN_REASON_FILE_DELETE | 0x00001000 | 0x00002000 | 0x00004000 | 0x00008000
# 内容の書き換え（上書き・追記・切り詰め）。書き込みの途中で読まないよう、ファイルが閉じられた記録だけを使う
USN_REASON_DATA_CHANGE = 0x00000001 | 0x00000002 | 0x00000004
USN_REASON_CLOSE = 0x80000000
# パスを解決できない変更で対象を dirty にする最短の間隔（秒）。ボリューム全体の一時ファイルの削除で
# 毎秒 dirty にすると、2 秒の静止を待つ更新がいつまでも始まらず、全対象の走査も繰り返す
UNRESOLVED_CHANGE_DIRTY_INTERVAL_SECONDS = 60.0
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


@dataclass(frozen=True)
class UsnJournalInfo:
    """永続化比較に必要な USN Journal の識別子と次の位置。"""

    journal_id: int
    next_usn: int


@dataclass(frozen=True)
class UsnReadResult:
    """USN 読み取り結果。パス不明の削除等も ``has_relevant_changes`` で保持する。"""

    next_usn: int
    changed_paths: tuple[str, ...] = ()
    has_relevant_changes: bool = True
    has_unresolved_changes: bool = False


def collect_changed_paths(
    raw: bytes, resolve_file_id: Callable[[int], str | None]
) -> tuple[tuple[str, ...], bool, bool]:
    """
    FSCTL_READ_USN_JOURNAL の応答（先頭 8 バイトは次の USN）から、（変更されたパス, 関係する変更があるか,
    パスを解決できない変更があるか）を返す。
    パスは親フォルダとファイル名から作る。削除済みのファイルは自身の ID では開けず、ボリューム全体の記録を
    毎秒読むのでファイルごとに ID を開くと重いため。親を開けないときだけファイル自身の ID を使う。
    同じ ID の解決は 1 回の読み取りで繰り返さない。
    """
    resolved: dict[int, str | None] = {}

    def resolve(file_reference: int) -> str | None:
        if file_reference not in resolved:
            resolved[file_reference] = resolve_file_id(file_reference)
        return resolved[file_reference]

    changed_paths: dict[str, None] = {}
    relevant = False
    unresolved = False
    offset = 8
    while offset + 44 <= len(raw):
        record_length = int.from_bytes(raw[offset:offset + 4], "little")
        if record_length < 60 or offset + record_length > len(raw):
            raise OSError("invalid USN record")
        reason = int.from_bytes(raw[offset + 40:offset + 44], "little")
        is_written = bool(reason & USN_REASON_DATA_CHANGE) and bool(reason & USN_REASON_CLOSE)
        if reason & USN_REASON_RELEVANT or is_written:
            relevant = True
            parent = resolve(int.from_bytes(raw[offset + 16:offset + 24], "little"))
            if parent is not None:
                name_length = int.from_bytes(raw[offset + 56:offset + 58], "little")
                name_offset = int.from_bytes(raw[offset + 58:offset + 60], "little")
                name = raw[offset + name_offset:offset + name_offset + name_length].decode("utf-16-le", errors="replace")
                path: str | None = f"{parent.rstrip(chr(92) + '/')}/{name}"
            else:
                path = resolve(int.from_bytes(raw[offset + 8:offset + 16], "little"))
            if path is None:
                unresolved = True
            else:
                changed_paths[path] = None
        offset += record_length
    return tuple(changed_paths), relevant, unresolved


class WindowsChangeApi:
    """ctypes による Win32 API の最小ラッパー。非 Windows では利用不可を返す。"""

    def __init__(self) -> None:
        self._watch_stop = threading.Event()
        self._watch_threads: list[threading.Thread] = []
        self._watch_handles: list[int] = []

    @staticmethod
    def is_available() -> bool:
        return os.name == "nt"

    def volume_for_path(self, path: str) -> str:
        """NTFS の候補となるローカルドライブのルートを返し、UNC はフォールバックさせる。"""
        resolved = Path(path).resolve()
        drive = resolved.drive
        if not drive or str(resolved).startswith("\\\\"):
            raise OSError("USN is available only for local drive volumes")
        return f"{drive.rstrip(':').upper()}:/"

    def query_journal(self, volume: str) -> UsnJournalInfo:
        """FSCTL_QUERY_USN_JOURNAL から Journal ID と終端 USN を取得する。"""
        handle = self._open_volume(volume)
        try:
            buffer = ctypes.create_string_buffer(56)
            returned = ctypes.c_ulong()
            self._device_io_control(handle, FSCTL_QUERY_USN_JOURNAL, None, 0, buffer, len(buffer), returned)
            journal_id = int.from_bytes(buffer.raw[0:8], "little")
            next_usn = int.from_bytes(buffer.raw[16:24], "little", signed=True)
            return UsnJournalInfo(journal_id=journal_id, next_usn=next_usn)
        finally:
            self._close_handle(handle)

    def read_journal(self, volume: str, journal_id: int, last_usn: int) -> UsnReadResult:
        """保存済み位置以降の USN を読み、作成・更新・削除・移動だけを抽出する。"""
        handle = self._open_volume(volume)
        try:
            input_buffer = ctypes.create_string_buffer(40)
            input_buffer[0:8] = int(last_usn).to_bytes(8, "little", signed=True)
            input_buffer[8:12] = (0xFFFFFFFF).to_bytes(4, "little")
            input_buffer[32:40] = int(journal_id).to_bytes(8, "little")
            output_buffer = ctypes.create_string_buffer(1024 * 1024)
            returned = ctypes.c_ulong()
            self._device_io_control(
                handle, FSCTL_READ_USN_JOURNAL, input_buffer, len(input_buffer), output_buffer, len(output_buffer), returned
            )
            raw = output_buffer.raw[: returned.value]
            if len(raw) < 8:
                raise OSError("USN read returned no cursor")
            next_usn = int.from_bytes(raw[:8], "little", signed=True)
            changed_paths, relevant, unresolved = collect_changed_paths(
                raw, lambda file_reference: self._resolve_file_id(handle, file_reference)
            )
            return UsnReadResult(
                next_usn=next_usn,
                changed_paths=changed_paths,
                has_relevant_changes=relevant,
                has_unresolved_changes=unresolved,
            )
        finally:
            self._close_handle(handle)

    def start_directory_watch(self, paths: tuple[str, ...], callback: ChangeCallback) -> bool:
        """USN 非対応対象を ReadDirectoryChangesW で再帰監視する。"""
        if not self.is_available() or not paths:
            return False
        self._watch_stop.clear()
        for path in paths:
            thread = threading.Thread(target=self._watch_directory, args=(path, callback), daemon=True, name="rdcw-change-tracker")
            thread.start()
            self._watch_threads.append(thread)
        return True

    def stop_directory_watch(self) -> None:
        """ハンドルを閉じてブロッキング中の ReadDirectoryChangesW を解除する。"""
        self._watch_stop.set()
        for handle in self._watch_handles[:]:
            self._close_handle(handle)
        self._watch_handles.clear()
        for thread in self._watch_threads:
            thread.join(timeout=1.0)
        self._watch_threads.clear()

    def _watch_directory(self, path: str, callback: ChangeCallback) -> None:
        kernel32 = self._kernel32()
        handle = kernel32.CreateFileW(path, 0x0001, 0x00000001 | 0x00000002 | 0x00000004, None, 3, 0x02000000, None)
        if self._is_invalid_handle(handle):
            logger.warning(
                "WindowsChangeTracker: ReadDirectoryChangesW のハンドル取得に失敗しました。"
                "path=%s 対象を dirty 化します。",
                path,
            )
            callback((path,))  # 開始不能は安全側で dirty にする。
            return
        logger.info("WindowsChangeTracker: ReadDirectoryChangesW 監視ハンドルを取得しました。path=%s", path)
        self._watch_handles.append(handle)
        try:
            while not self._watch_stop.is_set():
                buffer = ctypes.create_string_buffer(64 * 1024)
                returned = ctypes.c_ulong()
                ok = kernel32.ReadDirectoryChangesW(
                    handle, buffer, len(buffer), True, 0x0000001F, ctypes.byref(returned), None, None
                )
                if not ok or returned.value == 0:
                    logger.warning(
                        "WindowsChangeTracker: ReadDirectoryChangesW の読み取りに失敗またはバッファ溢れ。"
                        "path=%s 対象を dirty 化します。",
                        path,
                    )
                    callback((path,))  # バッファ溢れ/再開失敗は対象を再照合する。
                    return
                offset = 0
                changes: list[str] = []
                while offset + 12 <= returned.value:
                    next_offset = int.from_bytes(buffer.raw[offset:offset + 4], "little")
                    name_length = int.from_bytes(buffer.raw[offset + 8:offset + 12], "little")
                    name = buffer.raw[offset + 12:offset + 12 + name_length].decode("utf-16-le", errors="replace")
                    changes.append(str(Path(path) / name))
                    if next_offset == 0:
                        break
                    offset += next_offset
                if changes:
                    logger.info(
                        "WindowsChangeTracker: ReadDirectoryChangesW が変更を検出しました。"
                        "path=%s 変更数=%d(例: %s)",
                        path,
                        len(changes),
                        changes[0],
                    )
                    callback(tuple(changes))
        finally:
            if handle in self._watch_handles:
                self._watch_handles.remove(handle)
            self._close_handle(handle)
            logger.info("WindowsChangeTracker: ReadDirectoryChangesW 監視を終了しました。path=%s", path)

    def _open_volume(self, volume: str) -> int:
        if not self.is_available():
            raise OSError("Windows API is unavailable")
        handle = self._kernel32().CreateFileW(
            f"\\\\.\\{volume[0]}:", 0x80000000, 0x00000001 | 0x00000002, None, 3, 0, None
        )
        if self._is_invalid_handle(handle):
            raise ctypes.WinError()
        return int(handle)

    @staticmethod
    def _close_handle(handle: int) -> None:
        if os.name == "nt" and not WindowsChangeApi._is_invalid_handle(handle):
            WindowsChangeApi._kernel32().CloseHandle(handle)

    @staticmethod
    def _is_invalid_handle(handle: int | None) -> bool:
        """ctypes が返す符号拡張済み INVALID_HANDLE_VALUE も失敗として扱う。"""
        return handle in (None, 0, -1, INVALID_HANDLE_VALUE)

    @staticmethod
    def _device_io_control(handle, code, in_buffer, in_size, out_buffer, out_size, returned) -> None:
        ok = WindowsChangeApi._kernel32().DeviceIoControl(handle, code, in_buffer, in_size, out_buffer, out_size, ctypes.byref(returned), None)
        if not ok:
            raise ctypes.WinError()

    @staticmethod
    def _resolve_file_id(volume_handle: int, file_reference: int) -> str | None:
        """OpenFileById で解決できる現存パスだけを返す（削除済みは None）。"""
        if os.name != "nt":
            return None
        class FileIdDescriptor(ctypes.Structure):
            # USN の FileReferenceNumber は符号なし64-bit。上位ビットが立つNTFS IDも
            # OpenFileById へそのまま渡せるよう c_ulonglong を使う。
            # FILE_ID_DESCRIPTOR の共用体は GUID 分の 16 バイトある。足りないと OpenFileById は失敗する。
            _fields_ = [
                ("dwSize", ctypes.c_uint32),
                ("Type", ctypes.c_uint32),
                ("FileId", ctypes.c_ulonglong),
                ("Reserved", ctypes.c_ulonglong),
            ]
        descriptor = FileIdDescriptor(ctypes.sizeof(FileIdDescriptor), 0, file_reference, 0)
        kernel32 = WindowsChangeApi._kernel32()
        # 親フォルダも開くので FILE_FLAG_BACKUP_SEMANTICS が要る
        handle = kernel32.OpenFileById(volume_handle, ctypes.byref(descriptor), 0x80, 0x7, None, 0x02000000)
        if WindowsChangeApi._is_invalid_handle(handle):
            return None
        try:
            size = kernel32.GetFinalPathNameByHandleW(handle, None, 0, 0)
            if not size:
                return None
            buffer = ctypes.create_unicode_buffer(size + 1)
            if not kernel32.GetFinalPathNameByHandleW(handle, buffer, len(buffer), 0):
                return None
            return str(buffer.value).removeprefix("\\\\?\\")
        finally:
            kernel32.CloseHandle(handle)

    @staticmethod
    def _kernel32():
        """64-bit HANDLE が切り詰められないよう ctypes の戻り値型を固定する。"""
        kernel32 = ctypes.windll.kernel32
        kernel32.CreateFileW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.HANDLE,
        ]
        kernel32.CreateFileW.restype = wintypes.HANDLE
        kernel32.OpenFileById.argtypes = [
            wintypes.HANDLE,
            wintypes.LPVOID,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.DWORD,
        ]
        kernel32.OpenFileById.restype = wintypes.HANDLE
        kernel32.GetFinalPathNameByHandleW.argtypes = [
            wintypes.HANDLE,
            wintypes.LPWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
        ]
        kernel32.GetFinalPathNameByHandleW.restype = wintypes.DWORD
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.ReadDirectoryChangesW.argtypes = [
            wintypes.HANDLE,
            wintypes.LPVOID,
            wintypes.DWORD,
            wintypes.BOOL,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
            wintypes.LPVOID,
            wintypes.LPVOID,
        ]
        kernel32.ReadDirectoryChangesW.restype = wintypes.BOOL
        kernel32.DeviceIoControl.argtypes = [
            wintypes.HANDLE,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
            wintypes.LPVOID,
        ]
        kernel32.DeviceIoControl.restype = wintypes.BOOL
        return kernel32


class WindowsChangeTracker:
    """USN カーソルをDBに保存し、対象を dirty 化する OS 非依存テスト可能な制御層。"""

    def __init__(
        self,
        connection_factory: Callable[[], Connection],
        *,
        api: WindowsChangeApi | None = None,
        ignored_paths: Callable[[str], bool] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._connection_factory = connection_factory
        self._clock = clock
        # パスを解決できない変更の間引き（ボリューム → 最後に dirty にした時刻、反映待ちのボリューム）
        self._unresolved_dirty_at: dict[str, float] = {}
        self._pending_unresolved_volumes: set[str] = set()
        self._api = api or WindowsChangeApi()
        self._ignored_paths = ignored_paths or (lambda _path: False)
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        # ReadDirectoryChangesW で監視中のフォルダと、追跡を始めたフォルダ
        self._watched_paths: set[str] = set()
        self._known_paths: set[str] = set()
        self._fallback_volumes: set[str] = set()

    def start(self) -> bool:
        """USN利用不能対象だけ監視を開始し、USNは直ちに停止中履歴を復元する。"""
        paths, fallback_paths = self._synchronize_targets()
        logger.info(
            "WindowsChangeTracker: 起動します。USN対象パス数=%d, フォールバック対象パス数=%d",
            len(paths),
            len(fallback_paths),
        )
        self._known_paths.update(paths)
        self.reconcile_once()
        watched = self._start_fallback_watch(fallback_paths)
        if paths:
            self._start_polling()
        else:
            logger.info("WindowsChangeTracker: USN 対象パスが0件のためポーリングスレッドは起動しません。")
        result = bool(paths or watched)
        logger.info(
            "WindowsChangeTracker: 起動完了。usn_polling=%s, rdcw_watch=%s, result=%s",
            bool(paths),
            watched,
            result,
        )
        return result

    def stop(self) -> None:
        logger.info("WindowsChangeTracker: 停止します。")
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        self._thread = None
        self._api.stop_directory_watch()
        self._watched_paths.clear()
        self._known_paths.clear()

    def sync_watches(self) -> bool:
        """
        起動後に追加された検索対象の追跡を始める。追跡中の対象があれば True を返す。
        監視を始める前の変更を取りこぼさないよう、追加された対象は dirty にする。
        """
        paths, unresolved_paths = self._synchronize_targets()
        added_paths = tuple(path for path in paths if path not in self._known_paths)
        if not added_paths:
            return bool(paths)
        logger.info("WindowsChangeTracker: 検索対象の追加を検出しました。追加パス数=%d", len(added_paths))
        self._known_paths.update(added_paths)
        # 新しいボリュームの USN の可否を確かめる（使えなければ _fallback_volumes へ入り、監視へ切り替わる）
        self.reconcile_once()
        connection = self._connection_factory()
        try:
            targets_by_volume = self._targets_by_volume(connection)
            fallback_paths = {
                str(target["full_path"])
                for volume, targets in targets_by_volume.items()
                if volume in self._fallback_volumes
                for target in targets
            }
            self._start_fallback_watch(tuple(sorted(fallback_paths | set(unresolved_paths))))
            self._mark_targets_dirty(connection, [target for targets in targets_by_volume.values() for target in targets if str(target["full_path"]) in added_paths])
            connection.commit()
            has_usn_volume = bool(set(targets_by_volume) - self._fallback_volumes)
        finally:
            connection.close()
        if has_usn_volume and (self._thread is None or not self._thread.is_alive()):
            self._start_polling()
        return True

    def reconcile_once(self) -> None:
        """保存済みUSNから読み、ギャップ・再作成・失敗時はボリューム対象を dirty 化する。"""
        _paths, _fallback_paths = self._synchronize_targets()
        connection = self._connection_factory()
        try:
            targets_by_volume = self._targets_by_volume(connection)
            if not targets_by_volume:
                return
            for volume, targets in targets_by_volume.items():
                if volume in self._fallback_volumes:
                    continue
                row = connection.execute(
                    "SELECT journal_id, last_usn FROM windows_usn_journals WHERE volume_path = ?",
                    (volume,),
                ).fetchone()
                try:
                    journal = self._api.query_journal(volume)
                    if row is None:
                        logger.info(
                            "WindowsChangeTracker: %s の USN カーソルが未保存のため初期化します。journal_id=%d next_usn=%d",
                            volume,
                            journal.journal_id,
                            journal.next_usn,
                        )
                        self._save_cursor(connection, volume, journal)
                        self._mark_targets_dirty(connection, targets)
                        continue
                    if int(row["journal_id"]) != journal.journal_id or int(row["last_usn"]) > journal.next_usn:
                        logger.warning(
                            "WindowsChangeTracker: %s の USN ジャーナルが再作成または履歴欠落を検出しました。"
                            "保存journal_id=%d 現在journal_id=%d 保存last_usn=%d next_usn=%d",
                            volume,
                            int(row["journal_id"]),
                            journal.journal_id,
                            int(row["last_usn"]),
                            journal.next_usn,
                        )
                        self._mark_targets_dirty(connection, targets)
                        self._save_cursor(connection, volume, journal)
                        continue
                    result = self._api.read_journal(volume, journal.journal_id, int(row["last_usn"]))
                    if result.has_relevant_changes:
                        # ボリューム全体の通知が毎秒来るので、検索対象の外のパスは実ファイルの確認へ進めない
                        target_paths = [str(target["full_path"]) for target in targets]
                        effective_paths = tuple(
                            path
                            for path in result.changed_paths
                            if exclude_rules.find_enclosing_root(path, target_paths) and not self._ignored_paths(path)
                        )
                        if effective_paths:
                            # 対象を dirty にしたときの INFO は _mark_paths_dirty が記録する
                            logger.debug(
                                "WindowsChangeTracker: %s で変更を検出しました。変更パス数=%d(例: %s)",
                                volume,
                                len(effective_paths),
                                effective_paths[0],
                            )
                            self._mark_paths_dirty(connection, effective_paths)
                        if result.has_unresolved_changes or not result.changed_paths:
                            self._pending_unresolved_volumes.add(volume)
                    self._apply_unresolved_changes(connection, volume, targets)
                    self._save_cursor(connection, volume, UsnJournalInfo(journal.journal_id, result.next_usn))
                except OSError as error:
                    logger.info(
                        "WindowsChangeTracker: %s で USN を利用できないため ReadDirectoryChangesW へフォールバックします。error=%s",
                        volume,
                        error,
                    )
                    self._mark_targets_dirty(connection, targets)
                    self._fallback_volumes.add(volume)
                    self._start_fallback_watch(tuple(str(target["full_path"]) for target in targets))
                except Exception:
                    logger.warning(
                        "WindowsChangeTracker: %s の USN 履歴を読めないため安全な差分再照合を行います。",
                        volume,
                        exc_info=True,
                    )
                    self._mark_targets_dirty(connection, targets)
                    self._fallback_volumes.add(volume)
                    self._start_fallback_watch(tuple(str(target["full_path"]) for target in targets))
            connection.commit()
        finally:
            connection.close()

    def _apply_unresolved_changes(self, connection: Connection, volume: str, targets: list[object]) -> None:
        """パスを解決できない変更（削除・移動の可能性）を、間隔を空けて対象の dirty へ反映する。"""
        if volume not in self._pending_unresolved_volumes:
            return
        last_dirty_at = self._unresolved_dirty_at.get(volume)
        now = self._clock()
        if last_dirty_at is not None and now - last_dirty_at < UNRESOLVED_CHANGE_DIRTY_INTERVAL_SECONDS:
            return
        logger.info(
            "WindowsChangeTracker: %s でパス解決不能な変更を検出しました（削除・移動の可能性）。対象を dirty 化します。",
            volume,
        )
        self._mark_targets_dirty(connection, targets)
        self._unresolved_dirty_at[volume] = now
        self._pending_unresolved_volumes.discard(volume)

    def mark_changed_paths(self, changed_paths: tuple[str, ...]) -> None:
        """ReadDirectoryChangesW の変更を、自己更新を除外して dirty にする。"""
        paths = tuple(path for path in changed_paths if not self._ignored_paths(path))
        if not paths:
            return
        logger.info(
            "WindowsChangeTracker: ReadDirectoryChangesW から変更通知を受けました。有効パス数=%d(例: %s)",
            len(paths),
            paths[0],
        )
        connection = self._connection_factory()
        try:
            self._mark_paths_dirty(connection, paths)
            connection.commit()
        finally:
            connection.close()

    def _start_polling(self) -> None:
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._poll_loop, daemon=True, name="usn-change-tracker")
        self._thread.start()
        logger.info("WindowsChangeTracker: USN ポーリングスレッドを起動しました。")

    def _poll_loop(self) -> None:
        while not self._stop_event.wait(1.0):
            self.reconcile_once()
            connection = self._connection_factory()
            try:
                targets_by_volume = self._targets_by_volume(connection)
            finally:
                connection.close()
            active_volumes = set(targets_by_volume.keys()) - self._fallback_volumes
            if not active_volumes:
                logger.info(
                    "WindowsChangeTracker: 全ボリュームが ReadDirectoryChangesW へフォールバック済みのため"
                    "USN ポーリングスレッドを停止します。"
                )
                break

    def _start_fallback_watch(self, paths: tuple[str, ...]) -> bool:
        """USN が使えない対象の監視を始める。監視中のフォルダは重ねて始めない。"""
        unwatched_paths = tuple(path for path in dict.fromkeys(paths) if path not in self._watched_paths)
        if not unwatched_paths:
            return bool(self._watched_paths)
        if self._api.start_directory_watch(unwatched_paths, self.mark_changed_paths):
            self._watched_paths.update(unwatched_paths)
            logger.info(
                "WindowsChangeTracker: ReadDirectoryChangesW 監視を開始しました。パス数=%d",
                len(unwatched_paths),
            )
        else:
            logger.warning("WindowsChangeTracker: ReadDirectoryChangesW 監視の開始に失敗しました。")
        return bool(self._watched_paths)

    def _synchronize_targets(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        connection = self._connection_factory()
        try:
            rows = connection.execute(
                "SELECT id, full_path FROM targets WHERE source_type = 'local' AND is_search_target_enabled = 1"
            ).fetchall()
            paths = tuple(str(row["full_path"]) for row in rows if Path(str(row["full_path"])).is_dir())
            fallback: list[str] = []
            for path in paths:
                try:
                    self._api.volume_for_path(path)
                except OSError:
                    fallback.append(path)
            return paths, tuple(fallback)
        finally:
            connection.close()

    def _targets_by_volume(self, connection: Connection) -> dict[str, list[object]]:
        grouped: dict[str, list[object]] = {}
        rows = connection.execute(
            "SELECT id, full_path FROM targets WHERE source_type = 'local' AND is_search_target_enabled = 1"
        ).fetchall()
        for row in rows:
            try:
                volume = self._api.volume_for_path(str(row["full_path"]))
            except OSError:
                continue
            grouped.setdefault(volume, []).append(row)
        return grouped

    @staticmethod
    def _save_cursor(connection: Connection, volume: str, journal: UsnJournalInfo) -> None:
        connection.execute(
            """\
            INSERT INTO windows_usn_journals(volume_path, journal_id, last_usn, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(volume_path) DO UPDATE SET
                journal_id = excluded.journal_id,
                last_usn = excluded.last_usn,
                updated_at = CURRENT_TIMESTAMP
            """,
            (volume, journal.journal_id, journal.next_usn),
        )

    def _mark_paths_dirty(self, connection: Connection, paths: tuple[str, ...]) -> None:
        rows = connection.execute(
            """\
            SELECT id, full_path, exclude_keywords
            FROM targets
            WHERE source_type = 'local' AND is_search_target_enabled = 1
            """
        ).fetchall()
        # 除外対象（.git 配下など）だけの変更では、走査しても結果が変わらないため dirty にしない
        matched = find_targets_affected_by_changes(rows, paths)
        if matched:
            logger.info(
                "WindowsChangeTracker: dirty 化します。対象数=%d",
                len(matched),
            )
        self._mark_targets_dirty(connection, matched)

    @staticmethod
    def _mark_targets_dirty(connection: Connection, targets: list[object]) -> None:
        for target in targets:
            connection.execute(
                """\
                INSERT INTO target_change_states(target_id, is_tracking, is_dirty, last_event_at)
                VALUES (?, 1, 1, CURRENT_TIMESTAMP)
                ON CONFLICT(target_id) DO UPDATE SET
                    is_tracking = 1,
                    is_dirty = 1,
                    last_event_at = CURRENT_TIMESTAMP
                """,
                (int(target["id"]),),
            )
