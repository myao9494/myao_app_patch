import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export interface DropCoordinates {
  x: number;
  y: number;
  viewportX: number;
  viewportY: number;
}

export interface DropResult {
  success: boolean;
  elements?: NonDeletedExcalidrawElement[];
  error?: string;
}

/**
 * ドロップ座標をExcalidrawのシーン座標に変換
 */
export const convertToSceneCoordinates = (
  clientX: number,
  clientY: number,
  containerRect: DOMRect,
  appState: { zoom: { value: number }; scrollX: number; scrollY: number }
): DropCoordinates => {
  const x = clientX - containerRect.left;
  const y = clientY - containerRect.top;
  
  const viewportX = (appState.scrollX * -1) + x / appState.zoom.value;
  const viewportY = (appState.scrollY * -1) + y / appState.zoom.value;
  
  return { x, y, viewportX, viewportY };
};

/**
 * ファイルの種類を判定
 */
export const getFileType = (file: File): 'image' | 'email' | 'general' => {
  if (file.type.startsWith('image/')) {
    return 'image';
  }
  
  const fileName = file.name.toLowerCase();
  if (fileName.endsWith('.eml') || fileName.endsWith('.msg')) {
    return 'email';
  }
  
  return 'general';
};

/**
 * フォルダかどうかを判定
 */
export const isFolder = (item: DataTransferItem): boolean => {
  if (item.kind === 'file') {
    const entry = item.webkitGetAsEntry();
    return Boolean(entry?.isDirectory);
  }
  return false;
};

/** ドロップしたファイル・フォルダ用付箋の色 */
export const DROP_STICKY_COLORS = {
  /** 一般ファイル・フォルダ（黄色） */
  FILE: { backgroundColor: '#fef3bd', strokeColor: '#000000' },
  /** メール（青色） */
  EMAIL: { backgroundColor: '#e3f2fd', strokeColor: '#1976d2' },
} as const;

/**
 * ドロップしたファイルへのリンク付き付箋（矩形 + テキスト）を作成する。
 * リンクは矩形とテキストの両方に設定する。表示テキストは25文字を超えると省略する。
 */
export const createDroppedFileStickyNote = (
  x: number,
  y: number,
  text: string,
  link: string,
  colors: { backgroundColor: string; strokeColor: string } = DROP_STICKY_COLORS.FILE,
): NonDeletedExcalidrawElement[] => {
  const { backgroundColor, strokeColor } = colors;
  const rectangleId = Math.random().toString(36).slice(2, 11);
  const textId = "text-" + Math.random().toString(36).slice(2, 11);

  return [
    {
      id: rectangleId,
      type: 'rectangle',
      x: x - 100,
      y: y - 25,
      width: 200,
      height: 50,
      angle: 0,
      strokeColor,
      backgroundColor,
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: 'a0',
      roundness: { type: 1, value: 0 },
      seed: Math.floor(Math.random() * 1000000),
      version: 1,
      versionNonce: Math.floor(Math.random() * 1000000),
      isDeleted: false,
      boundElements: [{ type: "text", id: textId }],
      updated: Date.now(),
      link,
      locked: false,
    } as unknown as NonDeletedExcalidrawElement,
    {
      id: textId,
      type: 'text',
      x: x - 90,
      y: y - 15,
      width: 180,
      height: 30,
      angle: 0,
      strokeColor,
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: 'a1',
      roundness: null,
      seed: Math.floor(Math.random() * 1000000),
      version: 1,
      versionNonce: Math.floor(Math.random() * 1000000),
      isDeleted: false,
      text: text.length > 25 ? text.substring(0, 22) + '...' : text,
      fontSize: 20,
      fontFamily: 1,
      textAlign: "left",
      verticalAlign: "top",
      baseline: 12,
      containerId: rectangleId,
      originalText: text,
      lineHeight: 1.1,
      boundElements: [],
      updated: Date.now(),
      link,
      locked: false,
    } as unknown as NonDeletedExcalidrawElement
  ];
};

/**
 * 画像要素を作成
 */
export const createImageElement = (
  x: number,
  y: number,
  width: number,
  height: number,
  fileId: string
): NonDeletedExcalidrawElement => {
  return {
    id: Math.random().toString(36).slice(2, 11),
    type: "image",
    x: x - width / 2,
    y: y - height / 2,
    width,
    height,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: 'a0',
    roundness: null,
    seed: Math.floor(Math.random() * 1000000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 1000000),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    fileId,
    scale: [1, 1] as [number, number],
  } as unknown as NonDeletedExcalidrawElement;
};

/**
 * 画像のサイズを最大値に基づいてリサイズ
 */
export const resizeImage = (
  originalWidth: number,
  originalHeight: number,
  maxSize: number = 400
): { width: number; height: number } => {
  let width = originalWidth;
  let height = originalHeight;

  // アスペクト比を維持してリサイズ
  if (width > height) {
    if (width > maxSize) {
      height = (height * maxSize) / width;
      width = maxSize;
    }
  } else {
    if (height > maxSize) {
      width = (width * maxSize) / height;
      height = maxSize;
    }
  }

  return { width, height };
};

