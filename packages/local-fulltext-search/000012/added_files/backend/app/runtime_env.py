"""
ネイティブ数値ライブラリ（OpenMP / BLAS / PyTorch / Tokenizers）の実行環境設定。

仕様:
- torch と faiss はそれぞれ OpenMP ランタイムを同梱しており、macOS では二重初期化でプロセスが異常終了する。
  どちらを先に import しても安全なよう、`app` パッケージの import 時にこの設定を必ず適用する。
- 既定ではスレッド数を 1 に制限し、Apple Silicon 上のスレッド競合クラッシュを防止する。
- 環境変数 `SEARCH_APP_NATIVE_THREADS` に 2 以上の整数を指定すると、そのスレッド数で CPU 推論を行う
  （CPU のみの Windows 環境で Embedding 生成を高速化したい場合の切替用）。
- 利用者がすでに設定している環境変数は上書きしない。
"""

import os

NATIVE_THREADS_ENV_NAME = "SEARCH_APP_NATIVE_THREADS"
DEFAULT_NATIVE_THREADS = 1
_THREAD_COUNT_ENV_NAMES = (
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "NUMEXPR_NUM_THREADS",
)


def resolve_native_thread_count() -> int:
    """`SEARCH_APP_NATIVE_THREADS` から使用スレッド数を解決する。未指定・不正値は既定の 1 とする。"""
    raw_value = os.environ.get(NATIVE_THREADS_ENV_NAME, "").strip()
    if not raw_value:
        return DEFAULT_NATIVE_THREADS
    try:
        thread_count = int(raw_value)
    except ValueError:
        return DEFAULT_NATIVE_THREADS
    return thread_count if thread_count >= 1 else DEFAULT_NATIVE_THREADS


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
