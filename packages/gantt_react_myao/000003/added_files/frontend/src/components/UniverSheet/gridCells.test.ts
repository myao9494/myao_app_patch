import { describe, expect, it } from 'vitest';
import type { GridDiffItem, Link, Task } from '../../types/gantt';
import { createHeaderRow, createRowsFromLinks, createRowsFromTasks, toStagingValue } from './gridCells';
import { LINK_COLUMN_DEFINITIONS, TASK_COLUMN_DEFINITIONS } from './gridColumns';
import { buildTaskNamePrefix } from './gridTaskName';

function makeTask(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    text: `Task ${id}`,
    start_date: '2026-03-10 00:00:00',
    end_date: '2026-03-13 00:00:00',
    duration: 3,
    progress: 0.4,
    parent: 0,
    kind_task: 1,
    owner_id: 0,
    sortorder: 0,
    ...overrides,
  };
}

const columnIndex = (field: string) => TASK_COLUMN_DEFINITIONS.findIndex((column) => column.field === field);
const diffItem = (overrides: Partial<GridDiffItem>): GridDiffItem => ({
  id: 1, table: 'tasks', field: 'text', original: 'a', current: 'b', ...overrides,
});

describe('createHeaderRow', () => {
  it('列名を1行目のセルにすること', () => {
    const header = createHeaderRow(LINK_COLUMN_DEFINITIONS);

    expect(Object.values(header).map((cell) => cell.v)).toEqual(LINK_COLUMN_DEFINITIONS.map((column) => column.name));
  });
});

describe('createRowsFromTasks', () => {
  it('2行目から、タスクの順に行を作ること（1行目はヘッダー用に空ける）', () => {
    const rows = createRowsFromTasks([makeTask(7), makeTask(8)], [], false);

    expect(Object.keys(rows)).toEqual(['1', '2']);
    expect(rows[1][columnIndex('id')].v).toBe('7');
    expect(rows[2][columnIndex('id')].v).toBe('8');
  });

  it('タスク名には階層のアイコンを付け、進捗は%、日付は年月日だけで表示すること', () => {
    const task = makeTask(1);
    const row = createRowsFromTasks([task], [], false)[1];

    expect(row[columnIndex('text')].v).toBe(`${buildTaskNamePrefix(task)}Task 1`);
    expect(row[columnIndex('progress')].v).toBe(40);
    expect(row[columnIndex('start_date')].v).toBe('2026-03-10');
  });

  it('差分のあるセルはステージングの値で表示し、背景色を付けること', () => {
    const task = makeTask(1);
    const diffs = [diffItem({ field: 'progress', current: '0.75' })];

    const light = createRowsFromTasks([task], diffs, false)[1];
    const dark = createRowsFromTasks([task], diffs, true)[1];

    expect(light[columnIndex('progress')].v).toBe(75);
    expect(light[columnIndex('progress')].s).toMatchObject({ bg: { rgb: '#FFF3CD' } });
    expect(dark[columnIndex('progress')].s).toMatchObject({ bg: { rgb: '#5C4B00' } });
    expect(light[columnIndex('text')].s).not.toHaveProperty('bg');
  });

  it('他のテーブルや他のタスクの差分は反映しないこと', () => {
    const diffs = [diffItem({ table: 'links', id: 1 }), diffItem({ id: 2, field: 'memo', current: 'x' })];

    const row = createRowsFromTasks([makeTask(1)], diffs, false)[1];

    expect(Object.values(row).every((cell) => !(cell.s && 'bg' in cell.s))).toBe(true);
  });
});

describe('createRowsFromLinks', () => {
  const link: Link = { id: 5, source: 1, target: 2, type: 0 };

  it('リンクの値を行にし、差分のあるセルはステージングの値と背景色にすること', () => {
    const diffs = [diffItem({ table: 'links', id: 5, field: 'type', current: '2' })];

    const row = createRowsFromLinks([link], diffs, false)[1];

    expect(row[0].v).toBe(5);
    expect(row[1].v).toBe(1);
    expect(row[3].v).toBe('2');
    expect(row[3].s).toMatchObject({ bg: { rgb: '#FFF3CD' } });
  });
});

describe('toStagingValue', () => {
  const task = makeTask(1);

  it('空文字は null にすること', () => {
    expect(toStagingValue('memo', '', task)).toBeNull();
  });

  it('タスク名は、表示用の装飾を取り除くこと', () => {
    expect(toStagingValue('text', `${buildTaskNamePrefix(task)}New name`, task)).toBe('New name');
  });

  it('進捗率は 0〜100(%) を 0.0〜1.0 に戻し、空欄は 0 にすること', () => {
    expect(toStagingValue('progress', 50, task)).toBe(0.5);
    expect(toStagingValue('progress', '', task)).toBe(0);
  });

  it('それ以外の値はそのまま返すこと', () => {
    expect(toStagingValue('sortorder', 3, task)).toBe(3);
  });
});
