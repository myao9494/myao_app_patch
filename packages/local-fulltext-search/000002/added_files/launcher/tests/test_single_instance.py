"""
ランチャープロセスの単一インスタンス（二重起動防止）機能を検証するテスト。

【仕様】
- acquire_single_instance_lock() は初回呼び出し時にロックを取得し True を返す。
- 既にロックが保持されている状態で acquire_single_instance_lock() を呼ぶと False を返す。
- release_single_instance_lock() でロックを解放できる。
- main() の実行時、ロック取得に失敗した場合は二重起動せず安全に終了（sys.exit(0)）する。
"""

import sys
from unittest.mock import MagicMock, patch
import pytest

from launcher_app.main import acquire_single_instance_lock, release_single_instance_lock, main


def test_acquire_and_release_single_instance_lock():
    """
    初回ロック取得に成功し、解放後に再取得できることを検証する。
    """
    test_lock = "test_single_instance_lock.lock"
    # 既存ロックを解放
    release_single_instance_lock()

    # 初回取得は成功する
    assert acquire_single_instance_lock(lock_name=test_lock) is True

    # 既にロック取得済みの場合は取得に失敗する
    assert acquire_single_instance_lock(lock_name=test_lock) is False

    # 解放する
    release_single_instance_lock()

    # 解放後は再取得可能
    assert acquire_single_instance_lock(lock_name=test_lock) is True
    release_single_instance_lock()


def test_main_exits_when_already_running():
    """
    別インスタンスが既に実行中の場合、main() が二重起動せずに sys.exit(0) することを検証する。
    """
    with patch("launcher_app.main.acquire_single_instance_lock", return_value=False):
        with pytest.raises(SystemExit) as exc_info:
            main()
        assert exc_info.value.code == 0
