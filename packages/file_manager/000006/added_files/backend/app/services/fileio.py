"""
安全なファイル書き込みユーティリティ

- atomic_write_text: 同じフォルダの一時ファイルに書いてから置き換える。
  書き込み途中で失敗しても元ファイルが空になったり壊れたりしない。
    - シンボリックリンクはリンク先の実ファイルを更新する（リンク自体は壊さない）
    - 元ファイルのパーミッションを引き継ぐ
    - Windowsで他プロセスが開いていて置き換えできない場合のみ、直接上書きにフォールバックする
- unique_child_path: 既存ファイルを上書きしないよう「name (1).ext」形式の空き名を返す
- validate_entry_name: 新規作成・リネーム時のファイル名を検証する（区切り文字や `..` を拒否）
"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

INVALID_NAME_CHARS = ("/", "\\", "\0")


def _read_umask() -> int:
    # 起動時（シングルスレッド）に一度だけ読み取る
    current = os.umask(0)
    os.umask(current)
    return current


# 新規ファイルを作るときの既定パーミッション（通常の open() と同じ 0o666 & ~umask）
DEFAULT_NEW_FILE_MODE = 0o666 & ~_read_umask()


class InvalidNameError(ValueError):
    """ファイル名として使えない文字列"""


def validate_entry_name(name: str) -> str:
    """ファイル/フォルダ名を検証し、そのまま返す。不正なら InvalidNameError。"""
    if not name or not name.strip():
        raise InvalidNameError("名前が空です")
    if name in (".", ".."):
        raise InvalidNameError("この名前は使用できません")
    if any(ch in name for ch in INVALID_NAME_CHARS):
        raise InvalidNameError("名前に / や \\ は使用できません")
    return name


def atomic_write_text(path: Path, content: str, encoding: str = "utf-8") -> None:
    """テキストを安全に書き込む（途中失敗で元ファイルを壊さない）。"""
    target = Path(os.path.realpath(path)) if path.is_symlink() else path
    directory = target.parent

    original_mode = None
    try:
        original_mode = target.stat().st_mode
    except FileNotFoundError:
        pass

    fd, tmp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=directory)
    tmp_path = Path(tmp_name)
    try:
        # newline=None（既定）でOS標準の改行に変換する従来の挙動を維持する
        with os.fdopen(fd, "w", encoding=encoding) as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.chmod(tmp_path, (original_mode & 0o7777) if original_mode is not None else DEFAULT_NEW_FILE_MODE)
        except OSError:
            pass
        try:
            os.replace(tmp_path, target)
        except PermissionError:
            # Windows: 他アプリが開いていると置き換えできないため、内容を直接書き戻す。
            # 一時ファイルに完全な内容があるので、コピー成功後に削除する。
            shutil.copyfile(tmp_path, target)
            tmp_path.unlink(missing_ok=True)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def unique_child_path(directory: Path, name: str) -> Path:
    """directory/name が既に存在する場合、「stem (1).ext」「stem (2).ext」… の空き名を返す。"""
    candidate = directory / name
    if not os.path.lexists(candidate):
        return candidate
    stem, suffix = os.path.splitext(name)
    if not stem:  # ".env" のような名前
        stem, suffix = name, ""
    counter = 1
    while True:
        candidate = directory / f"{stem} ({counter}){suffix}"
        if not os.path.lexists(candidate):
            return candidate
        counter += 1
