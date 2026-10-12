/**
 * インデックス処理の実行状態（待機中・取得中・中止中）の取得と、中止操作。
 */
import type * as React from "react";
import { useState } from "react";
import { cancelIndexing, fetchIndexStatus } from "../api/client";
import type { IndexStatus } from "../types";

type UseIndexStatusDeps = {
  setErrorMessage: React.Dispatch<React.SetStateAction<string>>;
  setNoticeMessage: React.Dispatch<React.SetStateAction<string>>;
};

export function useIndexStatus({
  setErrorMessage,
  setNoticeMessage,
}: UseIndexStatusDeps) {
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [isCancellingIndex, setIsCancellingIndex] = useState(false);
  const isIndexCancelling = Boolean(indexStatus?.is_running && indexStatus?.cancel_requested);
  const isIndexRunning = Boolean(indexStatus?.is_running && !indexStatus?.cancel_requested);
  const indexStatusLabel = isIndexCancelling ? "インデックス取得を中止中" : isIndexRunning ? "インデックス取得中" : "インデックス待機中";
  const indexStatusTone = isIndexCancelling ? "cancelling" : isIndexRunning ? "running" : "idle";

  async function refreshIndexStatus(): Promise<IndexStatus> {
    const response = await fetchIndexStatus();
    setIndexStatus(response);
    return response;
  }

  /**
   * 実行中のインデックスへ中止要求を送り、完了するまでステータス表示を追従させる。
   */
  async function handleCancelIndexing(): Promise<void> {
    if (isCancellingIndex || !indexStatus?.is_running) {
      return;
    }

    try {
      setIsCancellingIndex(true);
      setErrorMessage("");
      setNoticeMessage("");
      const response = await cancelIndexing();
      setIndexStatus(response.status);
      setNoticeMessage("インデックス中止をリクエストしました。停止完了まで少し待つ場合があります。");
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "インデックス中止に失敗しました。");
    } finally {
      setIsCancellingIndex(false);
    }
  }

  /** サーバーの応答に含まれていた最新の状態を表示へ反映する（データベースの初期化後など）。 */
  function applyIndexStatus(status: IndexStatus): void {
    setIndexStatus(status);
  }

  return {
    applyIndexStatus,
    handleCancelIndexing,
    indexStatus,
    indexStatusLabel,
    indexStatusTone,
    isCancellingIndex,
    isIndexCancelling,
    refreshIndexStatus,
  } as const;
}

export type UseIndexStatusResult = ReturnType<typeof useIndexStatus>;
