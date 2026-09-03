/**
 * マーカー（テキストハイライト）機能ユーティリティ
 * 
 * 仕様:
 * 1. テキスト要素を選択してショートカットキー（M）を押した際に、文字の下半分に重なる
 *    淡い黄色の手書き風ハイライト帯（長方形）を自動生成し、テキストの背面に配置する。
 * 2. テキスト要素とマーカー要素を同一のグループ（groupId）に所属させることで、
 *    テキスト移動時にマーカーが追従するようにする。
 * 3. 既にマーカーが付与されているテキスト要素に対して再度実行された場合は、
 *    マーカーを削除（トグル解除）する。
 * 4. マーカー要素には customData: { markerFor: textElement.id } を付与し、
 *    対象テキストとの紐付けを保持する。
 * 5. 手動ドラッグで描画されたマーカー矩形がテキスト要素と重なっている場合、
 *    自動的にテキストの直前（背面）に配置し、同一のgroupIdでグループ化する。
 */

import { nanoid } from 'nanoid';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';

/** マーカーのデフォルト背景色（淡いパステル調の蛍光イエロー） */
export const MARKER_COLOR = '#fef08a';

/** マーカーのデフォルト不透明度（50%） */
export const DEFAULT_MARKER_OPACITY = 50;

/** マーカー作成のオプション */
export interface MarkerOptions {
  /** 左右のパディング（px）デフォルト: 6 */
  paddingX?: number;
  /** Y座標のオフセット比率（テキスト上端からの割合）デフォルト: 0.55 */
  yOffsetRatio?: number;
  /** 高さの比率（テキスト高さに対する割合）デフォルト: 0.45 */
  heightRatio?: number;
  /** マーカーの背景色 デフォルト: MARKER_COLOR */
  color?: string;
  /** 手描き風の粗さ デフォルト: 1 */
  roughness?: number;
  /** 不透明度（%）デフォルト: 50 */
  opacity?: number;
}

/** トグル実行結果の型 */
export interface ToggleMarkerResult {
  updatedElements: readonly NonDeletedExcalidrawElement[];
  createdMarkerIds: string[];
}

/**
 * 指定された要素がマーカー要素かどうかを判定する
 * 
 * @param element - 判定対象の要素
 * @returns マーカー要素であればtrue
 */
export const isMarkerElement = (element: NonDeletedExcalidrawElement): boolean => {
  return (
    element.type === 'rectangle' &&
    element.customData != null &&
    typeof (element.customData as Record<string, any>).markerFor === 'string'
  );
};

/**
 * テキスト要素に対応するマーカー要素（rectangle）を生成する
 * 
 * @param textElement - マーカーを引く対象のテキスト要素
 * @param options - マーカーのスタイルオプション
 * @returns 生成されたマーカー要素
 */
export const createMarkerElement = (
  textElement: NonDeletedExcalidrawElement,
  options?: MarkerOptions
): NonDeletedExcalidrawElement => {
  const paddingX = options?.paddingX ?? 6;
  const yOffsetRatio = options?.yOffsetRatio ?? 0.55;
  const heightRatio = options?.heightRatio ?? 0.45;
  const color = options?.color ?? MARKER_COLOR;
  const roughness = options?.roughness ?? 1;
  const opacity = options?.opacity ?? DEFAULT_MARKER_OPACITY;

  const markerId = nanoid();
  const width = textElement.width + paddingX * 2;
  const height = textElement.height * heightRatio;
  const x = textElement.x - paddingX;
  const y = textElement.y + textElement.height * yOffsetRatio;

  const markerElement: NonDeletedExcalidrawElement = {
    id: markerId,
    type: 'rectangle',
    x,
    y,
    width,
    height,
    angle: textElement.angle ?? 0,
    strokeColor: 'transparent',
    backgroundColor: color,
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness,
    opacity,
    groupIds: [...textElement.groupIds],
    frameId: textElement.frameId ?? null,
    roundness: { type: 3 },
    seed: Math.floor(Math.random() * 1000000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 1000000),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    customData: {
      markerFor: textElement.id,
    },
    index: 'a0' as any,
  };

  return markerElement;
};

