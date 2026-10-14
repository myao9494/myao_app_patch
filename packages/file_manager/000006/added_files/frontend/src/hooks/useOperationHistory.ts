/**
 * ファイル操作の履歴管理フック
 * Undo/Redo機能を提供
 *
 * 対応する操作:
 * - MOVE: ファイル/フォルダの移動（逆操作: 元の位置に戻す）
 * - RENAME: ファイル/フォルダのリネーム（逆操作: 元の名前に戻す）
 * - COPY: ファイル/フォルダのコピー（逆操作: コピーしたファイルを削除）
 * - CREATE_FOLDER: フォルダ作成（逆操作: 作成したフォルダを削除）
 * - CREATE_FILE: ファイル作成（逆操作: 作成したファイルを削除）
 *
 * 戻れない操作（通知のみ）:
 * - DELETE: ファイル/フォルダの削除
 * - UPDATE_FILE: ファイル内容の更新
 */

import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  moveItem,
  renameItem,
  deleteItem,
  createFolder,
  createFile,
} from "../api/files";

// 操作の種類
export type OperationType =
  | "MOVE"
  | "RENAME"
  | "COPY"
  | "CREATE_FOLDER"
  | "CREATE_FILE"
  | "DELETE"
  | "UPDATE_FILE";

// 操作履歴のエントリ
export interface OperationHistoryEntry {
  type: OperationType;
  canUndo: boolean; // Undo可能かどうか
  timestamp: number;
  data: {
    // MOVE用（単一）
    srcPath?: string;
    destPath?: string;
    // MOVE用（一括）- 複数ファイルの移動
    srcPaths?: string[];
    destParentPath?: string; // 移動先の親ディレクトリ
    // RENAME用
    oldPath?: string;
    newPath?: string;
    oldName?: string;
    newName?: string;
    // COPY用（単一）
    copiedPath?: string; // コピーで作成されたファイルのパス
    // COPY用（一括）- 複数ファイルのコピー
    copiedPaths?: string[]; // コピーで作成されたファイルのパス配列
    originalPaths?: string[]; // 元のファイルパス配列（参照用）
    // CREATE_FOLDER, CREATE_FILE用
    createdPath?: string;
    // CREATE_FILE用（内容を保存してUndo時に復元できるようにする場合）
    content?: string;
  };
}

// 履歴に記録する時刻を付ける（操作を実行したときに呼ぶ）
export function stampOperation(entry: Omit<OperationHistoryEntry, "timestamp">): OperationHistoryEntry {
  return { ...entry, timestamp: Date.now() };
}

