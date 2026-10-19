"""
Embedding 推論の順番待ち（InferenceGate）の単体テスト。

仕様:
- 推論は同時に 1 つだけ実行する（モデルはスレッド安全ではないため）。
- 検索クエリの推論は、インデックス作成の推論より優先する。
  インデックス作成は小分けにして順番を取り直すので、検索は「いま実行中の 1 区切り」だけ待てばよい。
"""

import threading
import time

from app.vector.inference_gate import InferenceGate


def _wait_until(condition, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "条件が時間内に満たされなかった"
        time.sleep(0.001)


def test_query_runs_before_the_next_indexing_slice() -> None:
    """インデックス作成の区切りの実行中に来た検索は、次の区切りより先に実行される。"""
    gate = InferenceGate()
    order: list[str] = []
    first_slice_running = threading.Event()
    release_first_slice = threading.Event()

    def index_two_slices() -> None:
        with gate.batch():
            first_slice_running.set()
            release_first_slice.wait(5)
            order.append("batch1")
        with gate.batch():
            order.append("batch2")

    def run_query() -> None:
        with gate.query():
            order.append("query")

    indexer = threading.Thread(target=index_two_slices)
    indexer.start()
    assert first_slice_running.wait(5)
    query = threading.Thread(target=run_query)
    query.start()
    _wait_until(lambda: gate.pending_queries == 1)
    release_first_slice.set()
    indexer.join(5)
    query.join(5)

    assert order == ["batch1", "query", "batch2"]
    assert gate.pending_queries == 0


def test_inference_sections_never_overlap() -> None:
    """検索とインデックス作成が並行しても、推論の区間は重ならない。"""
    gate = InferenceGate()
    active = 0
    max_active = 0
    counter_lock = threading.Lock()

    def enter(section) -> None:
        nonlocal active, max_active
        for _ in range(20):
            with section():
                with counter_lock:
                    active += 1
                    max_active = max(max_active, active)
                time.sleep(0.0005)
                with counter_lock:
                    active -= 1

    threads = [threading.Thread(target=enter, args=(gate.batch,)) for _ in range(2)]
    threads += [threading.Thread(target=enter, args=(gate.query,)) for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)

    assert max_active == 1


def test_section_is_released_when_inference_fails() -> None:
    """推論が例外で終わっても順番を返し、後続の推論が止まらない。"""
    gate = InferenceGate()
    try:
        with gate.batch():
            raise RuntimeError("inference failed")
    except RuntimeError:
        pass

    finished = threading.Event()

    def run_query() -> None:
        with gate.query():
            finished.set()

    threading.Thread(target=run_query).start()
    assert finished.wait(2)
