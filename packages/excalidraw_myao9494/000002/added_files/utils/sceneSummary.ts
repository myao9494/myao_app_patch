/**
 * 自動保存の要否判定に使う「シーンの要約」
 *
 * 保存済みの要約と現在の要約が異なるときだけ保存する。
 * 選択状態・スクロール・ズームなど、図面の内容に関係しない変化では保存しない。
 * 要素の並び順（重なり順）も変更として扱う。
 */
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

const fixed = (value: number | undefined | null): string => (value ?? 0).toFixed(2);

const describeElement = (element: NonDeletedExcalidrawElement): string => {
  const el = element as any;
  const parts: unknown[] = [
    el.id,
    el.type,
    // 位置・サイズ・回転
    fixed(el.x), fixed(el.y), fixed(el.width), fixed(el.height), fixed(el.angle),
    // スタイル
    el.strokeColor, el.backgroundColor, el.fillStyle, el.strokeWidth, el.strokeStyle,
    el.roughness, el.opacity, el.roundness?.type ?? '',
    // 関係・属性
    el.link ?? '', (el.groupIds || []).join(','), el.frameId ?? '', el.locked ? 1 : 0,
    el.containerId ?? '',
  ];

  if (el.type === 'text') {
    parts.push(el.text ?? '', el.fontSize, el.fontFamily, el.textAlign, el.verticalAlign);
  }
  if (Array.isArray(el.points)) {
    parts.push(el.points.map((point: number[]) => `${fixed(point[0])}:${fixed(point[1])}`).join(' '));
  }
  if (el.type === 'arrow' || el.type === 'line') {
    parts.push(el.startArrowhead ?? '', el.endArrowhead ?? '');
  }
  if (el.type === 'image') {
    parts.push(el.fileId ?? '', JSON.stringify(el.scale ?? null), JSON.stringify(el.crop ?? null));
  }

  return parts.join('|');
};

/** 削除されていない要素から、内容比較用の要約文字列を作る */
export const buildElementSummary = (elements: readonly NonDeletedExcalidrawElement[]): string =>
  elements
    .filter((element) => !element.isDeleted)
    .map(describeElement)
    .join('\n');

/** ファイルに保存する appState の項目（ビュー位置と描画スタイルのみ） */
export const pickPersistedAppState = (appState: Partial<AppState>): Partial<AppState> => ({
  viewBackgroundColor: appState.viewBackgroundColor,
  currentItemFontFamily: appState.currentItemFontFamily,
  currentItemFontSize: appState.currentItemFontSize,
  currentItemStrokeColor: appState.currentItemStrokeColor,
  currentItemBackgroundColor: appState.currentItemBackgroundColor,
  currentItemFillStyle: appState.currentItemFillStyle,
  currentItemStrokeWidth: appState.currentItemStrokeWidth,
  currentItemStrokeStyle: appState.currentItemStrokeStyle,
  currentItemRoughness: appState.currentItemRoughness,
  currentItemOpacity: appState.currentItemOpacity,
  zoom: appState.zoom,
  scrollX: appState.scrollX,
  scrollY: appState.scrollY,
});

/**
 * 要素のバージョンから計算する軽量なキー。
 * onChange はスクロールやポインタ移動でも頻繁に呼ばれるため、まずこのキーで
 * 「要素が変わったか」だけを O(要素数) で判定し、重い要約の作成は保存直前に行う。
 * 削除済み要素も含めて渡すこと（削除もバージョン更新として検知する）。
 */
export const getSceneVersionKey = (
  elements: readonly { version: number; versionNonce: number }[],
): string => {
  let hash = 5381;
  for (const element of elements) {
    hash = ((hash << 5) + hash + element.versionNonce) | 0;
    hash = ((hash << 5) + hash + element.version) | 0;
  }
  return `${elements.length}:${hash >>> 0}`;
};