/**
 * 選択された要素（主にテキスト要素）に対してマーカーを付与またはトグル解除する
 * 
 * @param elements - シーン内の全要素一覧
 * @param selectedElementIds - 選択中の要素IDマップ
 * @param options - マーカーのスタイルオプション
 * @returns 更新された要素配列と新しく作成されたマーカーID一覧
 */
export const toggleMarkerForElements = (
  elements: readonly NonDeletedExcalidrawElement[],
  selectedElementIds: Record<string, boolean>,
  options?: MarkerOptions
): ToggleMarkerResult => {
  const selectedIds = Object.keys(selectedElementIds).filter((id) => selectedElementIds[id]);
  if (selectedIds.length === 0) {
    return {
      updatedElements: elements,
      createdMarkerIds: [],
    };
  }

  // 選択されたテキスト要素を取得
  const selectedTextElements = elements.filter(
    (el) => selectedElementIds[el.id] && el.type === 'text' && !el.isDeleted
  );

  if (selectedTextElements.length === 0) {
    return {
      updatedElements: elements,
      createdMarkerIds: [],
    };
  }

  // 既存の全マーカーをマップ化: textId -> markerElement
  const existingMarkerMap = new Map<string, NonDeletedExcalidrawElement>();
  elements.forEach((el) => {
    if (isMarkerElement(el)) {
      const markerFor = (el.customData as Record<string, any>).markerFor;
      if (markerFor) {
        existingMarkerMap.set(markerFor, el);
      }
    }
  });

  const markersToRemoveIds = new Set<string>();
  const textsToMark: NonDeletedExcalidrawElement[] = [];

  selectedTextElements.forEach((textEl) => {
    const existingMarker = existingMarkerMap.get(textEl.id);
    if (existingMarker) {
      // 既にマーカーがある場合は削除対象
      markersToRemoveIds.add(existingMarker.id);
    } else {
      // マーカーがない場合は新規付与対象
      textsToMark.push(textEl);
    }
  });

  const textsToMarkSet = new Set(textsToMark.map((t) => t.id));
  const newMarkersMap = new Map<string, NonDeletedExcalidrawElement>();
  const createdMarkerIds: string[] = [];

  textsToMark.forEach((textEl) => {
    const marker = createMarkerElement(textEl, options);
    // テキストとマーカーに新しい共通groupIdを付与
    const sharedGroupId = nanoid();
    marker.groupIds = [...marker.groupIds, sharedGroupId];
    newMarkersMap.set(textEl.id, marker);
    createdMarkerIds.push(marker.id);
  });

  // 新しい要素配列を構築
  // マーカーは対象テキスト要素の直前（背面）に挿入する
  const updatedElements: NonDeletedExcalidrawElement[] = [];

  elements.forEach((el) => {
    // 削除対象のマーカーはスキップ
    if (markersToRemoveIds.has(el.id)) {
      return;
    }

    // 新規マーカー付与対象のテキスト要素の場合
    if (textsToMarkSet.has(el.id)) {
      const newMarker = newMarkersMap.get(el.id);
      if (newMarker) {
        // マーカーをテキストの直前に配置（背面に描画される）
        updatedElements.push(newMarker);
        // テキスト要素にマーカーと共有のgroupIdを追加
        const sharedGroupId = newMarker.groupIds[newMarker.groupIds.length - 1];
        const updatedText: NonDeletedExcalidrawElement = {
          ...el,
          groupIds: [...el.groupIds, sharedGroupId],
          version: el.version + 1,
          versionNonce: Math.floor(Math.random() * 1000000),
          updated: Date.now(),
        };
        updatedElements.push(updatedText);
        return;
      }
    }

    // すでにマーカーが削除されたテキスト要素の場合、共有groupIdをクリーンアップ
    if (selectedTextElements.some((t) => t.id === el.id) && markersToRemoveIds.size > 0) {
      // 削除されたマーカーに対応するテキスト
      const removedMarker = Array.from(existingMarkerMap.values()).find(
        (m) => (m.customData as Record<string, any>).markerFor === el.id && markersToRemoveIds.has(m.id)
      );
      if (removedMarker) {
        // 削除マーカーと共有していたgroupIdを除去
        const markerGroupIds = new Set(removedMarker.groupIds);
        const cleanedGroupIds = el.groupIds.filter((gid) => !markerGroupIds.has(gid));
        const updatedText: NonDeletedExcalidrawElement = {
          ...el,
          groupIds: cleanedGroupIds,
          version: el.version + 1,
          versionNonce: Math.floor(Math.random() * 1000000),
          updated: Date.now(),
        };
        updatedElements.push(updatedText);
        return;
      }
    }

    updatedElements.push(el);
  });

  return {
    updatedElements,
    createdMarkerIds,
  };
};

