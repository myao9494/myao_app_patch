/**
 * 設定ドロワーで扱う共有設定（Web 用の除外キーワード・Web の取得方法・Obsidian 連携先・gantt の親タスク・
 * インデックス削除時の確認）の下書きと保存。
 * 保存済みの値と下書きを別に持ち、未保存の変更があるかを判定できるようにする。
 */
import type * as React from "react";
import { useState } from "react";
import { updateAppSettings } from "../api/client";
import { normalizeExcludeKeywords, normalizeGanttParent } from "../settingsNormalization";
import type { AppSettings } from "../types";

type UseGeneralSettingsDeps = {
  setErrorMessage: React.Dispatch<React.SetStateAction<string>>;
  setNoticeMessage: React.Dispatch<React.SetStateAction<string>>;
};

export function useGeneralSettings({
  setErrorMessage,
  setNoticeMessage,
}: UseGeneralSettingsDeps) {
  const [savedWebExcludeKeywords, setSavedWebExcludeKeywords] = useState("");
  const [webExcludeKeywordsDraft, setWebExcludeKeywordsDraft] = useState("");
  const [webFetchMode, setWebFetchMode] = useState<"http" | "edge" | "chrome">("http");
  const [isSavingWebFetchMode, setIsSavingWebFetchMode] = useState(false);
  const [savedObsidianSidebarExplorerDataPath, setSavedObsidianSidebarExplorerDataPath] = useState("");
  const [obsidianSidebarExplorerDataPathDraft, setObsidianSidebarExplorerDataPathDraft] = useState("");
  const [savedGanttParent, setSavedGanttParent] = useState(0);
  const [ganttParentDraft, setGanttParentDraft] = useState("0");
  const [isSavingWebExcludeKeywords, setIsSavingWebExcludeKeywords] = useState(false);
  const [isSavingObsidianSidebarExplorerDataPath, setIsSavingObsidianSidebarExplorerDataPath] = useState(false);
  const [isSavingGanttParent, setIsSavingGanttParent] = useState(false);
  const [confirmIndexDeletion, setConfirmIndexDeletion] = useState(true);
  const [isSavingConfirmIndexDeletion, setIsSavingConfirmIndexDeletion] = useState(false);
  const normalizedWebExcludeKeywordsDraft = normalizeExcludeKeywords(webExcludeKeywordsDraft);
  const hasUnsavedWebExcludeKeywords = normalizedWebExcludeKeywordsDraft !== savedWebExcludeKeywords;
  const normalizedObsidianSidebarExplorerDataPathDraft = obsidianSidebarExplorerDataPathDraft.trim();
  const hasUnsavedObsidianSidebarExplorerDataPath =
    normalizedObsidianSidebarExplorerDataPathDraft !== savedObsidianSidebarExplorerDataPath;
  const normalizedGanttParentDraft = normalizeGanttParent(ganttParentDraft);
  const hasUnsavedGanttParent = normalizedGanttParentDraft !== savedGanttParent || ganttParentDraft.trim() !== String(normalizedGanttParentDraft);

  /**
   * Web クロール用の除外キーワードはローカルフォルダ用と分けて保存する。
   */
  async function handleSaveWebExcludeKeywords(): Promise<void> {
    const normalized = normalizeExcludeKeywords(webExcludeKeywordsDraft);
    try {
      setIsSavingWebExcludeKeywords(true);
      const savedSettings = await updateAppSettings({ web_exclude_keywords: normalized });
      const savedValue = normalizeExcludeKeywords(savedSettings.web_exclude_keywords);
      setSavedWebExcludeKeywords(savedValue);
      setWebExcludeKeywordsDraft(savedValue);
      setErrorMessage("");
      setNoticeMessage("Web除外キーワードを保存しました。次回Web検索から反映されます。");
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "Web除外キーワードの保存に失敗しました。");
    } finally {
      setIsSavingWebExcludeKeywords(false);
    }
  }

  /**
   * Web取得方式を保存し、次回クロールから正式版Edge/Chromeを選択可能にする。
   */
  async function handleChangeWebFetchMode(nextMode: "http" | "edge" | "chrome"): Promise<void> {
    const previousMode = webFetchMode;
    setWebFetchMode(nextMode);
    try {
      setIsSavingWebFetchMode(true);
      const savedSettings = await updateAppSettings({ web_fetch_mode: nextMode });
      setWebFetchMode(savedSettings.web_fetch_mode);
      setErrorMessage("");
      setNoticeMessage("Web取得方式を保存しました。次回のWebインデックス作成から反映されます。");
    } catch (error) {
      setWebFetchMode(previousMode);
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "Web取得方式の保存に失敗しました。");
    } finally {
      setIsSavingWebFetchMode(false);
    }
  }

  /**
   * Obsidian sidebar-explorer の data.json パスはバックエンド保存し、再読込後も同じ値を使う。
   */
  async function handleSaveObsidianSidebarExplorerDataPath(): Promise<void> {
    const normalized = obsidianSidebarExplorerDataPathDraft.trim();
    try {
      setIsSavingObsidianSidebarExplorerDataPath(true);
      const savedSettings = await updateAppSettings({ obsidian_sidebar_explorer_data_path: normalized });
      const savedValue = savedSettings.obsidian_sidebar_explorer_data_path.trim();
      setSavedObsidianSidebarExplorerDataPath(savedValue);
      setObsidianSidebarExplorerDataPathDraft(savedValue);
      setErrorMessage("");
      setNoticeMessage("Obsidian sidebar-explorer の data.json パスを保存しました。次回検索後の同期から反映されます。");
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "Obsidian パスの保存に失敗しました。");
    } finally {
      setIsSavingObsidianSidebarExplorerDataPath(false);
    }
  }

  /**
   * ランチャーの gantt メモ追加で使う parent ID を Web 側の共有設定として保存する。
   */
  async function handleSaveGanttParent(): Promise<void> {
    const normalized = normalizeGanttParent(ganttParentDraft);
    try {
      setIsSavingGanttParent(true);
      const savedSettings = await updateAppSettings({ gantt_parent: normalized });
      const savedValue = normalizeGanttParent(savedSettings.gantt_parent);
      setSavedGanttParent(savedValue);
      setGanttParentDraft(String(savedValue));
      setErrorMessage("");
      setNoticeMessage("gantt parent を保存しました。ランチャーの次回メモ送信から反映されます。");
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "gantt parent の保存に失敗しました。");
    } finally {
      setIsSavingGanttParent(false);
    }
  }

  /**
   * インデックス削除時の確認（削除通知）設定を更新・保存する。
   */
  async function handleChangeConfirmIndexDeletion(enabled: boolean): Promise<void> {
    try {
      setIsSavingConfirmIndexDeletion(true);
      setConfirmIndexDeletion(enabled);
      await updateAppSettings({ confirm_index_deletion: enabled });
      setNoticeMessage(
        enabled
          ? "インデックス削除時の確認通知を有効にしました。"
          : "インデックス削除時の確認通知を無効にしました。",
      );
    } catch (error) {
      setConfirmIndexDeletion(!enabled);
      setErrorMessage(error instanceof Error ? error.message : "削除通知設定の更新に失敗しました。");
    } finally {
      setIsSavingConfirmIndexDeletion(false);
    }
  }

  /** Web 用の除外キーワードの下書きへ 1 件追記する（保存は設定メニューで行う）。 */
  function appendWebExcludeKeywordDraft(keyword: string): void {
    setWebExcludeKeywordsDraft((current) => normalizeExcludeKeywords([current, keyword].filter(Boolean).join("\n")));
  }

  /** 読み込んだ共有設定を、保存済みの値と下書きの両方へ反映する。 */
  function applyLoadedSettings(appSettings: AppSettings): void {
    const loadedWebExcludeKeywords = normalizeExcludeKeywords(appSettings.web_exclude_keywords);
    const loadedObsidianDataPath = appSettings.obsidian_sidebar_explorer_data_path.trim();
    const loadedGanttParent = normalizeGanttParent(appSettings.gantt_parent);
    setSavedWebExcludeKeywords(loadedWebExcludeKeywords);
    setWebExcludeKeywordsDraft(loadedWebExcludeKeywords);
    setWebFetchMode(appSettings.web_fetch_mode ?? "http");
    setSavedObsidianSidebarExplorerDataPath(loadedObsidianDataPath);
    setObsidianSidebarExplorerDataPathDraft(loadedObsidianDataPath);
    setSavedGanttParent(loadedGanttParent);
    setGanttParentDraft(String(loadedGanttParent));
    setConfirmIndexDeletion(appSettings.confirm_index_deletion ?? true);
  }

  return {
    appendWebExcludeKeywordDraft,
    applyLoadedSettings,
    confirmIndexDeletion,
    ganttParentDraft,
    handleChangeConfirmIndexDeletion,
    handleChangeWebFetchMode,
    handleSaveGanttParent,
    handleSaveObsidianSidebarExplorerDataPath,
    handleSaveWebExcludeKeywords,
    hasUnsavedGanttParent,
    hasUnsavedObsidianSidebarExplorerDataPath,
    hasUnsavedWebExcludeKeywords,
    isSavingConfirmIndexDeletion,
    isSavingGanttParent,
    isSavingObsidianSidebarExplorerDataPath,
    isSavingWebExcludeKeywords,
    isSavingWebFetchMode,
    obsidianSidebarExplorerDataPathDraft,
    setGanttParentDraft,
    setObsidianSidebarExplorerDataPathDraft,
    setWebExcludeKeywordsDraft,
    webExcludeKeywordsDraft,
    webFetchMode,
  } as const;
}

export type UseGeneralSettingsResult = ReturnType<typeof useGeneralSettings>;
