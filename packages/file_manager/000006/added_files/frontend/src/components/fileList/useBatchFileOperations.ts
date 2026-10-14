/**
 * ファイル一覧の削除・移動・コピー（同期・非同期共通）
 * - 削除: 確認モーダル → ゴミ箱へ移動。3件以上またはフォルダを含む場合は非同期（進捗モーダル）
 *   ロック中の項目は、利用者の同意を得てプロセスを終了してから再試行する
 * - 移動/コピー: 同名衝突は上書き確認を出し、確認した場合だけ overwrite=true で再実行する（常に進捗表示付き）
 * - Undo 履歴には実際に成功した項目だけを記録する（docs/file_safety.md）
 * - 非同期タスクの完了時は FileListProgressModal から結果を受け取り、同期と同じ処理で表示する
 */
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCopyItemsBatch, useDeleteItemsBatch, useMoveItemsBatch } from "../../hooks/useFiles";
import { stampOperation, type OperationHistoryEntry } from "../../hooks/useOperationHistory";
import type { BatchOperationResult, FileItem } from "../../types/file";
import {
  classifyBatchResults,
  collectLockingProcesses,
  formatLockingProcesses,
  getTransferHistoryData,
  toBatchOperationResult,
} from "../../utils/batchResult";
import { errorMessage } from "../../utils/errorMessage";
import { clearFileListClipboard } from "./sharedState";

export type BatchOperationType = "move" | "copy" | "delete";

interface BatchFileOperationsOptions {
  selectedItems: Set<string>;
  setSelectedItems: (items: Set<string>) => void;
  allSortedItems: FileItem[];
  showError: (message: string) => void;
  showSuccess: (message: string) => void;
  addOperation: (operation: OperationHistoryEntry) => void;
  restorePaneFocus: () => void;
}

