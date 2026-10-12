/**
 * ファイル一覧からの新規作成（フォルダ・テキストファイル・Markdown・Excalidraw）
 * - 既存の項目は上書きしない（同名があればバックエンドが 400 を返し、ダイアログを開いたままにする）
 * - 作成した項目は Undo 履歴に記録する
 * - Markdown は名前だけ決めてエディタを開き、保存したときに作成する
 * - Excalidraw は空の図面を作ってから Excalidraw で開く（obsidian 配下では .excalidraw.md）
 * - 作成後はこのペインにキーボード操作を戻す
 */
import { useState } from "react";
import { createFile, openInExcalidraw } from "../../api/files";
import { useCreateFolder } from "../../hooks/useFiles";
import { stampOperation, type OperationHistoryEntry } from "../../hooks/useOperationHistory";
import { errorMessage } from "../../utils/errorMessage";
import { buildExcalidrawFileName, buildMarkdownFileName, buildTextFileName } from "../../utils/textFileName";

interface FileCreationOptions {
  currentPath: string | null;
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
  addOperation: (operation: OperationHistoryEntry) => void;
  refetch: () => void;
  /** 新規 Markdown をエディタで開く（path は未保存なので null） */
  openNewMarkdown: (fileName: string) => void;
  /** 作成後にこのペインへフォーカスを戻す */
  onCreated: () => void;
}

export function useFileCreation({
  currentPath,
  showSuccess,
  showError,
  addOperation,
  refetch,
  openNewMarkdown,
  onCreated,
}: FileCreationOptions) {
  const createFolder = useCreateFolder();
  const [isFolderModalOpen, setIsFolderModalOpen] = useState(false);
  const [isTextFileModalOpen, setIsTextFileModalOpen] = useState(false);
  const [isMarkdownModalOpen, setIsMarkdownModalOpen] = useState(false);

  const recordCreatedFile = (createdPath: string) => {
    addOperation(stampOperation({ type: "CREATE_FILE", canUndo: true, data: { createdPath, content: "" } }));
  };

  // 失敗したら例外を投げてダイアログを開いたままにする
  const confirmCreateFolder = async (name: string) => {
    const parentPath = currentPath || "";
    try {
      await createFolder.mutateAsync({ parentPath, name });
      showSuccess(`フォルダ作成: ${name}`);
      addOperation(stampOperation({ type: "CREATE_FOLDER", canUndo: true, data: { createdPath: `${parentPath}/${name}` } }));
      onCreated();
    } catch (e) {
      console.error("Folder creation failed:", e);
      showError(`フォルダ作成に失敗しました: ${errorMessage(e)}`);
      throw e;
    }
  };

  const confirmCreateTextFile = async (name: string, extension: string) => {
    if (!name || !name.trim()) return;
    if (!currentPath) {
      showError("作成先フォルダが特定できません");
      return;
    }
    const filename = buildTextFileName(name, extension);
    try {
      const result = await createFile(currentPath, filename, "");
      showSuccess(`テキストファイル作成: ${filename}`);
      recordCreatedFile(result.path);
      refetch();
      onCreated();
    } catch (e) {
      console.error("Text file creation failed:", e);
      showError(`テキストファイル作成に失敗しました: ${errorMessage(e)}`);
      throw e;
    }
  };

  const confirmCreateMarkdown = (name: string) => {
    if (!name || !name.trim()) return;
    if (!currentPath) {
      showError("作成先フォルダが特定できません");
      return;
    }
    openNewMarkdown(buildMarkdownFileName(name));
  };

  const createExcalidraw = async () => {
    const name = prompt("ファイル名を入力してください");
    if (!name || !name.trim()) return;
    if (!currentPath) {
      showError("作成先フォルダが特定できません");
      return;
    }
    const filename = buildExcalidrawFileName(name, currentPath.toLowerCase().includes("obsidian"));
    try {
      const result = await createFile(currentPath, filename, "");
      showSuccess(`ファイルを作成しました: ${filename}`);
      recordCreatedFile(result.path);
      await openInExcalidraw(result.path);
      showSuccess("Excalidrawを開きました");
      refetch();
      // Excalidraw から戻ってきたときのためにフォーカスを戻しておく
      onCreated();
    } catch (e) {
      console.error("Failed to open excalidraw:", e);
      showError(`処理に失敗しました: ${errorMessage(e)}`);
    }
  };

  return {
    openFolderModal: () => setIsFolderModalOpen(true),
    openTextFileModal: () => setIsTextFileModalOpen(true),
    openMarkdownModal: () => setIsMarkdownModalOpen(true),
    createExcalidraw,
    folderModal: { isOpen: isFolderModalOpen, onClose: () => setIsFolderModalOpen(false), onConfirm: confirmCreateFolder },
    textFileModal: { isOpen: isTextFileModalOpen, onClose: () => setIsTextFileModalOpen(false), onConfirm: confirmCreateTextFile },
    markdownModal: { isOpen: isMarkdownModalOpen, onClose: () => setIsMarkdownModalOpen(false), onConfirm: confirmCreateMarkdown },
  };
}

export type FileCreation = ReturnType<typeof useFileCreation>;
