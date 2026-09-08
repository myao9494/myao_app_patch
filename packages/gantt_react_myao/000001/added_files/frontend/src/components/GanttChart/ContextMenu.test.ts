/**
 * ContextMenu コンポーネントおよびメニュー項目生成ユーティリティのテスト
 */
import { describe, it, expect, vi } from 'vitest';
import {
  getDateHeaderContextMenuItems,
  getEmptyAreaContextMenuItems,
} from './ContextMenu';

describe('ContextMenu - カレンダー日付右クリックメニュー', () => {
  const testDate = new Date(2026, 8, 15); // 2026-09-15
  const dateStr = '2026-09-15';

  describe('getDateHeaderContextMenuItems', () => {
    it('休日に登録されていない日付の場合、「休日を追加」メニュー項目を生成すること', () => {
      const onAddHoliday = vi.fn();
      const onRemoveHoliday = vi.fn();

      const items = getDateHeaderContextMenuItems(testDate, false, {
        onAddHoliday,
        onRemoveHoliday,
      });

      expect(items).toHaveLength(1);
      expect(items[0].label).toContain('休日を追加');
      expect(items[0].label).toContain(dateStr);

      items[0].action?.();
      expect(onAddHoliday).toHaveBeenCalledWith(dateStr);
      expect(onRemoveHoliday).not.toHaveBeenCalled();
    });

    it('既に休日に登録されている日付の場合、「休日を解除」メニュー項目を生成すること', () => {
      const onAddHoliday = vi.fn();
      const onRemoveHoliday = vi.fn();

      const items = getDateHeaderContextMenuItems(testDate, true, {
        onAddHoliday,
        onRemoveHoliday,
      });

      expect(items).toHaveLength(1);
      expect(items[0].label).toContain('休日を解除');
      expect(items[0].label).toContain(dateStr);

      items[0].action?.();
      expect(onRemoveHoliday).toHaveBeenCalledWith(dateStr);
      expect(onAddHoliday).not.toHaveBeenCalled();
    });
  });

  describe('getEmptyAreaContextMenuItems with holiday support', () => {
    it('日付が指定された場合、新規プロジェクト・タスク追加に加えて「休日を追加」が含まれること', () => {
      const onAddProject = vi.fn();
      const onAddTask = vi.fn();
      const onAddHoliday = vi.fn();

      const items = getEmptyAreaContextMenuItems(testDate, {
        onAddProject,
        onAddTask,
        onAddHoliday,
        isHoliday: false,
      });

      // 新規プロジェクト、新規タスク、divider、休日追加
      expect(items.some((i) => i.label === '新規プロジェクト追加')).toBe(true);
      expect(items.some((i) => i.label === '新規タスク追加')).toBe(true);
      expect(items.some((i) => i.label?.includes('休日を追加'))).toBe(true);

      const holidayItem = items.find((i) => i.label?.includes('休日を追加'));
      holidayItem?.action?.();
      expect(onAddHoliday).toHaveBeenCalledWith(dateStr);
    });

    it('日付が既に休日の場合、「休日を解除」が含まれること', () => {
      const onAddProject = vi.fn();
      const onAddTask = vi.fn();
      const onRemoveHoliday = vi.fn();

      const items = getEmptyAreaContextMenuItems(testDate, {
        onAddProject,
        onAddTask,
        onRemoveHoliday,
        isHoliday: true,
      });

      expect(items.some((i) => i.label?.includes('休日を解除'))).toBe(true);

      const removeHolidayItem = items.find((i) => i.label?.includes('休日を解除'));
      removeHolidayItem?.action?.();
      expect(onRemoveHoliday).toHaveBeenCalledWith(dateStr);
    });

    it('日付がnullの場合、休日項目は含まれず新規プロジェクト・タスク追加のみとなること（後方互換性）', () => {
      const onAddProject = vi.fn();
      const onAddTask = vi.fn();

      const items = getEmptyAreaContextMenuItems(null, {
        onAddProject,
        onAddTask,
      });

      expect(items).toHaveLength(2);
      expect(items[0].label).toBe('新規プロジェクト追加');
      expect(items[1].label).toBe('新規タスク追加');
    });
  });
});
