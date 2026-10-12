import { describe, it, expect } from 'vitest';
import {
  parseSchedule,
  formatDateForSchedule,
  addOrUpdateSchedule,
  updateScheduleAtIndex,
  removeScheduleAtIndex,
  moveScheduleAtIndex,
  getScheduleAtIndex,
} from './scheduleParser';

describe('scheduleParser', () => {
  describe('parseSchedule', () => {
    it('正しいフォーマットの文字列をパースできること', () => {
      const input = '2026-03-20 会議';
      const result = parseSchedule(input);
      expect(result).toHaveLength(1);
      expect(result[0].date).toBeInstanceOf(Date);
      expect(result[0].date.getFullYear()).toBe(2026);
      expect(result[0].date.getMonth()).toBe(2); // 0-indexed
      expect(result[0].date.getDate()).toBe(20);
      expect(result[0].text).toBe('会議');
    });

    it('複数行のスケジュールをパースできること', () => {
      const input = '2026-03-20 会議\n2026-04-15 見積期限\n2026-04-30 出図';
      const result = parseSchedule(input);
      expect(result).toHaveLength(3);
      expect(result[0].text).toBe('会議');
      expect(result[1].text).toBe('見積期限');
      expect(result[2].text).toBe('出図');
    });

    it('空行や不正な行は無視されること', () => {
      const input = '2026-03-20 会議\n\n不正なフォーマット\n2026-04-15 見積期限';
      const result = parseSchedule(input);
      expect(result).toHaveLength(2);
      expect(result[0].text).toBe('会議');
      expect(result[1].text).toBe('見積期限');
    });

    it('日付とテキストの間に複数のスペースがあってもパースできること', () => {
      const input = '2026-03-20    会議';
      const result = parseSchedule(input);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('会議');
    });

    it('テキスト内にスペースが含まれていても正しくパースできること', () => {
      const input = '2026-03-20 重要な 会議';
      const result = parseSchedule(input);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('重要な 会議');
    });

    it('nullまたはundefinedの場合は空の配列を返すこと', () => {
      expect(parseSchedule(null as unknown as string)).toEqual([]);
      expect(parseSchedule(undefined as unknown as string)).toEqual([]);
      expect(parseSchedule('')).toEqual([]);
    });
  });

  describe('formatDateForSchedule', () => {
    it('Dateオブジェクトから YYYY-MM-DD 形式の文字列を生成できること', () => {
      const date = new Date(2026, 2, 20); // 2026-03-20
      expect(formatDateForSchedule(date)).toBe('2026-03-20');
    });
  });

  describe('addOrUpdateSchedule', () => {
    it('空のスケジュールに新しいスケジュールを追加できること', () => {
      const current = '';
      const newDateStr = '2026-03-20';
      const newText = '新しい会議';
      const result = addOrUpdateSchedule(current, newDateStr, newText);
      expect(result).toBe('2026-03-20 新しい会議');
    });

    it('既存のスケジュールの中に異なる日付でスケジュールを追加できること', () => {
      const current = '2026-03-20 既存の会議';
      const newDateStr = '2026-04-15';
      const newText = '見積期限';
      const result = addOrUpdateSchedule(current, newDateStr, newText);
      // 日付順にソートされることを期待（仕様としてソートも行うと良い）
      expect(result).toContain('2026-03-20 既存の会議');
      expect(result).toContain('2026-04-15 見積期限');
    });

    it('同じ日付のスケジュールが存在する場合、追記（カンマ区切り等）されること', () => {
      const current = '2026-03-20 会議A';
      const newDateStr = '2026-03-20';
      const newText = '会議B';
      const result = addOrUpdateSchedule(current, newDateStr, newText);
      expect(result).toBe('2026-03-20 会議A, 会議B');
    });
  });

  describe('updateScheduleAtIndex', () => {
    it('指定した予定だけ編集できること', () => {
      const current = '2026-03-20 会議A\n2026-04-01 会議B';
      const targetIndex = parseSchedule(current)[1].sourceIndex!;
      const result = updateScheduleAtIndex(current, targetIndex, '2026-04-03', 'レビュー');
      expect(result).toBe('2026-03-20 会議A\n2026-04-03 レビュー');
    });
  });

  describe('removeScheduleAtIndex', () => {
    it('指定した予定だけ削除できること', () => {
      const current = '2026-03-20 会議A\n2026-04-01 会議B';
      const targetIndex = parseSchedule(current)[0].sourceIndex!;
      const result = removeScheduleAtIndex(current, targetIndex);
      expect(result).toBe('2026-04-01 会議B');
    });
  });

  describe('moveScheduleAtIndex', () => {
    it('指定した予定の日付だけ変更できること', () => {
      const current = '2026-03-20 会議A\n2026-04-01 会議B';
      const targetIndex = parseSchedule(current)[0].sourceIndex!;
      const result = moveScheduleAtIndex(current, targetIndex, '2026-04-10');
      expect(result).toBe('2026-04-01 会議B\n2026-04-10 会議A');
    });
  });

  describe('getScheduleAtIndex', () => {
    it('指定した予定を取得できること', () => {
      const current = '2026-03-20 会議A\n2026-04-01 会議B';
      const targetIndex = parseSchedule(current)[1].sourceIndex!;
      const result = getScheduleAtIndex(current, targetIndex);
      expect(result?.text).toBe('会議B');
      expect(formatDateForSchedule(result!.date)).toBe('2026-04-01');
    });
  });
});
