/**
 * 左右のペイン（FileList インスタンス）間で共有する状態
 * - draggedItems / dragSourcePanelId: アプリ内ドラッグ中の項目とドラッグ元ペイン（同一ペイン移動の確認に使用）
 * - clipboard: アプリ内のコピー/切り取り（Ctrl+C / Ctrl+X）の内容。別のペインで貼り付けられる
 * useRef はインスタンスごとのためペイン間で共有できず、画面の再描画も不要なのでモジュール変数で保持する
 */
import type { FileItem } from "../../types/file";

export interface FileListClipboard {
  paths: string[];
  op: "copy" | "move";
}

export const fileListShared: {
  draggedItems: FileItem[];
  dragSourcePanelId: string | null;
  clipboard: FileListClipboard | null;
} = {
  draggedItems: [],
  dragSourcePanelId: null,
  clipboard: null,
};

// Ctrl+C / Ctrl+X でアプリ内クリップボードに入れる
export function setFileListClipboard(clipboard: FileListClipboard): void {
  fileListShared.clipboard = clipboard;
}

// 切り取った項目を移動し終えたらクリップボードを空にする
export function clearFileListClipboard(): void {
  fileListShared.clipboard = null;
}
