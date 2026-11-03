"""
ネイティブ数値ライブラリ実行環境設定（app.runtime_env）の単体テスト。

仕様:
- 既定のスレッド数は Windows がコア数の半分、それ以外が 1（Apple Silicon 上のスレッド競合クラッシュ防止）。
- SEARCH_APP_NATIVE_THREADS に 1 以上の整数を指定した場合だけ、その値を採用する。
- torch と faiss の OpenMP 二重初期化による異常終了を防ぐ KMP_DUPLICATE_LIB_OK を設定する。
- 利用者が設定済みの環境変数は上書きしない。
"""

import pytest

from app import runtime_env

THREAD_ENV_NAMES = (
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "NUMEXPR_NUM_THREADS",
)


@pytest.fixture
def clean_native_env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    """スレッド関連の環境変数を未設定状態にしてから検証する。"""
    for name in (*THREAD_ENV_NAMES, "TOKENIZERS_PARALLELISM", "KMP_DUPLICATE_LIB_OK", runtime_env.NATIVE_THREADS_ENV_NAME):
        monkeypatch.delenv(name, raising=False)
    # 既定値は OS で変わるため、macOS の既定（1）を基準に検証する
    monkeypatch.setattr(runtime_env.sys, "platform", "darwin")
    return monkeypatch


def test_default_native_thread_count_is_one(clean_native_env: pytest.MonkeyPatch) -> None:
    assert runtime_env.resolve_native_thread_count() == 1


@pytest.mark.parametrize(
    ("platform", "cpu_count", "expected"),
    [
        ("win32", 4, 2),
        ("win32", 16, 8),
        ("win32", 1, 1),
        ("darwin", 16, 1),
        ("linux", 16, 1),
    ],
)
def test_default_thread_count_uses_half_of_the_cores_only_on_windows(
    platform: str, cpu_count: int | None, expected: int
) -> None:
    assert runtime_env.default_native_thread_count(platform=platform, cpu_count=cpu_count) == expected


def test_windows_default_is_used_when_the_env_is_not_set(clean_native_env: pytest.MonkeyPatch) -> None:
    clean_native_env.setattr(runtime_env.sys, "platform", "win32")
    clean_native_env.setattr(runtime_env.os, "cpu_count", lambda: 8)

    assert runtime_env.resolve_native_thread_count() == 4


@pytest.mark.parametrize(("raw_value", "expected"), [("4", 4), (" 8 ", 8), ("1", 1)])
def test_native_thread_count_follows_env(clean_native_env: pytest.MonkeyPatch, raw_value: str, expected: int) -> None:
    clean_native_env.setenv(runtime_env.NATIVE_THREADS_ENV_NAME, raw_value)

    assert runtime_env.resolve_native_thread_count() == expected


@pytest.mark.parametrize("raw_value", ["", "0", "-2", "auto", "1.5"])
def test_invalid_native_thread_count_falls_back_to_one(clean_native_env: pytest.MonkeyPatch, raw_value: str) -> None:
    clean_native_env.setenv(runtime_env.NATIVE_THREADS_ENV_NAME, raw_value)

    assert runtime_env.resolve_native_thread_count() == 1


def test_configure_sets_single_thread_and_openmp_guard_by_default(clean_native_env: pytest.MonkeyPatch) -> None:
    import os

    runtime_env.configure_native_runtime_env()

    assert {name: os.environ[name] for name in THREAD_ENV_NAMES} == {name: "1" for name in THREAD_ENV_NAMES}
    assert os.environ["TOKENIZERS_PARALLELISM"] == "false"
    assert os.environ["KMP_DUPLICATE_LIB_OK"] == "TRUE"


def test_configure_applies_requested_thread_count(clean_native_env: pytest.MonkeyPatch) -> None:
    import os

    clean_native_env.setenv(runtime_env.NATIVE_THREADS_ENV_NAME, "6")

    runtime_env.configure_native_runtime_env()

    assert {name: os.environ[name] for name in THREAD_ENV_NAMES} == {name: "6" for name in THREAD_ENV_NAMES}


def test_configure_keeps_user_defined_values(clean_native_env: pytest.MonkeyPatch) -> None:
    import os

    clean_native_env.setenv("OMP_NUM_THREADS", "3")
    clean_native_env.setenv("KMP_DUPLICATE_LIB_OK", "FALSE")

    runtime_env.configure_native_runtime_env()

    assert os.environ["OMP_NUM_THREADS"] == "3"
    assert os.environ["KMP_DUPLICATE_LIB_OK"] == "FALSE"
    assert os.environ["MKL_NUM_THREADS"] == "1"


def test_app_package_import_applies_native_runtime_env() -> None:
    """app パッケージを import した時点で OpenMP の二重初期化ガードが有効になっている。"""
    import os

    import app  # noqa: F401

    assert os.environ.get("KMP_DUPLICATE_LIB_OK")
    assert os.environ.get("OMP_NUM_THREADS")