export function useBatchFileOperations({
  selectedItems,
  setSelectedItems,
  allSortedItems,
  showError,
  showSuccess,
  addOperation,
  restorePaneFocus,
}: BatchFileOperationsOptions) {
  const queryClient = useQueryClient();
  const deleteItemsBatch = useDeleteItemsBatch();
  const moveItemsBatch = useMoveItemsBatch();
  const copyItemsBatch = useCopyItemsBatch();

  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [itemsToDelete, setItemsToDelete] = useState<Set<string>>(new Set());
  const [progressModalOpen, setProgressModalOpen] = useState(false);
  const [progressTaskId, setProgressTaskId] = useState<string | null>(null);
  const [progressOperationType, setProgressOperationType] = useState<BatchOperationType>("move");
  // 非同期の移動/コピー・削除が完了したときに結果を処理するための文脈
  const pendingTransferRef = useRef<{ operation: "copy" | "move"; destPath: string } | null>(null);
  const pendingDeleteDebugModeRef = useRef(false);

  // 選択項目を削除（確認モーダルを表示）
  const handleDeleteSelected = () => {
    if (selectedItems.size === 0) return;
    setItemsToDelete(new Set(selectedItems));
    setIsDeleteModalOpen(true);
  };

  // メニューからの削除リクエスト
  const handleRequestDeleteFromMenu = (item: FileItem) => {
    setItemsToDelete(new Set([item.path]));
    setIsDeleteModalOpen(true);
  };

  // 削除結果の表示（同期・非同期共通）。ロック中の項目は利用者の同意を得てプロセス終了→再試行する
  const handleDeleteResult = async (
    result: BatchOperationResult,
    debugMode: boolean,
    allowKillRetry: boolean = true
  ) => {
    const { succeeded, locked, otherErrors, conflicts } = classifyBatchResults(result.results);

    if (succeeded.length > 0) {
      showSuccess(`${succeeded.length}件削除しました`);
      addOperation(stampOperation({ type: "DELETE", canUndo: false, data: {} }));
    }

    if (locked.length > 0 && allowKillRetry) {
      const processes = collectLockingProcesses(locked);
      const message =
        `ファイルが以下のプロセスによって使用されているため、削除できません。\n\n${formatLockingProcesses(processes)}\n\n` +
        "プロセスを強制終了(Kill)して削除を再試行しますか？\n(※未保存のデータが失われる可能性があります)";
      if (window.confirm(message)) {
        try {
          const retry = await deleteItemsBatch.mutateAsync({
            paths: locked.map((r) => r.path),
            asyncMode: false,
            debugMode,
            forceKillPids: processes.map((p) => p.pid),
          });
          await handleDeleteResult(toBatchOperationResult(retry), debugMode, false);
        } catch (retryErr) {
          showError(`プロセスの強制終了または削除に失敗しました: ${errorMessage(retryErr)}`);
        }
      }
    }

    const failures = [...otherErrors, ...conflicts, ...(allowKillRetry ? [] : locked)];
    if (failures.length > 0) {
      failures.forEach((r) => console.error(`Failed to delete ${r.path}: ${r.message}`));
      showError(`${failures.length}件の削除に失敗しました: ${failures[0].message}`);
    }
    queryClient.invalidateQueries({ queryKey: ["files"] });
  };

  // 削除の実行（ゴミ箱へ移動。ゴミ箱に入れられない場合はエラーとして残す）
  const handleConfirmDelete = async () => {
    if (itemsToDelete.size === 0) return;

    const debugMode = localStorage.getItem('file_manager_debug_mode') === 'true';
    const paths = Array.from(itemsToDelete);

    // 3件以上 または フォルダを含む場合は非同期モード（進捗モーダル表示）
    const hasDirectory = paths.some(path => {
      const item = allSortedItems.find(i => i.path === path);
      return item && item.type === 'directory';
    });
    const useAsyncMode = paths.length >= 3 || hasDirectory;

    try {
      const result = await deleteItemsBatch.mutateAsync({ paths, asyncMode: useAsyncMode, debugMode });

      setSelectedItems(new Set());
      setItemsToDelete(new Set());
      setIsDeleteModalOpen(false);
      restorePaneFocus();

      if (result.status === 'async' && result.task_id) {
        pendingDeleteDebugModeRef.current = debugMode;
        setProgressOperationType('delete');
        setProgressTaskId(result.task_id);
        setProgressModalOpen(true);
        return;
      }
      await handleDeleteResult(toBatchOperationResult(result), debugMode);
    } catch (err) {
      console.error("Delete failed:", err);
      showError(`削除に失敗しました: ${errorMessage(err)}`);
    }
  };

  // 移動/コピーを開始する（同期・非同期共通）。結果は handleBatchOperationResult で処理する
  const startBatchTransfer = (
    operation: 'copy' | 'move',
    srcPaths: string[],
    destPath: string,
    useAsyncMode: boolean,
    overwrite: boolean = false
  ) => {
    const verifyChecksum = localStorage.getItem('file_manager_verify_checksum') === 'true';
    const debugMode = localStorage.getItem('file_manager_debug_mode') === 'true';
    const mutation = operation === 'copy' ? copyItemsBatch : moveItemsBatch;
    const opName = operation === 'copy' ? 'コピー' : '移動';

    mutation.mutateAsync({ srcPaths, destPath, overwrite, verifyChecksum, asyncMode: useAsyncMode, debugMode })
      .then((result) => {
        if (result.status === 'async' && result.task_id) {
          pendingTransferRef.current = { operation, destPath };
          setProgressOperationType(operation);
          setProgressTaskId(result.task_id);
          setProgressModalOpen(true);
          return;
        }
        void handleBatchOperationResult(operation, toBatchOperationResult(result), destPath);
      })
      .catch((err) => {
        console.error(`Batch ${operation} failed:`, err);
        showError(`${opName}処理中にエラーが発生しました: ${errorMessage(err)}`);
      });
  };

  // 移動/コピー結果の共通ハンドラ（成功分だけ履歴に残し、同名衝突は上書き確認を出す）
  const handleBatchOperationResult = async (
    operation: 'copy' | 'move',
    result: BatchOperationResult,
    targetPath: string
  ) => {
    const opName = operation === 'copy' ? 'コピー' : '移動';
    const { succeeded, conflicts, locked, otherErrors } = classifyBatchResults(result.results);

    const history = getTransferHistoryData(operation, result.results, targetPath);
    if (history) {
      addOperation(stampOperation({ ...history, canUndo: true }));
    }

    if (succeeded.length > 0) {
      showSuccess(`${succeeded.length}件${opName}しました`);
      if (operation === 'move') {
        clearFileListClipboard();
        setSelectedItems(new Set());
      }
    }
    queryClient.invalidateQueries({ queryKey: ["files"] });

    const failures = [...locked, ...otherErrors];
    if (failures.length > 0) {
      failures.forEach((r) => console.error(`Failed to ${operation} ${r.path}: ${r.message}`));
      showError(`${failures.length}件の${opName}に失敗しました: ${failures[0].message}`);
    }

    if (conflicts.length > 0) {
      const message =
        `${conflicts.length}件のファイルが既に存在します。上書きしますか？\n` +
        "（上書きされる既存のファイルはゴミ箱に移動します。フォルダは統合され、移動先にだけあるファイルは残ります）";
      if (confirm(message)) {
        // 上書きは件数が少なくても時間がかかることがあるため、常に進捗表示付きで実行する
        startBatchTransfer(operation, conflicts.map((r) => r.path), targetPath, true, true);
      }
    }
  };

  // 非同期タスクの完了（進捗モーダルから呼ばれる）
  const handleProgressComplete = (result: BatchOperationResult | undefined) => {
    const operation = progressOperationType;
    setProgressModalOpen(false);
    setProgressTaskId(null);
    queryClient.invalidateQueries({ queryKey: ["files"] });
    if (!result) return;

    if (operation === "delete") {
      void handleDeleteResult(result, pendingDeleteDebugModeRef.current);
      return;
    }
    const context = pendingTransferRef.current;
    pendingTransferRef.current = null;
    if (context) {
      void handleBatchOperationResult(context.operation, result, context.destPath);
    }
  };

  const handleProgressClose = () => {
    setProgressModalOpen(false);
    setProgressTaskId(null);
  };

  return {
    startBatchTransfer,
    handleDeleteSelected,
    handleRequestDeleteFromMenu,
    deleteConfirm: {
      isOpen: isDeleteModalOpen,
      items: itemsToDelete,
      onConfirm: handleConfirmDelete,
      onClose: () => setIsDeleteModalOpen(false),
    },
    progress: {
      isOpen: progressModalOpen,
      taskId: progressTaskId,
      operationType: progressOperationType,
      onComplete: handleProgressComplete,
      onClose: handleProgressClose,
    },
  };
}

export type BatchFileOperations = ReturnType<typeof useBatchFileOperations>;
