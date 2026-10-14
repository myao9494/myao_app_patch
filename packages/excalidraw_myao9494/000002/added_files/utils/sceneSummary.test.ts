import { describe, expect, it } from 'vitest';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { buildElementSummary, pickPersistedAppState } from './sceneSummary';

const rect = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  angle: 0,
  strokeColor: '#000',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 1,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  roundness: null,
  groupIds: [],
  frameId: null,
  link: null,
  locked: false,
  isDeleted: false,
  version: 1,
  ...overrides,
}) as unknown as NonDeletedExcalidrawElement;

const text = (overrides: Record<string, unknown> = {}) => rect({
  id: 't1',
  type: 'text',
  text: 'hello',
  fontSize: 20,
  fontFamily: 1,
  textAlign: 'left',
  verticalAlign: 'top',
  containerId: null,
  ...overrides,
});

describe('buildElementSummary', () => {
  it('バージョンだけが変わっても内容が同じなら同じ要約になる', () => {
    expect(buildElementSummary([rect()])).toBe(buildElementSummary([rect({ version: 5 })]));
  });

  it('削除済み要素は要約に含めない（削除は要素の消失として検知される）', () => {
    expect(buildElementSummary([rect(), text({ isDeleted: true })])).toBe(buildElementSummary([rect()]));
    expect(buildElementSummary([rect(), text()])).not.toBe(buildElementSummary([rect()]));
  });

  it.each([
    ['位置', { x: 10 }],
    ['サイズ', { width: 120 }],
    ['線色', { strokeColor: '#f00' }],
    ['線種', { strokeStyle: 'dashed' }],
    ['角丸', { roundness: { type: 3 } }],
    ['リンク', { link: 'https://example.com' }],
    ['グループ', { groupIds: ['g1'] }],
    ['ロック', { locked: true }],
  ])('%sの変更を検知する', (_label, change) => {
    expect(buildElementSummary([rect(change)])).not.toBe(buildElementSummary([rect()]));
  });

  it.each([
    ['文字', { text: 'world' }],
    ['文字サイズ', { fontSize: 28 }],
    ['フォント', { fontFamily: 2 }],
    ['揃え', { textAlign: 'center' }],
  ])('テキストの%sの変更を検知する', (_label, change) => {
    expect(buildElementSummary([text(change)])).not.toBe(buildElementSummary([text()]));
  });

  it('線の頂点・矢じりの変更を検知する', () => {
    const line = (overrides: Record<string, unknown> = {}) => rect({
      id: 'l1', type: 'arrow', points: [[0, 0], [50, 50]], startArrowhead: null, endArrowhead: 'arrow', ...overrides,
    });
    expect(buildElementSummary([line({ points: [[0, 0], [10, 40], [50, 50]] })])).not.toBe(buildElementSummary([line()]));
    expect(buildElementSummary([line({ endArrowhead: null })])).not.toBe(buildElementSummary([line()]));
  });

  it('重なり順の変更を検知する', () => {
    expect(buildElementSummary([rect(), text()])).not.toBe(buildElementSummary([text(), rect()]));
  });
});

describe('pickPersistedAppState', () => {
  it('選択状態などは保存対象に含めない', () => {
    const picked = pickPersistedAppState({
      viewBackgroundColor: '#fff',
      scrollX: 10,
      selectedElementIds: { a: true },
    } as any);
    expect(picked.viewBackgroundColor).toBe('#fff');
    expect(picked.scrollX).toBe(10);
    expect('selectedElementIds' in picked).toBe(false);
  });
});
