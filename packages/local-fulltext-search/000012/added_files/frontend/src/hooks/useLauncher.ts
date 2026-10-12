/**
 * デスクトップランチャー管理画面の状態と操作（起動・停止・再起動、呼び出しキーの設定）。
 * 画面を開いている間と、ランチャーの起動中は、1.5 秒ごとに状態を取り直す。
 */
import type * as React from "react";
import { useEffect, useState } from "react";
import { fetchLauncherStatus, restartLauncher, startLauncher, stopLauncher, updateAppSettings } from "../api/client";
import type { AppSettings, LauncherStatus } from "../types";
import type { PageView } from "../appTypes";

type UseLauncherDeps = {
  pageView: PageView;
  setErrorMessage: React.Dispatch<React.SetStateAction<string>>;
  setNoticeMessage: React.Dispatch<React.SetStateAction<string>>;
};

export function useLauncher({
  pageView,
  setErrorMessage,
  setNoticeMessage,
}: UseLauncherDeps) {
  const [launcherState, setLauncherState] = useState<LauncherStatus | null>(null);
  const [isLauncherActionRunning, setIsLauncherActionRunning] = useState(false);
  const [launcherHotkey, setLauncherHotkey] = useState<"command_option" | "double_shift">("command_option");
  const [isSavingLauncherHotkey, setIsSavingLauncherHotkey] = useState(false);

  async function refreshLauncherState(): Promise<void> {
    const response = await fetchLauncherStatus();
    setLauncherState(response);
  }

  useEffect(() => {
    if (pageView !== "launcher" && !launcherState?.is_running) {
      return;
    }

    const timerId = window.setInterval(() => {
      void refreshLauncherState().catch(() => undefined);
    }, 1500);

    return () => {
      window.clearInterval(timerId);
    };
  }, [pageView, launcherState?.is_running]);

  /** ランチャー再起動時に読むグローバルショートカットを保存する。 */
  async function handleChangeLauncherHotkey(nextHotkey: "command_option" | "double_shift"): Promise<void> {
    const previousHotkey = launcherHotkey;
    setLauncherHotkey(nextHotkey);
    setIsSavingLauncherHotkey(true);
    try {
      const savedSettings = await updateAppSettings({ launcher_hotkey: nextHotkey });
      setLauncherHotkey(savedSettings.launcher_hotkey);
      setErrorMessage("");
      setNoticeMessage("ショートカットを保存しました。ランチャーを再起動すると反映されます。");
    } catch (error) {
      setLauncherHotkey(previousHotkey);
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "ショートカットの保存に失敗しました。");
    } finally {
      setIsSavingLauncherHotkey(false);
    }
  }

  async function handleLauncherAction(action: "start" | "stop" | "restart"): Promise<void> {
    setIsLauncherActionRunning(true);
    setErrorMessage("");
    setNoticeMessage("");
    try {
      const response =
        action === "start"
          ? await startLauncher()
          : action === "stop"
            ? await stopLauncher()
            : await restartLauncher();
      setLauncherState(response);
      setNoticeMessage(
        action === "start"
          ? "ランチャーを起動しました。"
          : action === "stop"
            ? "ランチャーを停止しました。"
            : "ランチャーを再起動しました。",
      );
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "ランチャー操作に失敗しました。");
    } finally {
      setIsLauncherActionRunning(false);
    }
  }

  /** 読み込んだ共有設定の呼び出しキーを反映する。 */
  function applyLoadedSettings(appSettings: AppSettings): void {
    setLauncherHotkey(appSettings.launcher_hotkey ?? "command_option");
  }

  return {
    applyLoadedSettings,
    handleChangeLauncherHotkey,
    handleLauncherAction,
    isLauncherActionRunning,
    isSavingLauncherHotkey,
    launcherHotkey,
    launcherState,
    refreshLauncherState,
  } as const;
}

export type UseLauncherResult = ReturnType<typeof useLauncher>;
