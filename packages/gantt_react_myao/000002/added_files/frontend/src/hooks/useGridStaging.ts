/**
 * グリッド編集（/grid）のステージング管理フック
 *
 * グリッド上の編集は本データに直接反映せず、バックエンドのステージングテーブルに保持する。
 * - グリッド画面を開いたときにステージングを本データで初期化する
 * - 本データとの差分一覧を保持し、個別の「元に戻す」と一括アップロード（コミット）を提供する
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../services/api';
import type { GridDiffItem } from '../types/gantt';

interface UseGridStagingOptions {
  /** グリッド画面を表示中かどうか */
  active: boolean;
  /** コミット後に本データを再取得する */
  onCommitted: () => Promise<void>;
}

export function useGridStaging({ active, onCommitted }: UseGridStagingOptions) {
  const [diffs, setDiffs] = useState<GridDiffItem[]>([]);
  const [selectedDiff, setSelectedDiff] = useState<GridDiffItem | null>(null);
  const [committing, setCommitting] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const refreshDiffs = useCallback(async () => {
    const result = await api.getGridDiff();
    if (result.success && result.data) {
      setDiffs(result.data.diffs);
    }
  }, []);

  // グリッド画面に入ったらステージングを初期化し、離れたら状態を捨てる
  useEffect(() => {
    if (!active) {
      setInitialized(false);
      setDiffs([]);
      setSelectedDiff(null);
      return;
    }
    if (initialized) return;

    let cancelled = false;
    void api.initGrid().then(async (result) => {
      if (cancelled || !result.success) return;
      setInitialized(true);
      await refreshDiffs();
    });
    return () => {
      cancelled = true;
    };
  }, [active, initialized, refreshDiffs]);

  /** ステージングの差分を本データへ一括反映する */
  const commit = useCallback(async () => {
    setCommitting(true);
    try {
      const result = await api.commitGrid();
      if (!result.success || !result.data) return;

      const { updated_tasks, updated_links, errors } = result.data;
      if (errors.length > 0) {
        alert(`アップロードにエラーがありました: ${errors.join(', ')}`);
      } else {
        alert(`アップロード完了: Tasks ${updated_tasks}件, Links ${updated_links}件`);
      }
      await onCommitted();
      await api.initGrid();
      setDiffs([]);
      setSelectedDiff(null);
    } finally {
      setCommitting(false);
    }
  }, [onCommitted]);

  /** 指定した差分1件を破棄し、本データの値に戻す */
  const revert = useCallback(async (item: GridDiffItem) => {
    const result = await api.revertGridDiff(item.table, item.id, item.field);
    if (!result.success) {
      alert(`元に戻す処理に失敗しました: ${result.error}`);
      return;
    }
    await refreshDiffs();
    setSelectedDiff((selected) =>
      selected?.id === item.id && selected?.field === item.field ? null : selected
    );
  }, [refreshDiffs]);

  return { diffs, selectedDiff, setSelectedDiff, committing, refreshDiffs, commit, revert };
}
