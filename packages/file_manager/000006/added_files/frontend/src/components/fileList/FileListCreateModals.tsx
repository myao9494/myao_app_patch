/**
 * 新規作成ダイアログ（フォルダ・テキストファイル・Markdown）。状態と処理は useFileCreation が持つ
 */
import { InputModal } from "../InputModal";
import { TextFileCreateModal } from "../TextFileCreateModal";
import type { FileCreation } from "./useFileCreation";

interface Props {
  creation: FileCreation;
  defaultTextFileExtension: string;
}

export function FileListCreateModals({ creation, defaultTextFileExtension }: Props) {
  const { folderModal, textFileModal, markdownModal } = creation;
  return (
    <>
      <InputModal
        isOpen={folderModal.isOpen}
        onClose={folderModal.onClose}
        title="フォルダ作成"
        message="新しいフォルダの名前を入力してください"
        placeholder="フォルダ名"
        onConfirm={folderModal.onConfirm}
        confirmLabel="作成"
      />
      <TextFileCreateModal
        isOpen={textFileModal.isOpen}
        onClose={textFileModal.onClose}
        defaultExtension={defaultTextFileExtension}
        onConfirm={textFileModal.onConfirm}
      />
      <InputModal
        isOpen={markdownModal.isOpen}
        onClose={markdownModal.onClose}
        title="Markdownファイル作成"
        message="Markdownファイル名を入力してください（.md拡張子は自動付与）"
        placeholder="ファイル名"
        onConfirm={markdownModal.onConfirm}
        confirmLabel="エディタを開く"
      />
    </>
  );
}