export function useOperationHistory() {
  const queryClient = useQueryClient();
  const [undoStack, setUndoStack] = useState<OperationHistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<OperationHistoryEntry[]>([]);

  /**
   * 操作を履歴に追加
   */
  const addOperation = useCallback((entry: OperationHistoryEntry) => {
    setUndoStack((prev) => [...prev, entry]);
    setRedoStack([]); // 新しい操作が追加されたらRedoスタックをクリア
  }, []);

  /**
   * Undo操作を実行
   */
  const undo = useCallback(async (): Promise<{ success: boolean; message: string }> => {
    if (undoStack.length === 0) {
      return { success: false, message: "元に戻す操作がありません" };
    }

    const operation = undoStack[undoStack.length - 1];

    // Undo不可能な操作の場合
    if (!operation.canUndo) {
      return {
        success: false,
        message: `この操作（${getOperationName(operation.type)}）は元に戻せません`,
      };
    }

    try {
      // 操作に応じた逆操作を実行
      switch (operation.type) {
        case "MOVE":
          // 移動の逆操作: 元の位置に戻す
          if (operation.data.srcPaths && operation.data.destParentPath) {
            // 一括移動の逆操作: 各ファイルを元の位置に戻す
            for (const srcPath of operation.data.srcPaths) {
              const fileName = srcPath.split("/").pop() || "";
              const movedPath = `${operation.data.destParentPath}/${fileName}`;
              const originalParent = srcPath.substring(0, srcPath.lastIndexOf("/"));
              await moveItem(movedPath, originalParent);
            }
          } else if (operation.data.srcPath && operation.data.destPath) {
            // 単一移動の逆操作
            const fileName = operation.data.srcPath.split("/").pop() || "";
            const movedPath = `${operation.data.destPath}/${fileName}`;
            await moveItem(movedPath, operation.data.srcPath);
          }
          break;

        case "RENAME":
          // リネームの逆操作: 元の名前に戻す
          if (operation.data.newPath && operation.data.oldName) {
            await renameItem(operation.data.newPath, operation.data.oldName);
          }
          break;

        case "COPY":
          // コピーの逆操作: コピーしたファイルを削除
          if (operation.data.copiedPaths) {
            // 一括コピーの逆操作: 各コピーされたファイルを削除
            for (const copiedPath of operation.data.copiedPaths) {
              await deleteItem(copiedPath);
            }
          } else if (operation.data.copiedPath) {
            // 単一コピーの逆操作
            await deleteItem(operation.data.copiedPath);
          }
          break;

        case "CREATE_FOLDER":
        case "CREATE_FILE":
          // 作成の逆操作: 作成したファイル/フォルダを削除
          if (operation.data.createdPath) {
            await deleteItem(operation.data.createdPath);
          }
          break;

        default:
          return { success: false, message: "未対応の操作です" };
      }

      // Undo成功: UndoスタックからRedoスタックへ移動
      setUndoStack((prev) => prev.slice(0, -1));
      setRedoStack((prev) => [...prev, operation]);

      // ファイルリストを更新
      queryClient.invalidateQueries({ queryKey: ["files"] });

      return { success: true, message: `${getOperationName(operation.type)}を元に戻しました` };
    } catch (error) {
      return {
        success: false,
        message: `元に戻す操作に失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`,
      };
    }
  }, [queryClient, undoStack]);

  /**
   * Redo操作を実行
   */
  const redo = useCallback(async (): Promise<{ success: boolean; message: string }> => {
    if (redoStack.length === 0) {
      return { success: false, message: "やり直す操作がありません" };
    }

    const operation = redoStack[redoStack.length - 1];

    try {
      // 操作を再実行
      switch (operation.type) {
        case "MOVE":
          // 移動を再実行
          if (operation.data.srcPaths && operation.data.destParentPath) {
            // 一括移動の再実行: 元の位置からdestParentPathに移動
            for (const srcPath of operation.data.srcPaths) {
              // Undo後はsrcPathの位置にファイルが戻っているので、
              // srcPathからdestParentPathに再度移動
              await moveItem(srcPath, operation.data.destParentPath);
            }
          } else if (operation.data.srcPath && operation.data.destPath) {
            // 単一移動の再実行
            await moveItem(operation.data.srcPath, operation.data.destPath);
          }
          break;

        case "RENAME":
          // リネームを再実行
          if (operation.data.oldPath && operation.data.newName) {
            await renameItem(operation.data.oldPath, operation.data.newName);
          }
          break;

        case "COPY":
          // コピーは再実行が難しい（同じ名前のファイルが存在する場合がある）
          return {
            success: false,
            message: "コピー操作のやり直しは現在サポートされていません",
          };

        case "CREATE_FOLDER":
          // フォルダ作成を再実行
          if (operation.data.createdPath) {
            const parentPath = operation.data.createdPath.substring(
              0,
              operation.data.createdPath.lastIndexOf("/")
            );
            const folderName = operation.data.createdPath.split("/").pop() || "";
            await createFolder(parentPath, folderName);
          }
          break;

        case "CREATE_FILE":
          // ファイル作成を再実行
          if (operation.data.createdPath) {
            const parentPath = operation.data.createdPath.substring(
              0,
              operation.data.createdPath.lastIndexOf("/")
            );
            const fileName = operation.data.createdPath.split("/").pop() || "";
            await createFile(parentPath, fileName, operation.data.content || "");
          }
          break;

        default:
          return { success: false, message: "未対応の操作です" };
      }

      // Redo成功: RedoスタックからUndoスタックへ移動
      setRedoStack((prev) => prev.slice(0, -1));
      setUndoStack((prev) => [...prev, operation]);

      // ファイルリストを更新
      queryClient.invalidateQueries({ queryKey: ["files"] });

      return { success: true, message: `${getOperationName(operation.type)}をやり直しました` };
    } catch (error) {
      return {
        success: false,
        message: `やり直しに失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`,
      };
    }
  }, [queryClient, redoStack]);

  /**
   * 履歴をクリア
   */
  const clearHistory = useCallback(() => {
    setUndoStack([]);
    setRedoStack([]);
  }, []);

  /**
   * Undo/Redo可能かどうかを判定
   */
  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;

  return {
    addOperation,
    undo,
    redo,
    clearHistory,
    canUndo,
    canRedo,
    undoStack,
    redoStack,
  };
}

/**
 * 操作タイプの日本語名を取得
 */
function getOperationName(type: OperationType): string {
  switch (type) {
    case "MOVE":
      return "移動";
    case "RENAME":
      return "リネーム";
    case "COPY":
      return "コピー";
    case "CREATE_FOLDER":
      return "フォルダ作成";
    case "CREATE_FILE":
      return "ファイル作成";
    case "DELETE":
      return "削除";
    case "UPDATE_FILE":
      return "ファイル更新";
    default:
      return "不明な操作";
  }
}
