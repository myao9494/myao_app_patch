"""
ランチャーアプリのコマンドラインエントリーポイント。

【仕様】
- 単一インスタンス（Single Instance）ガードを実装し、多重起動を防止する。
- 既に別プロセスが起動中の場合、重複して起動せず安全に終了（sys.exit(0)）する。
- 環境変数から設定を読み取り、macOS では Cocoa ネイティブ、その他では Flet ランチャーを起動する。
"""

import atexit
import logging
import os
import platform
import sys
import tempfile
from typing import Any

from launcher_app.config import LauncherConfig
from launcher_app.offline_flet import prepare_flet_view

_lock_file: Any = None


def acquire_single_instance_lock(lock_name: str = "local_fulltext_search_launcher.lock") -> bool:
    """
    ファイル排他ロックを用いて、ランチャーの多重起動を防止する。
    ロック取得に成功した場合は True、既に別プロセスが起動中の場合は False を返す。
    """
    global _lock_file
    if _lock_file is not None:
        return False
    lock_path = os.path.join(tempfile.gettempdir(), lock_name)
    try:
        f = open(lock_path, "a+")
        if sys.platform == "win32":
            import msvcrt
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        f.seek(0)
        f.truncate()
        f.write(f"{os.getpid()}\n")
        f.flush()
        _lock_file = f
        atexit.register(release_single_instance_lock)
        return True
    except (IOError, OSError):
        try:
            f.close()
        except Exception:
            pass
        return False


def release_single_instance_lock() -> None:
    """
    保持している単一インスタンスロックを解放する。
    """
    global _lock_file
    if _lock_file is not None:
        try:
            if sys.platform == "win32":
                import msvcrt
                _lock_file.seek(0)
                msvcrt.locking(_lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(_lock_file.fileno(), fcntl.LOCK_UN)
            _lock_file.close()
        except Exception:
            pass
        finally:
            _lock_file = None


def configure_logging() -> None:
    """
    ランチャー単体の診断ログを標準出力へ出し、バックエンド起動時は launcher.log に保存させる。
    """
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
        force=True,
    )


def main() -> None:
    """
    環境変数から設定を読み取り、OS に適したランチャーを起動する。
    """
    configure_logging()
    logger = logging.getLogger(__name__)

    if not acquire_single_instance_lock():
        logger.warning("Another instance of launcher is already running. Exiting.")
        sys.exit(0)

    config = LauncherConfig.from_env()
    logger.info(
        "Launcher starting: platform=%s api_base_url=%s web_base_url=%s timeout=%.1fs limit=%d",
        platform.system(),
        config.api_base_url,
        config.web_base_url,
        config.request_timeout,
        config.search_limit,
    )
    if platform.system() == "Darwin":
        from launcher_app.ui.native_mac import run_native_mac_app

        run_native_mac_app(config)
    else:
        prepare_flet_view()
        from launcher_app.ui.app import run_app

        run_app(config)


if __name__ == "__main__":
    main()
