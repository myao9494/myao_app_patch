/**
 * アンダーライン（赤色下線）ユーティリティ
 * 
 * 仕様:
 * 1. テキスト要素の下端直下（Y座標: y + height + 2）に赤色の直線要素（line）を生成する。
 * 2. 線のデフォルト色は赤色（#e03131）、線の太さは2px、手書き風の粗さroughnessは1、不透明度は100%。
 * 3. 矢印ヘッド（startArrowhead, endArrowhead）はnullとし、純粋な直線として描画する。
 * 4. テキスト選択時に実行された場合、テキスト要素と同一のgroupIdを共有してグループ化し、
 *    すでにアンダーラインが存在する場合はトグル解除（削除）する。
 * 5. 手動ドラッグで描画された下線とテキスト要素が近接・重複している場合、自動でテキストとグループ化する。
 */

import { nanoid } from 'nanoid';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';

/** アンダーラインのデフォルト色（Excalidrawの赤色） */
export const UNDERLINE_COLOR = '#e03131';

/** アンダーラインのデフォルト線の太さ */
export const DEFAULT_UNDERLINE_STROKE_WIDTH = 2;

/** アンダーライン作成のオプション */
export interface UnderlineOptions {
  /** 左右のパディング（px）デフォルト: 0 */
  paddingX?: number;
  /** Y座標のオフセット（テキスト下端からの距離 px）デフォルト: 2 */
  yOffset?: number;
  /** 線の太さ デフォルト: 2 */
  strokeWidth?: number;
  /** 線の色 デフォルト: UNDERLINE_COLOR */
  color?: string;
  /** 手描き風の粗さ デフォルト: 1 */
  roughness?: number;
}

/** トグル実行結果の型 */
export interface ToggleUnderlineResult {
  updatedElements: readonly NonDeletedExcalidrawElement[];
  createdUnderlineIds: string[];
}

/**
 * 指定された要素がアンダーライン要素かどうかを判定する
 * 
 * @param element - 判定対象の要素
 * @returns アンダーライン要素であればtrue
 */
export const isUnderlineElement = (element: NonDeletedExcalidrawElement): boolean => {
  return (
    element.type === 'line' &&
    element.customData != null &&
    typeof (element.customData as Record<string, any>).underlineFor === 'string'
  );
};

/**
 * テキスト要素に対応するアンダーライン要素（line）を生成する
 * 
 * @param textElement - アンダーラインを引く対象のテキスト要素
 * @param options - アンダーラインのスタイルオプション
 * @returns 生成されたアンダーライン要素
 */
export const createUnderlineElement = (
  textElement: NonDeletedExcalidrawElement,
  options?: UnderlineOptions
): NonDeletedExcalidrawElement => {
  const paddingX = options?.paddingX ?? 0;
  const yOffset = options?.yOffset ?? 2;
  const strokeWidth = options?.strokeWidth ?? DEFAULT_UNDERLINE_STROKE_WIDTH;
  const color = options?.color ?? UNDERLINE_COLOR;
  const roughness = options?.roughness ?? 1;

  const underlineId = nanoid();
  const width = textElement.width + paddingX * 2;
  const x = textElement.x - paddingX;
  const y = textElement.y + textElement.height + yOffset;

  const underlineElement: NonDeletedExcalidrawElement = {
    id: underlineId,
    type: 'line',
    x,
    y,
    width,
    height: 0,
    angle: textElement.angle ?? 0,
    strokeColor: color,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth,
    strokeStyle: 'solid',
    roughness,
    opacity: 100,
    groupIds: [...textElement.groupIds],
    frameId: textElement.frameId ?? null,
    roundness: null,
    seed: Math.floor(Math.random() * 100000),
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    customData: {
      underlineFor: textElement.id,
    },
    points: [
      [0, 0],
      [width, 0],
    ],
    startBinding: null,
    endBinding: null,
    lastCommittedPoint: null,
    startArrowhead: null,
    endArrowhead: null,
    index: textElement.index,
  } as unknown as NonDeletedExcalidrawElement;

  return underlineElement;
};

/**
 * 選択された要素群に対してアンダーラインの付与・削除（トグル）を行う
 * 
 * @param allElements - シーン内の全要素
 * @param selectedElementIds - 選択中の要素IDのマップ
 * @param options - アンダーラインのスタイルオプション
 * @returns 更新後の要素配列と、新規作成されたアンダーラインID配列
 */
