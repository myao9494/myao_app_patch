/**
 * AIインプット用ドキュメントの保存先フォルダの設定。
 * 保存先と既定の選択件数はサーバーに保存し、次回の起動時にも同じ値を使う。
 */
import type * as React from "react";
import { useEffect, useState } from "react";
import { getAiExportConfig, openExportFolder, saveAiExportConfig } from "../api/client";
import type { SearchResult } from "../types";

type UseAiExportFolderDeps = {
  applyAutoSelectTopN: (targetCandidates: SearchResult[], count: number) => void;
  candidates: SearchResult[];
  setDefaultSelectCount: React.Dispatch<React.SetStateAction<number>>;
};

export function useAiExportFolder({
  applyAutoSelectTopN,
  candidates,
  setDefaultSelectCount,
}: UseAiExportFolderDeps) {
  const [exportFolder, setExportFolder] = useState<string>("~/Desktop/AI_Inputs");
  const [tempExportFolder, setTempExportFolder] = useState<string>("~/Desktop/AI_Inputs");
  const [isFolderConfigOpen, setIsFolderConfigOpen] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [configToast, setConfigToast] = useState<string | null>(null);
  const [isOpeningFolder, setIsOpeningFolder] = useState(false);

  // サーバーに保存されたエクスポートフォルダ設定およびデフォルト選択数を初期ロード（次回起動時も自動適用）
  useEffect(() => {
    getAiExportConfig()
      .then((cfg) => {
        if (cfg?.export_folder) {
          setExportFolder(cfg.export_folder);
          setTempExportFolder(cfg.export_folder);
        }
        if (cfg?.default_select_count !== undefined && cfg.default_select_count >= 0) {
          const loadedCount = cfg.default_select_count;
          setDefaultSelectCount(loadedCount);
          // 初期候補が存在する場合は復元されたカウントで自動選択
          if (candidates.length > 0) {
            applyAutoSelectTopN(candidates, loadedCount);
          }
        }
      })
      .catch((err) => {
        console.warn("保存先設定の取得に失敗しました:", err);
      });
  }, []);

  // 設定トーストの自動消去
  useEffect(() => {
    if (!configToast) return;
    const timer = setTimeout(() => setConfigToast(null), 3000);
    return () => clearTimeout(timer);
  }, [configToast]);

  // 出力先フォルダを OS で開く (Finder / Explorer)
  const handleOpenFolder = async () => {
    setIsOpeningFolder(true);
    try {
      await openExportFolder(exportFolder);
    } catch (err: any) {
      alert(`フォルダを開けませんでした: ${err.message}`);
    } finally {
      setIsOpeningFolder(false);
    }
  };

  // 保存先フォルダ設定をサーバーに永続保存する
  const handleSaveExportFolderConfig = async () => {
    const trimmed = tempExportFolder.trim();
    if (!trimmed) {
      alert("保存先フォルダのパスを入力してください");
      return;
    }
    setIsSavingConfig(true);
    try {
      const res = await saveAiExportConfig(trimmed);
      if (res?.export_folder) {
        setExportFolder(res.export_folder);
        setTempExportFolder(res.export_folder);
      }
      setConfigToast(`✅ 保存先フォルダを設定しました: ${res.export_folder}`);
      setIsFolderConfigOpen(false);
    } catch (err: any) {
      alert(`保存先フォルダの設定保存に失敗しました: ${err.message}`);
    } finally {
      setIsSavingConfig(false);
    }
  };

  return {
    configToast,
    exportFolder,
    handleOpenFolder,
    handleSaveExportFolderConfig,
    isFolderConfigOpen,
    isOpeningFolder,
    isSavingConfig,
    setExportFolder,
    setIsFolderConfigOpen,
    setTempExportFolder,
    tempExportFolder,
  } as const;
}

export type UseAiExportFolderResult = ReturnType<typeof useAiExportFolder>;
