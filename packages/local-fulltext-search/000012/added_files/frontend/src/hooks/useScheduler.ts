/**
 * スケジューラー画面の状態と操作。
 * 指定した日時に、指定したフォルダ群のインデックス更新を開始する予約を扱う。
 * 予約中・実行中は 1 秒ごとに状態を取り直し、ログを画面へ反映する。
 */
import type * as React from "react";
import { useEffect, useState } from "react";
import { fetchSchedulerSettings, pickFolder, startScheduler } from "../api/client";
import { toLocalDateTimeInputValue, toSchedulerStartAtIso } from "../dateInput";
import type { SchedulerSettings } from "../types";
import type { PageView } from "../appTypes";

type UseSchedulerDeps = {
  pageView: PageView;
  setErrorMessage: React.Dispatch<React.SetStateAction<string>>;
  setNoticeMessage: React.Dispatch<React.SetStateAction<string>>;
};

export function useScheduler({
  pageView,
  setErrorMessage,
  setNoticeMessage,
}: UseSchedulerDeps) {
  const [schedulerState, setSchedulerState] = useState<SchedulerSettings | null>(null);
  const [schedulerPaths, setSchedulerPaths] = useState<string[]>([]);
  const [schedulerPathDraft, setSchedulerPathDraft] = useState("");
  const [schedulerStartAt, setSchedulerStartAt] = useState("");
  const [isStartingScheduler, setIsStartingScheduler] = useState(false);

  async function refreshSchedulerState(): Promise<void> {
    const response = await fetchSchedulerSettings();
    setSchedulerState(response);
    setSchedulerPaths(response.paths);
    setSchedulerStartAt(toLocalDateTimeInputValue(response.start_at));
  }

  useEffect(() => {
    const isSchedulerActive = schedulerState?.is_enabled || schedulerState?.status === "running" || schedulerState?.status === "launching";
    if (!isSchedulerActive) {
      return;
    }

    const timerId = window.setInterval(() => {
      void refreshSchedulerState().catch(() => undefined);
    }, 1000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [pageView, schedulerState?.is_enabled, schedulerState?.status]);

  function handleAddSchedulerPath(path: string): void {
    const normalized = path.trim();
    if (!normalized) {
      setErrorMessage("スケジューラーに追加するパスを入力してください。");
      return;
    }
    setSchedulerPaths((current) => (current.includes(normalized) ? current : [...current, normalized]));
    setSchedulerPathDraft("");
    setErrorMessage("");
  }

  async function handlePickSchedulerFolder(): Promise<void> {
    try {
      const payload = await pickFolder();
      if (payload.full_path) {
        handleAddSchedulerPath(payload.full_path);
      }
      setNoticeMessage("");
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "スケジューラー用フォルダの選択に失敗しました。");
    }
  }

  async function handleStartScheduler(): Promise<void> {
    if (isStartingScheduler) {
      return;
    }
    if (schedulerPaths.length === 0) {
      setErrorMessage("スケジューラーの対象フォルダを 1 つ以上追加してください。");
      return;
    }
    if (!schedulerStartAt) {
      setErrorMessage("スケジューラーの開始日時を入力してください。");
      return;
    }

    try {
      setIsStartingScheduler(true);
      setErrorMessage("");
      setNoticeMessage("");
      const response = await startScheduler({
        paths: schedulerPaths,
        start_at: toSchedulerStartAtIso(schedulerStartAt),
      });
      setSchedulerState(response);
      setSchedulerPaths(response.paths);
      setSchedulerStartAt(toLocalDateTimeInputValue(response.start_at));
      setNoticeMessage("スケジューラーを開始しました。開始時刻になると別プロセスで順次インデックス化します。");
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "スケジューラーの開始に失敗しました。");
    } finally {
      setIsStartingScheduler(false);
    }
  }

  return {
    handleAddSchedulerPath,
    handlePickSchedulerFolder,
    handleStartScheduler,
    isStartingScheduler,
    refreshSchedulerState,
    schedulerPathDraft,
    schedulerPaths,
    schedulerStartAt,
    schedulerState,
    setSchedulerPathDraft,
    setSchedulerPaths,
    setSchedulerStartAt,
  } as const;
}

export type UseSchedulerResult = ReturnType<typeof useScheduler>;
