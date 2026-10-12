/**
 * ファイル・フォルダ・メールのドラッグ&ドロップ
 *
 * - 画像: 図面に画像として貼り付ける（長辺400pxに縮小）
 * - 一般ファイル: 図面のフォルダの uploads/files/ に保存し、リンク付き付箋（黄）を作成
 * - メール(.eml/.msg): uploads/emails/ に保存し、件名のリンク付き付箋（青）を作成
 * - フォルダ: uploads/folders/ にショートカット(.txt)を作り、リンク付き付箋を作成
 * - Outlook からのドラッグ: 本文を .eml として保存し、件名の付箋を作成
 *
 * 付箋のリンクは図面ファイルからの相対パス（localStorage モードでは絶対パス）。
 */
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { DataURL, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { FileId, NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';

import { createFolderShortcut, saveEmail, uploadFile } from '../utils/backendApi';
import {
  DROP_STICKY_COLORS,
  convertToSceneCoordinates,
  createDroppedFileStickyNote,
  createImageElement,
  detectOutlookData,
  extractEmailSubject,
  extractEmailSubjectFromFile,
  getFileType,
  preventDefaultDragLeave,
  preventDefaultDragOver,
  readFileAsDataURL,
  resizeImage,
} from '../utils/dragDropUtils';

export interface UseDragAndDropProps {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  currentFilePath: string | null;
  containerRef: RefObject<HTMLDivElement>;
}

type Point = { viewportX: number; viewportY: number };

/** ドロップされた項目。DataTransfer はイベント処理後に読めなくなるため同期的に取り出しておく */
type DroppedItem =
  | { kind: 'folder'; entry: FileSystemDirectoryEntry }
  | { kind: 'file'; file: File };

const loadImageSize = (dataUrl: string): Promise<{ width: number; height: number }> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = reject;
    img.src = dataUrl;
  });

const collectDroppedItems = (dataTransfer: DataTransfer): DroppedItem[] => {
  const items: DroppedItem[] = [];
  for (let index = 0; index < dataTransfer.items.length; index++) {
    const item = dataTransfer.items[index];
    if (item.kind !== 'file') {
      continue;
    }
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      items.push({ kind: 'folder', entry: entry as FileSystemDirectoryEntry });
      continue;
    }
    const file = item.getAsFile();
    if (file) {
      items.push({ kind: 'file', file });
    }
  }
  return items;
};

export const useDragAndDrop = ({ excalidrawAPI, currentFilePath, containerRef }: UseDragAndDropProps) => {
  const currentFilePathRef = useRef(currentFilePath);
  currentFilePathRef.current = currentFilePath;

  useEffect(() => {
    // API の準備前もブラウザの既定動作（ファイルを開く）を止めるため、リスナーは常に登録する
    const api = excalidrawAPI as ExcalidrawImperativeAPI;

    const addElements = (elements: NonDeletedExcalidrawElement[]) => {
      api.updateScene({ elements: [...api.getSceneElements(), ...elements] });
    };

    const handleImageFile = async (file: File, point: Point) => {
      const dataUrl = await readFileAsDataURL(file);
      const size = await loadImageSize(dataUrl);
      const { width, height } = resizeImage(size.width, size.height, 400);
      const fileId = Math.random().toString(36).slice(2, 11) as FileId;

      api.addFiles([{
        id: fileId,
        dataURL: dataUrl as DataURL,
        mimeType: file.type as any,
        created: Date.now(),
      }]);
      addElements([createImageElement(point.viewportX, point.viewportY, width, height, fileId)]);
    };

    const handleGeneralFile = async (file: File, point: Point) => {
      const result = await uploadFile(file, currentFilePathRef.current, 'general');
      const savedPath = result.files?.[0]?.path;
      if (!result.success || !savedPath) {
        throw new Error(result.error || 'Upload failed');
      }
      addElements(createDroppedFileStickyNote(point.viewportX, point.viewportY, file.name, savedPath));
    };

    const handleEmailFile = async (file: File, point: Point) => {
      const result = await uploadFile(file, currentFilePathRef.current, 'email');
      const savedPath = result.files?.[0]?.path;
      if (!result.success || !savedPath) {
        throw new Error(result.error || 'Email upload failed');
      }
      const subject = await extractEmailSubjectFromFile(file);
      addElements(createDroppedFileStickyNote(
        point.viewportX, point.viewportY, subject || file.name, savedPath, DROP_STICKY_COLORS.EMAIL,
      ));
    };

    const handleFolder = async (entry: FileSystemDirectoryEntry, point: Point) => {
      const result = await createFolderShortcut(entry.fullPath, currentFilePathRef.current);
      if (!result.success || !result.folderPath) {
        throw new Error(result.error || 'Folder shortcut creation failed');
      }
      addElements(createDroppedFileStickyNote(point.viewportX, point.viewportY, entry.name, result.folderPath));
    };

    const handleOutlookEmail = async (subject: string, data: string, point: Point) => {
      if (!data) {
        throw new Error('No email data found');
      }
      const result = await saveEmail(data, subject, currentFilePathRef.current);
      if (!result.success || !result.savedPath) {
        throw new Error(result.error || 'Outlook email save failed');
      }
      addElements(createDroppedFileStickyNote(
        point.viewportX, point.viewportY, subject, result.savedPath, DROP_STICKY_COLORS.EMAIL,
      ));
    };

    const handleDrop = async (event: DragEvent): Promise<void> => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const dataTransfer = event.dataTransfer;
      if (!excalidrawAPI || !dataTransfer || !containerRef.current) {
        return;
      }

      const point = convertToSceneCoordinates(
        event.clientX,
        event.clientY,
        containerRef.current.getBoundingClientRect(),
        api.getAppState(),
      );

      // ここまでは同期処理。await の後では DataTransfer の中身を読めない。
      if (detectOutlookData(dataTransfer) && dataTransfer.files.length === 0) {
        const { subject, data } = extractEmailSubject(dataTransfer);
        await handleOutlookEmail(subject, data, point).catch((error) =>
          console.error('Error handling Outlook email:', error));
        return;
      }

      for (const item of collectDroppedItems(dataTransfer)) {
        try {
          if (item.kind === 'folder') {
            await handleFolder(item.entry, point);
            continue;
          }
          switch (getFileType(item.file)) {
            case 'image':
              await handleImageFile(item.file, point);
              break;
            case 'email':
              await handleEmailFile(item.file, point);
              break;
            default:
              await handleGeneralFile(item.file, point);
          }
        } catch (error) {
          console.error('Error handling dropped item:', error);
        }
      }
    };

    // ブラウザがファイルを開いてしまわないよう、ドキュメント全体で既定動作を止める
    document.addEventListener('dragover', preventDefaultDragOver, true);
    document.addEventListener('dragleave', preventDefaultDragLeave, true);
    document.addEventListener('drop', handleDrop, true);
    return () => {
      document.removeEventListener('dragover', preventDefaultDragOver, true);
      document.removeEventListener('dragleave', preventDefaultDragLeave, true);
      document.removeEventListener('drop', handleDrop, true);
    };
  }, [excalidrawAPI, containerRef]);
};
