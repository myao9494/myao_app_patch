import { nanoid } from 'nanoid';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';

/**
 * 付箋作成のオプション設定
 */
export interface StickyNoteOptions {
  /** 付箋のX座標（中心点） */
  x: number;
  /** 付箋のY座標（中心点） */
  y: number;
  /** 付箋のテキスト内容 */
  text?: string;
  /** 付箋の背景色 */
  backgroundColor?: string;
  /** 付箋に埋め込むリンク */
  link?: string;
  /** 付箋の幅 */
  width?: number;
  /** 付箋の高さ */
  height?: number;
}

/**
 * 付箋の色定義
 */
export interface StickyNoteColors {
  /** デフォルトの付箋色（黄色） */
  DEFAULT: string;
  /** メール用付箋色（青色） */
  EMAIL: string;
  /** リンク用付箋色（黄色） */
  LINK: string;
}

/**
 * 付箋で使用する色の定義
 */
export const STICKY_NOTE_COLORS: StickyNoteColors = {
  DEFAULT: '#fef3bd',  // 基本付箋の黄色
  EMAIL: '#e3f2fd',    // メール付箋の青色
  LINK: '#fef3bd'      // リンク付箋の黄色
};

/**
 * 付箋のデフォルトサイズ
 */
export const DEFAULT_STICKY_NOTE_SIZE = {
  width: 300,   // 幅
  height: 100    // 高さ（半分に縮小）
};

/**
 * 付箋（矩形 + テキスト）を作成する
 * 
 * @param options - 付箋作成オプション
 * @returns 付箋を構成するExcalidraw要素の配列（矩形要素 + テキスト要素）
 */
export const createStickyNote = (options: StickyNoteOptions): NonDeletedExcalidrawElement[] => {
  const {
    x,
    y,
    text = 'メモを入力',
    backgroundColor = STICKY_NOTE_COLORS.DEFAULT,
    link = null,
    width = DEFAULT_STICKY_NOTE_SIZE.width,
    height = DEFAULT_STICKY_NOTE_SIZE.height
  } = options;

  // 一意なIDを生成
  const rectangleId = nanoid();
  const textId = nanoid();

  // 矩形要素（付箋の背景）を作成
  const rectangleElement: NonDeletedExcalidrawElement = {
    id: rectangleId,
    type: 'rectangle',
    x: x - width / 2,    // 中心点から左上角の座標を計算
    y: y - height / 2,   // 中心点から左上角の座標を計算
    width,
    height,
    angle: 0,
    strokeColor: '#000000',
    backgroundColor,     // 指定された背景色
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,        // 手描き風の粗さを無効化
    opacity: 100,
    groupIds: [],
    seed: Math.floor(Math.random() * 1000000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 1000000),
    isDeleted: false,
    boundElements: [{ type: 'text', id: textId }],  // テキスト要素との紐付け
    updated: Date.now(),
    link,                // リンク情報
    locked: false,
    frameId: null,
    roundness: null,
    customData: null,
    index: 'a0' as any
  };

  // テキスト要素（付箋の内容）を作成
  const textElement: NonDeletedExcalidrawElement = {
    id: textId,
    type: 'text',
    x: rectangleElement.x + 10,  // 矩形の左端から10px内側
    y: rectangleElement.y + 10,  // 矩形の上端から10px内側
    width: width - 20,           // 左右に10pxずつパディング
    height: height - 20,         // 上下に10pxずつパディング
    angle: 0,
    strokeColor: '#000000',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    seed: Math.floor(Math.random() * 1000000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 1000000),
    isDeleted: false,
    text,                        // 表示テキスト
    fontSize: 20,
    fontFamily: 1,
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: rectangleId,    // 矩形要素との紐付け
    originalText: text,
    autoResize: true,
    lineHeight: 1.1 as any,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    frameId: null,
    roundness: null,
    customData: null,
    index: 'a1' as any
  };

  return [rectangleElement, textElement];
};

/**
 * デフォルトの付箋（黄色）を作成
 * 
 * @param x - 付箋のX座標（中心点）
 * @param y - 付箋のY座標（中心点）
 * @returns 付箋を構成するExcalidraw要素の配列
 */
export const createDefaultStickyNote = (x: number, y: number): NonDeletedExcalidrawElement[] => {
  return createStickyNote({
    x,
    y,
    text: 'メモを入力',
    backgroundColor: STICKY_NOTE_COLORS.DEFAULT
  });
};

/**
 * リンク付きの付箋（黄色）を作成
 * 
 * @param x - 付箋のX座標（中心点）
 * @param y - 付箋のY座標（中心点）
 * @param text - 表示テキスト
 * @param link - リンクURL
 * @returns 付箋を構成するExcalidraw要素の配列
 */
export const createLinkStickyNote = (x: number, y: number, text: string, link: string): NonDeletedExcalidrawElement[] => {
  return createStickyNote({
    x,
    y,
    text,
    backgroundColor: STICKY_NOTE_COLORS.LINK,
    link
  });
};
