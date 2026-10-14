import { describe, it, expect } from 'vitest';
import type { Task } from '../../types/gantt';
import { getMostRecentMonday, planAutoMove } from '../autoMoveTasks';

// 2026-03-18 は水曜日。直近の月曜日は 2026-03-16
const NOW = new Date(2026, 2, 18, 15, 30);

function task(overrides: Partial<Task>): Task {
  return {
    id: 1,
    text: 'Task',
    start_date: '2026-03-10 00:00:00',
    end_date: '2026-03-13 00:00:00',
    duration: 3,
    progress: 0,
    parent: 0,
    kind_task: 1,
    owner_id: 0,
    sortorder: 0,
    ...overrides,
  };
}

describe('getMostRecentMonday', () => {
  it('週の途中なら、その週の月曜日を返すこと', () => {
    expect(getMostRecentMonday(NOW)).toEqual(new Date(2026, 2, 16));
  });

  it('月曜日ならその日、日曜日なら6日前の月曜日を返すこと', () => {
    expect(getMostRecentMonday(new Date(2026, 2, 16, 9))).toEqual(new Date(2026, 2, 16));
    expect(getMostRecentMonday(new Date(2026, 2, 22))).toEqual(new Date(2026, 2, 16));
  });
});

describe('planAutoMove', () => {
  it('開始日が過去の未完了タスクを、期間を保ったまま今日開始にすること', () => {
    expect(planAutoMove([task({ id: 7 })], NOW)).toEqual([
      { id: 7, start_date: '2026-03-18 00:00:00', end_date: '2026-03-21 00:00:00' },
    ]);
  });

  it('開始日が過去の未完了プロジェクトを、直近の月曜日開始にすること', () => {
    const project = task({ id: 8, kind_task: 2, duration: 10 });

    expect(planAutoMove([project], NOW)).toEqual([
      { id: 8, start_date: '2026-03-16 00:00:00', end_date: '2026-03-26 00:00:00' },
    ]);
  });

  it('完了済み・固定・マイルストーン・未来開始のタスクは動かさないこと', () => {
    const untouched = [
      task({ id: 1, progress: 1 }),
      task({ id: 2, is_pinned: true }),
      task({ id: 3, kind_task: 3 }),
      task({ id: 4, start_date: '2026-03-19 00:00:00' }),
    ];

    expect(planAutoMove(untouched, NOW)).toEqual([]);
  });

  it('既に移動先の日付で始まっているものは対象にしないこと', () => {
    const alreadyThere = [
      task({ id: 1, start_date: '2026-03-18 09:00:00' }),
      task({ id: 2, kind_task: 2, start_date: '2026-03-16 00:00:00' }),
    ];

    expect(planAutoMove(alreadyThere, NOW)).toEqual([]);
  });

  it('今週の月曜より後に始まった進行中プロジェクトも月曜日へ戻すこと', () => {
    const project = task({ id: 9, kind_task: 2, start_date: '2026-03-17 00:00:00', duration: 0 });

    expect(planAutoMove([project], NOW)).toEqual([
      { id: 9, start_date: '2026-03-16 00:00:00', end_date: '2026-03-17 00:00:00' },
    ]);
  });
});
