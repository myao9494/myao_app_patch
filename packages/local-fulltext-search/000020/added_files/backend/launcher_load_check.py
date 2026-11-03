"""
ランチャーの検索が「検索中」のまま止まらないことを、サーバーに負荷をかけて確認する（標準ライブラリのみ）。

実ランチャーと同じく、入力のたびに検索を送って途中で切断（取り消し）し、最後の検索が
タイムアウト（既定 15 秒）までに返ることを確かめる。サーバーは起動済みで、検索対象のインデックスがあること。

使い方:
    python launcher_load_check.py                      # 既定: 取り消し 40 件 x 3 ラウンド + 同時 4 クライアント
    python launcher_load_check.py --base http://127.0.0.1:8079 --burst 80 --rounds 5 --clients 8

終了コード: 0 = 合格、1 = 不合格（最終検索がタイムアウトを超えた / 失敗した）。
"""

from __future__ import annotations

import argparse
import http.client
import json
import random
import sys
import threading
import time
from urllib.parse import urlparse

QUERIES = ["report", "budget", "設計 仕様", "alpha beta", "2025 OR 2026", "エラー ログ", "テスト", "plan review", "gamma", "検索 インデックス"]


def _body(query: str) -> bytes:
    """WPF ランチャー（既存DB専用検索）と同じペイロード。"""
    return json.dumps(
        {
            "q": query,
            "folder_path": "",
            "limit": 8,
            "offset": 0,
            "types": "",
            "source_type": "local_web",
            "search_type": "hybrid",
            "include_path_in_filename": True,
        }
    ).encode("utf-8")


def _post(base: str, query: str, timeout: float, abort_after: float | None = None) -> tuple[str, float]:
    """検索を 1 回送る。abort_after 秒後に切断した場合は ("aborted", 経過秒)、完了なら ("200"など, 経過秒)。"""
    parsed = urlparse(base)
    started = time.perf_counter()
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=timeout)
    try:
        connection.request("POST", "/api/search/indexed", body=_body(query), headers={"Content-Type": "application/json"})
        if abort_after is not None:
            time.sleep(abort_after)
            return "aborted", time.perf_counter() - started
        response = connection.getresponse()
        response.read()
        return str(response.status), time.perf_counter() - started
    except TimeoutError:
        return "timeout", time.perf_counter() - started
    except OSError as error:
        return f"error:{type(error).__name__}", time.perf_counter() - started
    finally:
        connection.close()


def check_burst(base: str, burst: int, rounds: int, timeout: float) -> bool:
    """素早い打鍵: burst 件の検索を送って切断し、直後の最終検索が timeout 内に返るか。"""
    passed = True
    for round_number in range(1, rounds + 1):
        threads = [
            threading.Thread(target=_post, args=(base, random.choice(QUERIES), timeout, 0.05), daemon=True)
            for _ in range(burst)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        status, elapsed = _post(base, "plan review", timeout)
        ok = status == "200" and elapsed < timeout
        passed &= ok
        print(f"  [{'OK' if ok else 'NG'}] ラウンド {round_number}: 取り消し {burst} 件の直後の最終検索 -> {status} {elapsed:.2f}秒")
        time.sleep(0.5)
    return passed


def check_concurrent(base: str, clients: int, searches: int, timeout: float) -> bool:
    """同時利用: clients 人が打鍵（途中で取り消す検索を含む）を続けても、検索がタイムアウトを超えないか。"""
    results: list[tuple[str, float]] = []
    lock = threading.Lock()

    def typist() -> None:
        for _ in range(searches):
            query = random.choice(QUERIES)
            if random.random() < 0.5:
                _post(base, query[: max(1, len(query) // 2)], timeout, random.uniform(0.05, 0.3))
            outcome = _post(base, query, timeout)
            with lock:
                results.append(outcome)
            time.sleep(random.uniform(0.05, 0.4))

    threads = [threading.Thread(target=typist, daemon=True) for _ in range(clients)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    latencies = sorted(elapsed for status, elapsed in results if status == "200")
    failures = [status for status, _ in results if status != "200"]
    p95 = latencies[min(len(latencies) - 1, int(len(latencies) * 0.95))] if latencies else float("nan")
    ok = not failures and bool(latencies)
    print(f"  [{'OK' if ok else 'NG'}] 同時 {clients} クライアント: 成功 {len(latencies)} 件 / 失敗 {len(failures)} 件 {sorted(set(failures))}  p95={p95:.2f}秒")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description="ランチャー検索の負荷確認")
    parser.add_argument("--base", default="http://127.0.0.1:8079", help="Search/API の URL")
    parser.add_argument("--burst", type=int, default=40, help="1 ラウンドで取り消す検索の件数")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--clients", type=int, default=4, help="同時に打鍵するクライアント数")
    parser.add_argument("--searches", type=int, default=10, help="1 クライアントあたりの検索回数")
    parser.add_argument("--timeout", type=float, default=15.0, help="ランチャーの検索タイムアウト（秒）")
    args = parser.parse_args()

    print(f"対象: {args.base}  タイムアウト: {args.timeout:g}秒")
    print("1. 素早い打鍵（取り消しの連打の直後に検索）")
    burst_ok = check_burst(args.base, args.burst, args.rounds, args.timeout)
    print("2. 同時利用")
    concurrent_ok = check_concurrent(args.base, args.clients, args.searches, args.timeout)
    print("合格" if burst_ok and concurrent_ok else "不合格")
    return 0 if burst_ok and concurrent_ok else 1


if __name__ == "__main__":
    sys.exit(main())
