"""自動実行スケジューラのテスト。"""
from __future__ import annotations

import threading
import unittest
from datetime import datetime, timedelta, UTC
from unittest.mock import patch

from backend import config, db, scheduler

NOW = datetime(2026, 5, 20, 12, 0, tzinfo=UTC)


def run_record(minutes_ago: int, status: str = "success") -> dict[str, str]:
    return {
        "last_run_at": (NOW - timedelta(minutes=minutes_ago)).isoformat(timespec="seconds"),
        "status": status,
        "message": "",
    }


class IsJobDueTest(unittest.TestCase):
    def test_never_run_job_is_due(self) -> None:
        self.assertTrue(scheduler.is_job_due(None, 60, NOW.timestamp()))

    def test_unparsable_last_run_is_due(self) -> None:
        run = {"last_run_at": "broken", "status": "success", "message": ""}
        self.assertTrue(scheduler.is_job_due(run, 60, NOW.timestamp()))

    def test_success_waits_for_full_interval(self) -> None:
        self.assertFalse(scheduler.is_job_due(run_record(59), 60, NOW.timestamp()))
        self.assertTrue(scheduler.is_job_due(run_record(60), 60, NOW.timestamp()))

    def test_failed_job_is_retried_before_long_interval_elapses(self) -> None:
        month = 43200
        self.assertFalse(scheduler.is_job_due(run_record(10, "error"), month, NOW.timestamp()))
        retry_run = run_record(scheduler.RETRY_AFTER_ERROR_MINUTES, "error")
        self.assertTrue(scheduler.is_job_due(retry_run, month, NOW.timestamp()))

    def test_failed_job_does_not_retry_faster_than_short_interval(self) -> None:
        self.assertFalse(scheduler.is_job_due(run_record(5, "error"), 10, NOW.timestamp()))


class SchedulerTickTest(unittest.TestCase):
    def test_tick_starts_only_due_jobs(self) -> None:
        settings = {"address_interval_minutes": 43200, "keyword_interval_minutes": 60}
        runs = {
            "refresh_addresses": run_record(100),
            "check_keywords": run_record(120),
        }
        started: list[str] = []

        class ImmediateThread:
            def __init__(self, target, args=(), daemon=None) -> None:
                self.target, self.args = target, args

            def start(self) -> None:
                self.target(*self.args)

        with (
            patch.object(db, "get_settings", return_value=settings),
            patch.object(db, "list_job_runs", return_value=runs),
            patch.object(scheduler, "run_job_safely", side_effect=lambda name, callback: started.append(name)),
            patch.object(scheduler.threading, "Thread", ImmediateThread),
        ):
            scheduler.scheduler_tick(NOW.timestamp())

        self.assertEqual(started, ["check_keywords"])


class SchedulerLoopTest(unittest.TestCase):
    def test_loop_survives_tick_errors_and_stops_on_event(self) -> None:
        stop = threading.Event()
        calls: list[int] = []

        def failing_tick(_now: float) -> None:
            calls.append(1)
            if len(calls) >= 2:
                stop.set()
            raise RuntimeError("database is locked")

        with (
            patch.object(scheduler, "scheduler_tick", side_effect=failing_tick),
            self.assertLogs(config.LOGGER, level="ERROR"),
        ):
            scheduler.scheduler_loop(stop_event=stop, interval_seconds=0)

        self.assertEqual(len(calls), 2)


class RunJobSafelyTest(unittest.TestCase):
    def test_run_job_safely_skips_when_same_job_is_running(self) -> None:
        job_name = "refresh_addresses"
        calls: list[str] = []
        lock = scheduler.job_lock(job_name)

        self.assertTrue(lock.acquire(blocking=False))
        try:
            scheduler.run_job_safely(job_name, lambda: calls.append("called"))
        finally:
            lock.release()

        self.assertEqual(calls, [])

    def test_run_job_safely_allows_different_jobs_to_run(self) -> None:
        calls: list[str] = []
        lock = scheduler.job_lock("refresh_addresses")

        self.assertTrue(lock.acquire(blocking=False))
        try:
            scheduler.run_job_safely("check_keywords", lambda: calls.append("called"))
        finally:
            lock.release()

        self.assertEqual(calls, ["called"])


if __name__ == "__main__":
    unittest.main()
