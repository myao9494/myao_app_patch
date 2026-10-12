/**
 * 共有ライブラリ (public/excalidraw_lib/my_lib.excalidrawlib) の読み込み補助
 */

export const LIBRARY_URL = '/excalidraw_lib/my_lib.excalidrawlib';

const randomSuffix = (): string => Math.random().toString(36).slice(2, 11);

/** ファイルと同期済みのアイテムID一覧（ライブラリはアイテムの追加・削除のみで、編集はできない） */
let syncedItemIdsKey: string | null = null;

const itemIdsKey = (items: readonly any[]): string =>
  items.map((item) => item?.id ?? '').sort().join('\n');

/** ファイルと同期済みのアイテムとして記録する */
export const markLibrarySynced = (items: readonly any[]): void => {
  syncedItemIdsKey = itemIdsKey(items);
};

/**
 * ファイルと同じアイテム構成か。
 * Excalidraw は読み込んだライブラリも onLibraryChange で通知するため、
 * これで判定して、ページを開くたびにライブラリファイルを書き換えないようにする。
 */
export const isLibrarySynced = (items: readonly any[]): boolean =>
  syncedItemIdsKey !== null && syncedItemIdsKey === itemIdsKey(items);

/** ライブラリファイルの文字列を解析する。空ファイルは空ライブラリとして扱う */
export const parseLibraryContent = (libraryContent: string): { libraryItems?: unknown[] } => {
  const trimmedContent = libraryContent.trim();
  if (!trimmedContent) {
    return { libraryItems: [] };
  }

  const parsed = JSON.parse(trimmedContent);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('ライブラリデータがオブジェクトではありません');
  }
  return parsed;
};

/**
 * ライブラリアイテムと要素のIDを新しい一意のIDに振り直す。
 * 1つのアイテム内では「旧ID → 新ID」の対応を共有するため、
 * グループ・テキストの所属先(containerId)・結び付き(boundElements)・矢印の接続は保たれる。
 */
export const refreshLibraryItemIds = (libraryItems: any[], seed: string = `${Date.now()}`): any[] =>
  libraryItems.map((item) => {
    const idMap = new Map<string, string>();
    const remap = (prefix: string, id: string | null | undefined): string | null | undefined => {
      if (!id) {
        return id;
      }
      let newId = idMap.get(id);
      if (!newId) {
        newId = `${prefix}-${seed}-${randomSuffix()}`;
        idMap.set(id, newId);
      }
      return newId;
    };

    // 先に全要素のIDを確定させ、前方参照（後ろの要素への containerId 等）も解決できるようにする
    for (const element of item.elements ?? []) {
      remap('elem', element.id);
    }

    const remapBinding = (binding: any) =>
      binding && binding.elementId ? { ...binding, elementId: remap('elem', binding.elementId) } : binding;

    return {
      ...item,
      id: `lib-${seed}-${randomSuffix()}`,
      elements: item.elements?.map((element: any) => ({
        ...element,
        id: remap('elem', element.id),
        groupIds: element.groupIds?.map((groupId: string) => remap('group', groupId)),
        ...(element.containerId ? { containerId: remap('elem', element.containerId) } : {}),
        ...(element.frameId ? { frameId: remap('elem', element.frameId) } : {}),
        ...(Array.isArray(element.boundElements)
          ? {
            boundElements: element.boundElements.map((bound: any) => ({
              ...bound,
              id: remap('elem', bound.id),
            })),
          }
          : {}),
        ...(element.startBinding ? { startBinding: remapBinding(element.startBinding) } : {}),
        ...(element.endBinding ? { endBinding: remapBinding(element.endBinding) } : {}),
      })),
    };
  });

/** ライブラリファイルを読み込み、IDを振り直したアイテムを返す。失敗時は null */
export const fetchLibraryItems = async (): Promise<any[] | null> => {
  try {
    const response = await fetch(LIBRARY_URL, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!response.ok) {
      return null;
    }
    const libraryData = parseLibraryContent(await response.text());
    if (!Array.isArray(libraryData.libraryItems)) {
      return null;
    }
    const items = refreshLibraryItemIds(libraryData.libraryItems);
    markLibrarySynced(items);
    console.log(`ライブラリを読み込みました: ${items.length} アイテム`);
    return items;
  } catch (error) {
    console.warn('ライブラリファイルの読み込みに失敗しました:', error);
    return null;
  }
};
