"""
保存済みモデルのバックグラウンドロードのテスト。

モデルのロードは CPU で 1 分近くかかることがある。ロードを待つと、そのあいだキーワード検索まで使えない。

仕様:
- サーバーの起動はモデルのロードを待たない（起動処理はロードを始めるだけ）。
- 検索はモデルのロードを待たない。未ロードなら searcher は None で、キーワード検索の結果だけを返す。
- ロードが終われば、次の検索からベクトル検索が使える。
- ロードの完了を必要とする処理（ベクトルインデックスの同期）は、実行中のロードを待ち、二重にロードしない。
- ロードに失敗しても、検索のたびに再試行しない（失敗から一定時間は試みない）。
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from app.services.background_tasks import wait_for_background_tasks
from app.vector.state import VectorState


def _state_with_saved_model(tmp_path: Path) -> VectorState:
    (tmp_path / "config.json").write_text(json.dumps({"selected_model": "saved_model_v1"}), encoding="utf-8")
    return VectorState(data_dir=tmp_path)


def test_search_does_not_wait_for_the_model_load(tmp_path: Path) -> None:
    state = _state_with_saved_model(tmp_path)
    release = threading.Event()
    calls: list[int] = []

    def slow_load() -> dict[str, object]:
        calls.append(1)
        release.wait(timeout=10)
        return {"loaded": True}

    with patch.object(state, "load_saved_model", side_effect=slow_load):
        started = time.monotonic()
        searcher = state.get_searcher()
        elapsed = time.monotonic() - started
        release.set()
        assert wait_for_background_tasks()

    assert searcher is None
    assert elapsed < 1
    assert calls == [1]


def test_searcher_is_available_after_the_background_load(tmp_path: Path) -> None:
    state = _state_with_saved_model(tmp_path)

    with patch.object(state, "load_saved_model", side_effect=lambda: state.load_model(use_mock=True, mock_dim=32)):
        assert state.get_searcher() is None
        assert wait_for_background_tasks()

    assert state.get_searcher() is not None


def test_concurrent_searches_start_only_one_load(tmp_path: Path) -> None:
    state = _state_with_saved_model(tmp_path)
    release = threading.Event()
    calls: list[int] = []

    def slow_load() -> dict[str, object]:
        calls.append(1)
        release.wait(timeout=10)
        return {"loaded": False}

    with patch.object(state, "load_saved_model", side_effect=slow_load):
        for _ in range(5):
            state.get_searcher()
        release.set()
        assert wait_for_background_tasks()

    assert calls == [1]


def test_ensure_model_loaded_waits_for_the_running_load_without_loading_twice(tmp_path: Path) -> None:
    state = _state_with_saved_model(tmp_path)
    release = threading.Event()
    calls: list[int] = []

    def slow_load() -> dict[str, object]:
        calls.append(1)
        release.wait(timeout=10)
        return state.load_model(use_mock=True, mock_dim=32)

    with patch.object(state, "load_saved_model", side_effect=slow_load):
        assert state.start_saved_model_load()
        threading.Timer(0.2, release.set).start()
        assert state.ensure_model_loaded() is True
        assert wait_for_background_tasks()

    assert calls == [1]


def test_failed_load_is_not_retried_on_every_search(tmp_path: Path) -> None:
    state = _state_with_saved_model(tmp_path)
    calls: list[int] = []

    def failing_load() -> dict[str, object]:
        calls.append(1)
        raise OSError("モデルファイルが壊れている")

    with patch.object(state, "load_saved_model", side_effect=failing_load):
        for _ in range(3):
            assert state.get_searcher() is None
            assert wait_for_background_tasks()

    assert calls == [1]


def test_nothing_is_loaded_without_a_saved_model(tmp_path: Path) -> None:
    state = VectorState(data_dir=tmp_path)

    with patch.object(state, "load_saved_model") as load:
        assert state.get_searcher() is None
        assert state.start_saved_model_load() is False

    load.assert_not_called()


@pytest.mark.anyio
async def test_server_startup_does_not_wait_for_the_model_load(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import settings
    from app.main import create_app, lifespan
    from app.vector.state import vector_state

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    config_file = data_dir / "config.json"
    config_file.write_text(json.dumps({"selected_model": "saved_model_v1"}), encoding="utf-8")
    monkeypatch.setattr(settings, "data_dir", data_dir)
    monkeypatch.setattr(vector_state, "data_dir", data_dir)
    monkeypatch.setattr(vector_state, "config_path", config_file)
    monkeypatch.setattr(vector_state, "embedder", None)
    release = threading.Event()
    loaded: list[int] = []

    def slow_load() -> dict[str, object]:
        release.wait(timeout=10)
        loaded.append(1)
        return {"loaded": True}

    with patch("app.main.initialize_schema"), \
         patch("app.main.IndexService"), \
         patch("app.main.SchedulerMonitor"), \
         patch("app.main.ChangeTrackingService"), \
         patch("app.main.LauncherManager"), \
         patch.object(vector_state, "load_saved_model", side_effect=slow_load):
        async with lifespan(create_app()):
            # ここへ来た時点でサーバーは要求を受け付けられる。ロードはまだ終わっていない
            assert loaded == []
            release.set()
            assert wait_for_background_tasks()
            assert loaded == [1]


@pytest.fixture
def anyio_backend() -> str:
    """サーバーは uvicorn（asyncio）で動き、trio は依存に含まないため asyncio だけで実行する。"""
    return "asyncio"
