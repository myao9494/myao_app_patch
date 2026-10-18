"""定期ジョブ（アドレス再取得・職アドキーワードチェック）の実行管理。"""
from __future__ import annotations

import threading
import time
from datetime import datetime
from typing import Any

from backend import db, services
from backend.config import LOGGER


# ジョブが失敗した場合は、長い実行間隔を待たずにこの分数で再試行する
RETRY_AFTER_ERROR_MINUTES = 60


JOB_LOCKS: dict[str, threading.Lock] = {}


JOB_LOCKS_LOCK = threading.Lock()


def job_lock(job_name: str) -> threading.Lock:
    with JOB_LOCKS_LOCK:
        if job_name not in JOB_LOCKS:
            JOB_LOCKS[job_name] = threading.Lock()
        return JOB_LOCKS[job_name]


def run_job_safely(job_name: str, callback: Any) -> None:
    lock = job_lock(job_name)
    if not lock.acquire(blocking=False):
        LOGGER.info("Skipped job because it is already running: %s", job_name)
        return
    try:
        LOGGER.info("Starting scheduled job: %s", job_name)
        callback()
        LOGGER.info("Finished scheduled job: %s", job_name)
    except Exception as exc:  # noqa: BLE001 - job loop should keep running and expose error
        LOGGER.exception("Scheduled job failed: %s", job_name)
        db.record_job_run(job_name, "error", str(exc))
    finally:
        lock.release()


def is_job_due(run: dict[str, str] | None, interval_minutes: int, now_ts: float) -> bool:
    """前回実行から実行間隔が経過したか。失敗していた場合は間隔を短縮して再試行する。"""
    last_run_at = (run or {}).get("last_run_at")
    if not last_run_at:
        return True
    try:
        last_ts = datetime.fromisoformat(last_run_at).timestamp()
    except ValueError:
        return True
    wait_minutes = int(interval_minutes)
    if (run or {}).get("status") == "error":
        wait_minutes = min(wait_minutes, RETRY_AFTER_ERROR_MINUTES)
    return now_ts - last_ts >= wait_minutes * 60


def scheduler_tick(now_ts: float) -> None:
    settings = db.get_settings()
    runs = db.list_job_runs()
    jobs = [
        ("refresh_addresses", settings["address_interval_minutes"], services.refresh_addresses),
        ("check_keywords", settings["keyword_interval_minutes"], services.check_keywords),
    ]
    for job_name, interval_minutes, callback in jobs:
        if is_job_due(runs.get(job_name), interval_minutes, now_ts):
            threading.Thread(target=run_job_safely, args=(job_name, callback), daemon=True).start()


def scheduler_loop(stop_event: threading.Event | None = None, interval_seconds: float = 60) -> None:
    stop_event = stop_event or threading.Event()
    while not stop_event.is_set():
        try:
            scheduler_tick(time.time())
        except Exception:  # noqa: BLE001 - 一時的なDBエラーでスケジューラを止めない
            LOGGER.exception("Scheduler tick failed")
        stop_event.wait(interval_seconds)