/**
 * ファイルをData URLとして読み込み
 */
export const readFileAsDataURL = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

/**
 * Outlookメールデータを検出
 */
export const detectOutlookData = (dataTransfer: DataTransfer): boolean => {
  return dataTransfer.types.includes('text/x-moz-url') || 
         dataTransfer.types.includes('application/x-moz-file') ||
         dataTransfer.types.includes('Files') ||
         dataTransfer.types.includes('text/x-moz-message') ||
         dataTransfer.types.includes('application/x-moz-nativehtml') ||
         dataTransfer.types.includes('text/x-moz-text-internal') ||
         dataTransfer.types.includes('text/x-moz-place') ||
         dataTransfer.types.includes('application/x-moz-drag-image') ||
         dataTransfer.types.includes('text/rtf') ||
         dataTransfer.types.includes('application/rtf') ||
         dataTransfer.types.includes('text/x-moz-text-plain') ||
         (dataTransfer.types.includes('text/plain') && dataTransfer.files.length === 0) ||
         (dataTransfer.types.includes('text/html') && dataTransfer.files.length === 0) ||
         (dataTransfer.effectAllowed === 'all' && dataTransfer.files.length === 0);
};

/** ドロップから件名が取れなかったときの既定の表示名 */
export const DEFAULT_DROP_SUBJECT = 'Outlook Email';

/**
 * Web ページのリンクをドラッグ&ドロップしたとき、その URL を取り出す（http / https のみ）
 *
 * ブラウザはリンクのドラッグで text/uri-list・text/plain・text/html（Firefox は text/x-moz-url も）を渡す。
 * ファイルを伴うドロップや、URL 以外の文章（Outlook の件名など）は対象外で null を返す。
 */
export const extractDroppedUrl = (dataTransfer: DataTransfer): string | null => {
  if (dataTransfer.files.length > 0) {
    return null;
  }

  const firstLine = (type: string, skipComments = false) =>
    dataTransfer
      .getData(type)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !(skipComments && line.startsWith('#')));

  const candidates = [firstLine('text/uri-list', true), firstLine('text/x-moz-url')];
  // text/plain は URL だけが書かれた 1 行のときだけ採用する（件名などの文章を誤認しない）
  const plainLines = dataTransfer.getData('text/plain').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (plainLines.length === 1) {
    candidates.push(plainLines[0]);
  }

  return candidates.find((candidate): candidate is string => !!candidate && /^https?:\/\/\S+$/i.test(candidate)) ?? null;
};

/**
 * メールデータから件名を抽出
 */
export const extractEmailSubject = (dataTransfer: DataTransfer): { subject: string; data: string } => {
  let subject = DEFAULT_DROP_SUBJECT;
  let emailData = '';

  // 様々な形式でデータを取得
  for (const type of dataTransfer.types) {
    try {
      const data = dataTransfer.getData(type);
      if (!data) continue;

      emailData = data;

      if (type === 'text/plain' && data) {
        const lines = data.split('\n');
        if (lines.length > 0) {
          subject = lines[0].trim() || DEFAULT_DROP_SUBJECT;
        }
      } else if (type === 'text/x-moz-url' && data) {
        const urlParts = data.split('\n');
        if (urlParts.length > 1) {
          subject = urlParts[1] || DEFAULT_DROP_SUBJECT;
        }
      } else if (type === 'text/html' && data) {
        // DOMParser はスクリプトや画像の読み込みを実行しないため、外部HTMLを安全に扱える
        const textContent = new DOMParser().parseFromString(data, 'text/html').body.textContent || '';
        const lines = textContent.split('\n');
        if (lines.length > 0) {
          subject = lines[0].trim() || DEFAULT_DROP_SUBJECT;
        }
      }
    } catch (error) {
      console.warn(`Failed to get data for type ${type}:`, error);
    }
  }

  return { subject, data: emailData };
};

/**
 * ドラッグオーバーイベントを防止
 */
export const preventDefaultDragOver = (e: DragEvent): void => {
  e.preventDefault();
  e.stopPropagation();
  
  // ドロップ効果を設定
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy';
  }
};

/**
 * ドラッグリーブイベントを防止
 */
export const preventDefaultDragLeave = (e: DragEvent): void => {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
};

/** メールファイル(.eml)の Subject ヘッダーを取り出す */
export const extractEmailSubjectFromFile = async (file: File): Promise<string | null> => {
  try {
    const text = await file.text();
    const subjectMatch = text.match(/^Subject:\s*(.+)$/m);
    return subjectMatch ? subjectMatch[1].trim() : null;
  } catch (error) {
    console.error('Error extracting email subject:', error);
    return null;
  }
};
