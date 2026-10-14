/**
 * チェックマーク（✓）ユーティリティ
 *
 * チェックモードで C を押したあと、図面をクリックした位置に置く ✓ を作る。
 * フォントに依存しないよう、テキストではなく 3 点の折れ線（line 要素）で描く。
 */
import { nanoid } from 'nanoid';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';

/** チェックマークの既定色（Excalidraw の赤） */
export const CHECK_MARK_COLOR = '#e03131';

/** チェックマークの既定の線の太さ */
export const CHECK_MARK_STROKE_WIDTH = 3;

/** チェックマークの縦横の大きさ（px） */
export const CHECK_MARK_SIZE = 28;

export interface CheckMarkOptions {
  color?: string;
  strokeWidth?: number;
}

/** 要素がチェックマークかどうか */
export const isCheckMarkElement = (element: NonDeletedExcalidrawElement): boolean =>
  element.type === 'line' && (element.customData as Record<string, unknown> | null)?.checkMark === true;

/**
 * 指定位置を中心にしたチェックマークを作る
 *
 * @param centerX - 中心の X（シーン座標）
 * @param centerY - 中心の Y（シーン座標）
 */
export const createCheckMarkElement = (
  centerX: number,
  centerY: number,
  options?: CheckMarkOptions,
): NonDeletedExcalidrawElement => {
  const size = CHECK_MARK_SIZE;
  // 左上 → 谷（左寄りの下）→ 右上
  const points = [
    [0, size * 0.55],
    [size * 0.35, size],
    [size, 0],
  ];

  return {
    id: nanoid(),
    type: 'line',
    x: centerX - size / 2,
    y: centerY - size / 2,
    width: size,
    height: size,
    angle: 0,
    strokeColor: options?.color ?? CHECK_MARK_COLOR,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: options?.strokeWidth ?? CHECK_MARK_STROKE_WIDTH,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 2 },
    seed: Math.floor(Math.random() * 100000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 100000),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    customData: { checkMark: true },
    points,
    startBinding: null,
    endBinding: null,
    lastCommittedPoint: null,
    startArrowhead: null,
    endArrowhead: null,
    index: null,
  } as unknown as NonDeletedExcalidrawElement;
};
