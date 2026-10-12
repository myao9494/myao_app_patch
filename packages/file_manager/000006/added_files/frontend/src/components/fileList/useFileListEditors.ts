/**
 * ファイル一覧の内蔵エディタ（Markdown エディタ・テキスト/コードエディタ）の状態と保存処理
 * - openMarkdownEditor: 既存ファイル（path あり）または新規作成（path なし）で Markdown エディタを開く
 * - openFileEditor: テキスト/コードエディタを開く
 * - 保存: 既存は update-file（アトミック書き込み）、新規は create-file。成功したら一覧を更新して閉じる
 * - 閉じたときは、開く前のペインへキーボード操作を戻す（restorePaneFocus）
 * Undo 履歴: 新規作成は取り消し可能、上書き保存は取り消し不可として記録する
 */
import { useState } from "react";
import { createFile, updateFile } from "../../api/files";
import type { OperationHistoryEntry } from "../../hooks/useOperationHistory";
import type { EditorLanguage } from "../../utils/codeEditorHighlight";
import { errorMessage } from "../../utils/errorMessage";

interface FileListEditorsOptions {
  currentPath: string | null;
  showError: (message: string) => void;
  showSuccess: (message: string) => void;
  addOperation: (operation: OperationHistoryEntry) => void;
  refetch: () => unknown;
  restorePaneFocus: () => void;
}

export function useFileListEditors({
  currentPath,
  showError,
  showSuccess,
  addOperation,
  refetch,
  restorePaneFocus,
}: FileListEditorsOptions) {
  const [mdEditorOpen, setMdEditorOpen] = useState(false);
  const [mdEditorFileName, setMdEditorFileName] = useState("");
  const [mdEditorFilePath, setMdEditorFilePath] = useState<string | null>(null);
  const [mdEditorSaving, setMdEditorSaving] = useState(false);
  const [mdEditorInitialContent, setMdEditorInitialContent] = useState("");
  const [fileEditorOpen, setFileEditorOpen] = useState(false);
  const [fileEditorFileName, setFileEditorFileName] = useState("");
  const [fileEditorFilePath, setFileEditorFilePath] = useState<string | null>(null);
  const [fileEditorSaving, setFileEditorSaving] = useState(false);
  const [fileEditorInitialContent, setFileEditorInitialContent] = useState("");
  const [fileEditorLanguage, setFileEditorLanguage] = useState<EditorLanguage>("plaintext");

  const openMarkdownEditor = (fileName: string, filePath: string | null, content: string) => {
    setMdEditorFileName(fileName);
    setMdEditorFilePath(filePath);
    setMdEditorInitialContent(content);
    setMdEditorOpen(true);
  };

  const openFileEditor = (fileName: string, filePath: string, content: string, language: EditorLanguage) => {
    setFileEditorFileName(fileName);
    setFileEditorFilePath(filePath);
    setFileEditorInitialContent(content);
    setFileEditorLanguage(language);
    setFileEditorOpen(true);
  };

  const handleSaveMarkdown = async (content: string) => {
    if (!currentPath) return;

    setMdEditorSaving(true);
    try {
      if (mdEditorFilePath) {
        await updateFile(mdEditorFilePath, content);
        showSuccess(`更新しました: ${mdEditorFileName}`);
        addOperation({ type: "UPDATE_FILE", canUndo: false, timestamp: Date.now(), data: {} });
      } else {
        const result = await createFile(currentPath, mdEditorFileName, content);
        setMdEditorFilePath(result.path);
        showSuccess(`作成しました: ${mdEditorFileName}`);
        addOperation({
          type: "CREATE_FILE",
          canUndo: true,
          timestamp: Date.now(),
          data: { createdPath: result.path, content },
        });
      }
      refetch();
      setMdEditorOpen(false);
      restorePaneFocus();
    } catch (e) {
      showError(`保存に失敗しました: ${errorMessage(e)}`);
    } finally {
      setMdEditorSaving(false);
    }
  };

  const handleCloseMdEditor = () => {
    setMdEditorOpen(false);
    setMdEditorFileName("");
    setMdEditorFilePath(null);
    restorePaneFocus();
  };

  const handleSaveFileEditor = async (content: string) => {
    if (!fileEditorFilePath) return;

    setFileEditorSaving(true);
    try {
      await updateFile(fileEditorFilePath, content);
      showSuccess(`更新しました: ${fileEditorFileName}`);
      addOperation({ type: "UPDATE_FILE", canUndo: false, timestamp: Date.now(), data: {} });
      refetch();
      setFileEditorOpen(false);
      restorePaneFocus();
    } catch (e) {
      showError(`保存に失敗しました: ${errorMessage(e)}`);
    } finally {
      setFileEditorSaving(false);
    }
  };

  const handleCloseFileEditor = () => {
    setFileEditorOpen(false);
    setFileEditorFileName("");
    setFileEditorFilePath(null);
    restorePaneFocus();
  };

  return {
    markdown: {
      isOpen: mdEditorOpen,
      fileName: mdEditorFileName,
      filePath: mdEditorFilePath,
      isSaving: mdEditorSaving,
      initialContent: mdEditorInitialContent,
      onSave: handleSaveMarkdown,
      onClose: handleCloseMdEditor,
    },
    file: {
      isOpen: fileEditorOpen,
      fileName: fileEditorFileName,
      filePath: fileEditorFilePath,
      isSaving: fileEditorSaving,
      initialContent: fileEditorInitialContent,
      language: fileEditorLanguage,
      onSave: handleSaveFileEditor,
      onClose: handleCloseFileEditor,
    },
    openMarkdownEditor,
    openFileEditor,
  };
}

export type FileListEditorsState = ReturnType<typeof useFileListEditors>;