/**
 * 手動で描画されたマーカー矩形要素がテキスト要素と重なっているか判定し、
 * 重なっているテキスト要素の直前（背面）に移動させ、グループ化する。
 * 
 * @param elements - シーン内の全要素一覧
 * @param markerElementId - 新規作成されたマーカー要素のID
 * @returns 更新された要素配列
 */
export const sendMarkerBehindOverlappingText = (
  elements: readonly NonDeletedExcalidrawElement[],
  markerElementId: string
): readonly NonDeletedExcalidrawElement[] => {
  const marker = elements.find((el) => el.id === markerElementId && !el.isDeleted);
  if (!marker) {
    return elements;
  }

  // マーカー矩形の境界ボックス
  const mLeft = marker.x;
  const mTop = marker.y;
  const mRight = marker.x + marker.width;
  const mBottom = marker.y + marker.height;

  // 重なっているテキスト要素を探す
  const overlappingTexts = elements.filter((el) => {
    if (el.id === marker.id || el.type !== 'text' || el.isDeleted) {
      return false;
    }
    const tLeft = el.x;
    const tTop = el.y;
    const tRight = el.x + el.width;
    const tBottom = el.y + el.height;

    // AABB交差判定
    const isIntersecting = !(
      mLeft >= tRight ||
      mRight <= tLeft ||
      mTop >= tBottom ||
      mBottom <= tTop
    );
    return isIntersecting;
  });

  if (overlappingTexts.length === 0) {
    return elements;
  }

  // 最初に重なっているテキスト要素（または最も手前にあるテキスト要素）を対象とする
  const targetText = overlappingTexts[overlappingTexts.length - 1];
  const sharedGroupId = nanoid();

  // マーカーを更新
  const updatedMarker: NonDeletedExcalidrawElement = {
    ...marker,
    groupIds: [...marker.groupIds, sharedGroupId],
    customData: {
      ...(marker.customData as Record<string, any>),
      markerFor: targetText.id,
    },
    version: marker.version + 1,
    versionNonce: Math.floor(Math.random() * 1000000),
    updated: Date.now(),
  };

  // テキストを更新
  const updatedText: NonDeletedExcalidrawElement = {
    ...targetText,
    groupIds: [...targetText.groupIds, sharedGroupId],
    version: targetText.version + 1,
    versionNonce: Math.floor(Math.random() * 1000000),
    updated: Date.now(),
  };

  // 配列を再構築：マーカーを除外し、targetTextの直前（背面）に挿入
  const result: NonDeletedExcalidrawElement[] = [];
  elements.forEach((el) => {
    if (el.id === marker.id) {
      return; // 一旦スキップ
    }
    if (el.id === targetText.id) {
      // テキストの直前にマーカーを挿入（背面に配置）
      result.push(updatedMarker);
      result.push(updatedText);
      return;
    }
    result.push(el);
  });

  return result;
};
