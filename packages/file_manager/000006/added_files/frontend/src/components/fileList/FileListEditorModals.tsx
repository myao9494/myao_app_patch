/**
 * ファイル一覧の内蔵エディタモーダル（開いたときだけ読み込む）
 * 状態と保存処理は useFileListEditors が持つ
 */
import { lazy, Suspense } from "react";
import type { FileListEditorsState } from "./useFileListEditors";

const MarkdownEditorModal = lazy(() =>
  import("../MarkdownEditorModal").then((module) => ({ default: module.MarkdownEditorModal }))
);
const FileEditorModal = lazy(() =>
  import("../FileEditorModal").then((module) => ({ default: module.FileEditorModal }))
);

interface FileListEditorModalsProps {
  editors: FileListEditorsState;
  currentDirectory: string | null;
}

export function FileListEditorModals({ editors, currentDirectory }: FileListEditorModalsProps) {
  const { markdown, file } = editors;
  return (
    <>
      {markdown.isOpen && (
        <Suspense fallback={null}>
          <MarkdownEditorModal
            isOpen={markdown.isOpen}
            onClose={markdown.onClose}
            onSave={markdown.onSave}
            fileName={markdown.fileName}
            filePath={markdown.filePath}
            currentDirectory={currentDirectory}
            isSaving={markdown.isSaving}
            initialContent={markdown.initialContent}
          />
        </Suspense>
      )}
      {file.isOpen && (
        <Suspense fallback={null}>
          <FileEditorModal
            isOpen={file.isOpen}
            onClose={file.onClose}
            onSave={file.onSave}
            fileName={file.fileName}
            filePath={file.filePath}
            isSaving={file.isSaving}
            initialContent={file.initialContent}
            initialLanguage={file.language}
          />
        </Suspense>
      )}
    </>
  );
}