export const toggleUnderlineForElements = (
  allElements: readonly NonDeletedExcalidrawElement[],
  selectedElementIds: Readonly<Record<string, true>>,
  options?: UnderlineOptions
): ToggleUnderlineResult => {
  const selectedIds = Object.keys(selectedElementIds).filter((id) => selectedElementIds[id]);

  if (selectedIds.length === 0) {
    return {
      updatedElements: allElements,
      createdUnderlineIds: [],
    };
  }

  // 選択されたテキスト要素を取得
  const selectedTextElements = allElements.filter(
    (el) => selectedIds.includes(el.id) && el.type === 'text' && !el.isDeleted
  );

  if (selectedTextElements.length === 0) {
    return {
      updatedElements: allElements,
      createdUnderlineIds: [],
    };
  }

  // 既存のアンダーライン要素を検索
  const existingUnderlineMap = new Map<string, NonDeletedExcalidrawElement>();
  for (const el of allElements) {
    if (isUnderlineElement(el) && !el.isDeleted) {
      const textId = (el.customData as Record<string, any>).underlineFor;
      if (typeof textId === 'string') {
        existingUnderlineMap.set(textId, el);
      }
    }
  }

  // すべての選択中テキストに既にアンダーラインがある場合は削除（トグルOFF）
  const allHaveUnderline = selectedTextElements.every((textEl) => existingUnderlineMap.has(textEl.id));

  if (allHaveUnderline) {
    const underlineToRemoveIds = new Set(
      selectedTextElements.map((textEl) => existingUnderlineMap.get(textEl.id)!.id)
    );

    const updatedElements = allElements.filter((el) => !underlineToRemoveIds.has(el.id));

    return {
      updatedElements,
      createdUnderlineIds: [],
    };
  }

  // アンダーラインのないテキスト要素に対して新規生成（トグルON）
  const createdUnderlineIds: string[] = [];
  const newUnderlineMap = new Map<string, NonDeletedExcalidrawElement>();
  const modifiedTextGroupIds = new Map<string, string[]>();

  for (const textEl of selectedTextElements) {
    if (!existingUnderlineMap.has(textEl.id)) {
      const underline = createUnderlineElement(textEl, options);

      // グループ化
      const sharedGroupId = textEl.groupIds.length > 0 ? textEl.groupIds[0] : nanoid();
      const nextGroupIds = textEl.groupIds.includes(sharedGroupId)
        ? textEl.groupIds
        : [sharedGroupId, ...textEl.groupIds];

      underline.groupIds = [...nextGroupIds];
      modifiedTextGroupIds.set(textEl.id, nextGroupIds);

      newUnderlineMap.set(textEl.id, underline);
      createdUnderlineIds.push(underline.id);
    }
  }

  const resultElements: NonDeletedExcalidrawElement[] = [];

  for (const el of allElements) {
    if (modifiedTextGroupIds.has(el.id)) {
      resultElements.push({
        ...el,
        groupIds: modifiedTextGroupIds.get(el.id)!,
      });
    } else {
      resultElements.push(el);
    }

    if (newUnderlineMap.has(el.id)) {
      resultElements.push(newUnderlineMap.get(el.id)!);
    }
  }

  return {
    updatedElements: resultElements,
    createdUnderlineIds,
  };
};

/**
 * 手動で描画された下線と重なる/近接するテキスト要素を検出し、グループ化する
 * 
 * @param allElements - シーン内の全要素
 * @param underlineElementId - 新しく描画されたアンダーラインの要素ID
 * @returns 順序およびグループが調整された要素配列
 */
export const sendUnderlineWithOverlappingText = (
  allElements: readonly NonDeletedExcalidrawElement[],
  underlineElementId: string
): readonly NonDeletedExcalidrawElement[] => {
  const underlineElement = allElements.find((el) => el.id === underlineElementId);
  if (!underlineElement || underlineElement.type !== 'line') {
    return allElements;
  }

  const lineMinX = underlineElement.x;
  const lineMaxX = underlineElement.x + underlineElement.width;
  const lineMinY = underlineElement.y;
  const lineMaxY = underlineElement.y + underlineElement.height;

  // 近接するテキスト要素を検索（Y方向はテキスト下端の上下15px以内、X方向は交差）
  const overlappingText = allElements.find((el) => {
    if (el.type !== 'text' || el.isDeleted) return false;

    const textMinX = el.x;
    const textMaxX = el.x + el.width;
    const textBottomY = el.y + el.height;

    const xIntersects = lineMinX < textMaxX && lineMaxX > textMinX;
    // 下線のY座標がテキストの下端付近（-10px 〜 +25px）にあるか
    const yNearBottom = lineMinY >= textBottomY - 10 && lineMinY <= textBottomY + 25;

    return xIntersects && yNearBottom;
  });

  if (!overlappingText) {
    return allElements;
  }

  // 同一グループにまとめる
  const sharedGroupId = overlappingText.groupIds.length > 0 ? overlappingText.groupIds[0] : nanoid();
  const textGroupIds = overlappingText.groupIds.includes(sharedGroupId)
    ? overlappingText.groupIds
    : [sharedGroupId, ...overlappingText.groupIds];
  const lineGroupIds = underlineElement.groupIds.includes(sharedGroupId)
    ? underlineElement.groupIds
    : [sharedGroupId, ...underlineElement.groupIds];

  return allElements.map((el) => {
    if (el.id === overlappingText.id) {
      return { ...el, groupIds: textGroupIds };
    }
    if (el.id === underlineElement.id) {
      return {
        ...el,
        groupIds: lineGroupIds,
        customData: {
          ...el.customData,
          underlineFor: overlappingText.id,
        },
      };
    }
    return el;
  });
};
