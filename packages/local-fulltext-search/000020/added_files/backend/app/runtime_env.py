"""
ネイティブ数値ライブラリ（OpenMP / BLAS / PyTorch / Tokenizers）の実行環境設定。

仕様:
- torch と faiss はそれぞれ OpenMP ランタイムを同梱しており、macOS では二重初期化でプロセスが異常終了する。
  どちらを先に import しても安全なよう、`app` パッケージの import 時にこの設定を必ず適用する。
- 既定のスレッド数は、Windows がコア数の半分、それ以外が 1。
  Windows の CPU 推論は 1 スレッドでは遅く（4 コアで 1.81 件/秒、2 スレッドで 3.31 件/秒）、半分なら他の操作を妨げない。
  macOS は Apple Silicon 上のスレッド競合クラッシュを防止するため 1 に制限する。
- 環境変数 `SEARCH_APP_NATIVE_THREADS` に 1 以上の整数を指定すると、そのスレッド数で CPU 推論を行う。
- 利用者がすでに設定している環境変数は上書きしない。
"""

import os
import sys

NATIVE_THREADS_ENV_NAME = "SEARCH_APP_NATIVE_THREADS"
DEFAULT_NATIVE_THREADS = 1
_THREAD_COUNT_ENV_NAMES = (
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "NUMEXPR_NUM_THREADS",
)


def default_native_thread_count(*, platform: str | None = None, cpu_count: int | None = None) -> int:
    """環境変数が無いときのスレッド数を返す。Windows はコア数の半分、それ以外は DEFAULT_NATIVE_THREADS。"""
    if (platform or sys.platform) != "win32":
        return DEFAULT_NATIVE_THREADS
    return max(DEFAULT_NATIVE_THREADS, (cpu_count or os.cpu_count() or 1) // 2)


def resolve_native_thread_count() -> int:
    """`SEARCH_APP_NATIVE_THREADS` から使用スレッド数を解決する。未指定・不正値は既定の 1 とする。"""
    raw_value = os.environ.get(NATIVE_THREADS_ENV_NAME, "").strip()
    if not raw_value:
        return default_native_thread_count()
    try:
        thread_count = int(raw_value)
    except ValueError:
        return default_native_thread_count()
    return thread_count if thread_count >= 1 else default_native_thread_count()


def configure_native_runtime_env() -> None:
    """torch / faiss / numpy を import する前に必要な環境変数を設定する。"""
    thread_count = str(resolve_native_thread_count())
    for name in _THREAD_COUNT_ENV_NAMES:
        os.environ.setdefault(name, thread_count)
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")


def apply_torch_thread_limit() -> None:
    """torch が利用可能な場合に、演算スレッド数を設定値へ合わせる。"""
    try:
        import torch
    except ImportError:
        return
    torch.set_num_threads(resolve_native_thread_count())
