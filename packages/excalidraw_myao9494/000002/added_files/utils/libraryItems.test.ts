import { describe, expect, it } from 'vitest';
import { isLibrarySynced, markLibrarySynced, parseLibraryContent, refreshLibraryItemIds } from './libraryItems';

describe('parseLibraryContent', () => {
  it('空ファイルは空ライブラリとして扱う', () => {
    expect(parseLibraryContent('  \n')).toEqual({ libraryItems: [] });
  });

  it('オブジェクトでないJSONはエラー', () => {
    expect(() => parseLibraryContent('123')).toThrow();
  });
});

describe('refreshLibraryItemIds', () => {
  const item = {
    id: 'item-1',
    status: 'published',
    elements: [
      {
        id: 'box',
        type: 'rectangle',
        groupIds: ['g1'],
        boundElements: [{ type: 'text', id: 'label' }, { type: 'arrow', id: 'arrow' }],
      },
      { id: 'label', type: 'text', groupIds: ['g1'], containerId: 'box' },
      {
        id: 'arrow',
        type: 'arrow',
        groupIds: [],
        startBinding: { elementId: 'box', focus: 0, gap: 1 },
        endBinding: null,
      },
    ],
  };

  it('アイテムと要素のIDを振り直す', () => {
    const [refreshed] = refreshLibraryItemIds([item], 'seed');
    expect(refreshed.id).not.toBe('item-1');
    expect(refreshed.status).toBe('published');
    const ids = refreshed.elements.map((element: any) => element.id);
    expect(ids).not.toContain('box');
    expect(new Set(ids).size).toBe(3);
  });

  it('グループ・テキストの所属先・矢印の接続を保つ', () => {
    const [refreshed] = refreshLibraryItemIds([item], 'seed');
    const [box, label, arrow] = refreshed.elements;

    expect(box.groupIds).toEqual(label.groupIds);
    expect(box.groupIds[0]).not.toBe('g1');
    expect(label.containerId).toBe(box.id);
    expect(box.boundElements.map((bound: any) => bound.id)).toEqual([label.id, arrow.id]);
    expect(arrow.startBinding.elementId).toBe(box.id);
    expect(arrow.endBinding).toBeNull();
  });

  it('元のアイテムは変更しない', () => {
    refreshLibraryItemIds([item], 'seed');
    expect(item.elements[1].containerId).toBe('box');
  });
});

describe('isLibrarySynced', () => {
  it('同じアイテム構成なら同期済み（順序は問わない）、追加・削除があれば未同期', () => {
    markLibrarySynced([{ id: 'a' }, { id: 'b' }]);
    expect(isLibrarySynced([{ id: 'b' }, { id: 'a' }])).toBe(true);
    expect(isLibrarySynced([{ id: 'a' }])).toBe(false);
    expect(isLibrarySynced([{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toBe(false);
  });
});
