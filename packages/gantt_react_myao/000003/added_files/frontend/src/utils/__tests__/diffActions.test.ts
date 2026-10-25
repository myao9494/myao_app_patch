import { describe, expect, it } from 'vitest';
import type { Task } from '../../types/gantt';
import type { TaskDiff } from '../../types/diff';
import { filterDiffsBySearch, planRevert } from '../diffActions';

function makeTask(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    text: `Task ${id}`,
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

describe('filterDiffsBySearch', () => {
  const diffs: TaskDiff[] = [
    { type: 'added', task: makeTask(1, { text: 'Alpha Report', memo: 'urgent' }) },
    { type: 'deleted', task: makeTask(22, { text: 'Beta' }) },
    { type: 'modified', task: makeTask(3, { text: 'Gamma' }) },
  ];

  it('検索語が空（空白のみ）なら、そのまま返すこと', () => {
    expect(filterDiffsBySearch(diffs, '')).toBe(diffs);
    expect(filterDiffsBySearch(diffs, ' 　 ')).toBe(diffs);
  });

  it('タスク名・ID・メモを、大文字小文字を区別せずに検索すること', () => {
    expect(filterDiffsBySearch(diffs, 'alpha').map((d) => d.task.id)).toEqual([1]);
    expect(filterDiffsBySearch(diffs, '22').map((d) => d.task.id)).toEqual([22]);
    expect(filterDiffsBySearch(diffs, 'URGENT').map((d) => d.task.id)).toEqual([1]);
  });

  it('半角・全角スペース区切りの語は、すべて含むものだけを残すこと（AND検索）', () => {
    expect(filterDiffsBySearch(diffs, 'alpha　urgent').map((d) => d.task.id)).toEqual([1]);
    expect(filterDiffsBySearch(diffs, 'alpha beta')).toEqual([]);
  });
});

describe('planRevert', () => {
  it('追加された差分は削除、削除された差分は作成に戻すこと', () => {
    expect(planRevert({ type: 'added', task: makeTask(1) })).toEqual({ kind: 'delete', id: 1 });
    expect(planRevert({ type: 'deleted', task: makeTask(2) })).toEqual({ kind: 'create', data: makeTask(2) });
  });

  it('変更された差分は、ファイルの値で更新すること（idは含めない）', () => {
    const original = makeTask(3, { text: 'Old' });
    const action = planRevert({ type: 'modified', task: makeTask(3, { text: 'New' }), originalTask: original });

    expect(action?.kind).toBe('update');
    if (action?.kind !== 'update') return;
    expect(action.id).toBe(3);
    expect(action.data.text).toBe('Old');
    expect('id' in action.data).toBe(false);
  });

  it('1項目だけを指定したときは、その項目だけを戻すこと', () => {
    const diff: TaskDiff = {
      type: 'modified',
      task: makeTask(3, { text: 'New', memo: 'new memo' }),
      originalTask: makeTask(3, { text: 'Old', memo: 'old memo' }),
    };

    expect(planRevert(diff, 'text')).toEqual({ kind: 'update', id: 3, data: { text: 'Old' } });
  });

  it('日付・期間のどれかを戻すときは、3項目をセットで戻すこと', () => {
    const diff: TaskDiff = {
      type: 'modified',
      task: makeTask(3, { duration: 5, end_date: '2026-03-15 00:00:00' }),
      originalTask: makeTask(3),
    };

    expect(planRevert(diff, 'duration')).toEqual({
      kind: 'update',
      id: 3,
      data: { duration: 3, start_date: '2026-03-10 00:00:00', end_date: '2026-03-13 00:00:00' },
    });
  });

  it('変更前の値がない変更や、変更なしの差分は戻せないこと', () => {
    expect(planRevert({ type: 'modified', task: makeTask(1) })).toBeNull();
    expect(planRevert({ type: 'unchanged', task: makeTask(1) })).toBeNull();
  });
});
