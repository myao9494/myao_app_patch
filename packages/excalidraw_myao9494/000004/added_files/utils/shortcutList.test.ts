/**
 * ショートカット一覧データおよび検索・フィルタ機能のテスト
 * 
 * 仕様:
 * 1. SHORTCUT_CATEGORIES に独自機能、描画ツール、編集・操作のカテゴリが定義されていること
 * 2. SHORTCUT_LIST に . (ピリオド) キーを含む本アプリの独自ショートカットがすべて定義されていること
 * 3. SHORTCUT_LIST に Excalidraw の主要標準ショートカットが定義されていること
 * 4. filterShortcuts によるカテゴリ絞り込みが正常に動作すること
 * 5. filterShortcuts によるキーワード検索（キー名・説明文の部分一致、大文字小文字無視）が正常に動作すること
 **/

import { describe, it, expect } from 'vitest';
import {
  SHORTCUT_CATEGORIES,
  SHORTCUT_LIST,
  filterShortcuts,
  type ShortcutItem,
} from './shortcutList';

describe('shortcutList', () => {
  describe('SHORTCUT_CATEGORIES', () => {
    it('必要なカテゴリが定義されていること', () => {
      const categoryIds = SHORTCUT_CATEGORIES.map((c) => c.id);
      expect(categoryIds).toContain('all');
      expect(categoryIds).toContain('custom');
      expect(categoryIds).toContain('tools');
      expect(categoryIds).toContain('edit');
    });
  });

  describe('SHORTCUT_LIST', () => {
    it('.（ピリオド）キーのショートカットが定義されていること', () => {
      const dotShortcut = SHORTCUT_LIST.find((s) => s.key === '.');
      expect(dotShortcut).toBeDefined();
      expect(dotShortcut?.category).toBe('custom');
      expect(dotShortcut?.description).toContain('ショートカット');
    });

    it('独自ショートカット（M, U, カンマ, C, N, W, Tab, Cmd+S, Cmd+M, Cmd+B）が定義されていること', () => {
      const customShortcuts = SHORTCUT_LIST.filter((s) => s.category === 'custom');
      const keys = customShortcuts.map((s) => s.key);

      expect(keys.some((k) => k.includes('M') && !k.includes('Cmd'))).toBe(true); // M (マーカー)
      expect(keys.some((k) => k.includes('U'))).toBe(true); // U (アンダーライン)
      expect(keys.some((k) => k.includes(','))).toBe(true); // , (設定)
      expect(keys.some((k) => k.includes('C'))).toBe(true); // C (直線)
      expect(keys.some((k) => k.includes('N'))).toBe(true); // N (付箋)
      expect(keys.some((k) => k.includes('W'))).toBe(true); // W (リンク付箋)
      expect(keys.some((k) => k.includes('Tab'))).toBe(true); // Tab (形状変更)
      expect(keys.some((k) => k.includes('S') && (k.includes('Cmd') || k.includes('Ctrl')))).toBe(true); // Cmd/Ctrl+S
      expect(keys.some((k) => k.includes('M') && (k.includes('Cmd') || k.includes('Ctrl')))).toBe(true); // Cmd/Ctrl+M
      expect(keys.some((k) => k.includes('B') && (k.includes('Cmd') || k.includes('Ctrl')))).toBe(true); // Cmd/Ctrl+B
    });

    it('標準ツールショートカット（V, R, D, O, A, L, P, T, E等）が定義されていること', () => {
      const toolShortcuts = SHORTCUT_LIST.filter((s) => s.category === 'tools');
      expect(toolShortcuts.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('filterShortcuts', () => {
    it('カテゴリ指定で絞り込めること', () => {
      const customOnly = filterShortcuts(SHORTCUT_LIST, 'custom', '');
      expect(customOnly.every((s) => s.category === 'custom')).toBe(true);
      expect(customOnly.length).toBeGreaterThan(0);
    });

    it('カテゴリ「all」の場合は全件が対象となること', () => {
      const allItems = filterShortcuts(SHORTCUT_LIST, 'all', '');
      expect(allItems.length).toBe(SHORTCUT_LIST.length);
    });

    it('検索クエリでキー名や説明文をフィルタリングできること', () => {
      const searchResults = filterShortcuts(SHORTCUT_LIST, 'all', 'マーカー');
      expect(searchResults.length).toBeGreaterThan(0);
      expect(
        searchResults.every(
          (s) =>
            s.key.toLowerCase().includes('マーカー') ||
            s.description.toLowerCase().includes('マーカー') ||
            (s.detail && s.detail.toLowerCase().includes('マーカー')),
        ),
      ).toBe(true);
    });

    it('大文字小文字を区別せず検索できること', () => {
      const upperH = filterShortcuts(SHORTCUT_LIST, 'all', 'H');
      const lowerH = filterShortcuts(SHORTCUT_LIST, 'all', 'h');
      expect(upperH.length).toBe(lowerH.length);
      expect(upperH.length).toBeGreaterThan(0);
    });
  });
});
