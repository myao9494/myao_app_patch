/**
 * インデックス取得に失敗したファイル一覧（設定ドロワー内）の開閉と読み込み。
 */
import type * as React from "react";
import { useState } from "react";
import { fetchFailedFiles } from "../api/client";
import type { FailedFile } from "../types";

type UseFailedFilesDeps = {
  setErrorMessage: React.Dispatch<React.SetStateAction<string>>;
  setNoticeMessage: React.Dispatch<React.SetStateAction<string>>;
};

export function useFailedFiles({
  setErrorMessage,
  setNoticeMessage,
}: UseFailedFilesDeps) {
  const [isFailedFilesOpen, setIsFailedFilesOpen] = useState(false);
  const [failedFiles, setFailedFiles] = useState<FailedFile[]>([]);

  async function handleToggleFailedFiles(): Promise<void> {
    const nextOpen = !isFailedFilesOpen;
    setIsFailedFilesOpen(nextOpen);
    if (!nextOpen) {
      return;
    }
    try {
      const response = await fetchFailedFiles();
      setFailedFiles(response.items);
      setErrorMessage("");
      setNoticeMessage("");
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "失敗したファイル一覧の取得に失敗しました。");
    }
  }

  /** 一覧を開いているときだけ、最新の内容を読み込み直す（検索でインデックスが更新されたあとに呼ぶ）。 */
  async function refreshFailedFilesIfOpen(): Promise<void> {
    if (!isFailedFilesOpen) {
      return;
    }
    const response = await fetchFailedFiles();
    setFailedFiles(response.items);
  }

  /** 一覧を空にして閉じる（データベースを初期化したあとに呼ぶ）。 */
  function resetFailedFiles(): void {
    setFailedFiles([]);
    setIsFailedFilesOpen(false);
  }

  return {
    failedFiles,
    handleToggleFailedFiles,
    isFailedFilesOpen,
    refreshFailedFilesIfOpen,
    resetFailedFiles,
  } as const;
}

export type UseFailedFilesResult = ReturnType<typeof useFailedFiles>;
