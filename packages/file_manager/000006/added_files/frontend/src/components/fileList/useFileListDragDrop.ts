/**
 * ファイル一覧のドラッグ&ドロップ
 * - アプリ内ドラッグ: 選択中の行をドラッグすると選択項目をまとめて移動する（選択外の行はその1件だけ）
 *   ドラッグ中の項目とドラッグ元ペインは fileListShared に置き、別のペインへのドロップでも受け取れるようにする
 * - 同じペイン内への移動は誤操作防止のため確認する（キャンセルしたら何もしない）
 * - 3件以上またはフォルダを含む移動は非同期（進捗モーダル）で依頼する
 *   （クライアント側での再帰カウントは NAS 等で遅いため行わない）
 * - OS（Explorer / Finder）からのドロップはアップロード。フォルダは階層を保ち、同名は別名で保存される
 */
import { useState, type DragEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { uploadFiles } from "../../api/files";
import type { FileItem } from "../../types/file";
import { scanDataTransferItems } from "../../utils/dragDropScan";
import { fileListShared } from "./sharedState";

interface DragDropOptions {
  panelId: string;
  currentPath: string | null;
  visibleItems: FileItem[];
  selectedItems: Set<string>;
  startMove: (srcPaths: string[], destPath: string, asyncMode: boolean) => void;
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
}

function clearDraggedItems() {
  fileListShared.draggedItems = [];
  fileListShared.dragSourcePanelId = null;
}

/** dataTransfer の text/plain から項目を読む（別ウィンドウなどからのドラッグ用） */
function readItemsFromDataTransfer(dataTransfer: DataTransfer): FileItem[] {
  const data = dataTransfer.getData("text/plain");
  if (!data) return [];
  try {
    const parsed: unknown = JSON.parse(data);
    return (Array.isArray(parsed) ? parsed : [parsed]) as FileItem[];
  } catch {
    console.error("Invalid drag data json");
    return [];
  }
}

export function useFileListDragDrop({
  panelId,
  currentPath,
  visibleItems,
  selectedItems,
  startMove,
  showSuccess,
  showError,
}: DragDropOptions) {
  const queryClient = useQueryClient();
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);

  const handleDragStart = (e: DragEvent, item: FileItem) => {
    const dragData = selectedItems.has(item.path)
      ? visibleItems.filter((i) => selectedItems.has(i.path))
      : [item];
    if (!dragData.some((d) => d.path === item.path)) {
      dragData.push(item);
    }

    fileListShared.draggedItems = dragData;
    fileListShared.dragSourcePanelId = panelId;

    // dataTransfer にもセット（互換性のため）
    e.dataTransfer.setData("text/plain", JSON.stringify(dragData));
    e.dataTransfer.effectAllowed = "copyMove";
  };

  const handleDragOver = (e: DragEvent, targetPath: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverPath(targetPath);
  };

  const handleDragLeave = () => {
    setDragOverPath(null);
  };

  const upload = async (targetPath: string, dataTransfer: DataTransfer) => {
    try {
      const { files, emptyDirectories } = await scanDataTransferItems(dataTransfer);
      let result;
      if (files.length + emptyDirectories.length === 0) {
        // 何も取得できなかった場合はファイル一覧だけを送る
        if (!dataTransfer.files || dataTransfer.files.length === 0) return;
        const fallbackFiles = Array.from(dataTransfer.files);
        showSuccess(`アップロード開始: ${fallbackFiles.length}件`);
        result = await uploadFiles(targetPath, fallbackFiles);
      } else {
        const details = [
          files.length > 0 ? `${files.length}件のファイル` : "",
          emptyDirectories.length > 0 ? `${emptyDirectories.length}件のフォルダ` : "",
        ].filter(Boolean).join("、");
        showSuccess(`アップロード開始: ${details}`);
        result = await uploadFiles(targetPath, files, emptyDirectories);
      }
      if (result.status === "success" || result.status === "partial_success") {
        showSuccess(result.message);
        queryClient.invalidateQueries({ queryKey: ["files"] });
      } else {
        showError(result.message || "アップロードに失敗しました");
      }
    } catch (err) {
      showError(`アップロードエラー: ${String(err)}`);
    }
  };

  const handleDrop = async (e: DragEvent, targetPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverPath(null);

    const isOsDrop = fileListShared.draggedItems.length === 0 && (
      (e.dataTransfer.files && e.dataTransfer.files.length > 0) ||
      (e.dataTransfer.items && Array.from(e.dataTransfer.items).some((item) => item.kind === "file"))
    );
    if (isOsDrop) {
      await upload(targetPath, e.dataTransfer);
      return;
    }

    const items = fileListShared.draggedItems.length > 0
      ? fileListShared.draggedItems
      : readItemsFromDataTransfer(e.dataTransfer);
    const srcPaths = items.filter((item) => item.path !== targetPath).map((item) => item.path);

    if (srcPaths.length > 0) {
      const isSamePane = fileListShared.dragSourcePanelId !== null && fileListShared.dragSourcePanelId === panelId;
      if (isSamePane && !confirm("同じペイン内での移動です。よろしいですか？")) {
        clearDraggedItems();
        return;
      }
      const hasDirectory = items.some((item) => item.type === "directory");
      startMove(srcPaths, targetPath, srcPaths.length >= 3 || hasDirectory);
    }
    clearDraggedItems();
  };

  // ペインの余白へのドロップは現在のフォルダへ
  const handlePanelDrop = (e: DragEvent) => {
    e.preventDefault();
    if (currentPath) {
      void handleDrop(e, currentPath);
    }
  };

  return { dragOverPath, handleDragStart, handleDragOver, handleDragLeave, handleDrop, handlePanelDrop };
}
