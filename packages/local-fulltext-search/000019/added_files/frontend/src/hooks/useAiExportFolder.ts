/**
 * AIインプット用ドキュメントの保存先フォルダの設定。
 * 保存先・既定の選択件数・図面 PDF の最大サイズ（MB、既定 10）はサーバーに保存し、次回の起動時にも同じ値を使う。
 * 図面 PDF の最大サイズは入力欄の文字をそのまま持ち、0 より大きい数のときだけ値を変えてサーバーへ保存する
 * （それ以外は直前の有効な値を使い続ける）。
 */
import type * as React from "react";
import { useEffect, useState } from "react";
import { getAiExportConfig, openExportFolder, saveAiExportConfig } from "../api/client";
import type { SearchResult } from "../types";

/** 図面 PDF の最大サイズの既定値（MB）。これを超えると図の境目で分割する */
export const DEFAULT_FIGURE_PDF_MAX_MB = 10;

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
  const [figurePdfMaxMb, setFigurePdfMaxMb] = useState<number>(DEFAULT_FIGURE_PDF_MAX_MB);
  const [figurePdfMaxMbText, setFigurePdfMaxMbText] = useState<string>(String(DEFAULT_FIGURE_PDF_MAX_MB));

  // サーバーに保存されたエクスポートフォルダ設定およびデフォルト選択数を初期ロード（次回起動時も自動適用）
  useEffect(() => {
    getAiExportConfig()
      .then((cfg) => {
        if (cfg?.export_folder) {
          setExportFolder(cfg.export_folder);
          setTempExportFolder(cfg.export_folder);
        }
        if (typeof cfg?.figure_pdf_max_mb === "number" && cfg.figure_pdf_max_mb > 0) {
          setFigurePdfMaxMb(cfg.figure_pdf_max_mb);
          setFigurePdfMaxMbText(String(cfg.figure_pdf_max_mb));
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

  // 図面 PDF の最大サイズ（MB）の変更。0 より大きい数のときだけ使い、サーバーへ保存する
  const handleFigurePdfMaxMbChange = async (valStr: string) => {
    setFigurePdfMaxMbText(valStr);
    const parsed = Number(valStr);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    setFigurePdfMaxMb(parsed);
    try {
      await saveAiExportConfig({ figure_pdf_max_mb: parsed });
    } catch (e) {
      console.warn("図面PDFの最大サイズの保存に失敗しました:", e);
    }
  };

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
    figurePdfMaxMb,
    figurePdfMaxMbText,
    handleFigurePdfMaxMbChange,
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
