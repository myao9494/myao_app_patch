import { describe, it, expect } from 'vitest';
import type { Task } from '../../types/gantt';
import { stripLeadingNoise } from '../../utils/taskText';
import { buildTaskNamePrefix, stripTaskNamePrefix } from './gridTaskName';
import { LINK_COLUMN_DEFINITIONS, TASK_COLUMN_DEFINITIONS } from './gridColumns';

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

const project = task({ kind_task: 2, indent: 0 });
const nestedTask = task({ indent: 2 });
const linkedTask = task({ indent: 1, hyperlink: 'https://example.com/page' });
const markdownTask = task({ hyperlink: '/vault/note.md' });

describe('buildTaskNamePrefix', () => {
  it('階層の深さ分の全角スペースと、種類に応じたアイコンを付けること', () => {
    expect(buildTaskNamePrefix(project)).toBe('📂 ');
    expect(buildTaskNamePrefix(nestedTask)).toBe('\u3000\u3000📄 ');
    expect(buildTaskNamePrefix(linkedTask)).toBe('\u3000🔗 ');
    expect(buildTaskNamePrefix(markdownTask)).toBe('📝 ');
  });
});

describe('stripTaskNamePrefix', () => {
  it.each([project, nestedTask, linkedTask, markdownTask])(
    '表示用の装飾を残したまま編集しても、タスク名だけが取り出せること',
    (target) => {
      const cellValue = `${buildTaskNamePrefix(target)}新しい名前`;

      expect(stripTaskNamePrefix(cellValue, target)).toBe('新しい名前');
    },
  );

  it('バックエンドの除去対象に無いアイコン（📂 🔗 など）も確実に取り除けること', () => {
    // 以前は装飾ごと送っており、バックエンドで消えないアイコンがタスク名に残っていた
    const cellValue = `${buildTaskNamePrefix(project)}プロジェクト名`;

    expect(stripLeadingNoise(cellValue)).toBe('📂 プロジェクト名');
    expect(stripTaskNamePrefix(cellValue, project)).toBe('プロジェクト名');
  });

  it('インデントだけ消された場合もアイコンを取り除くこと', () => {
    expect(stripTaskNamePrefix('🔗 名前', linkedTask)).toBe('名前');
    expect(stripTaskNamePrefix('\u3000\u3000\u3000🔗名前', linkedTask)).toBe('名前');
  });

  it('セル全体を打ち直した場合は、先頭の空白だけを除いてそのまま使うこと', () => {
    expect(stripTaskNamePrefix('  打ち直した名前', project)).toBe('打ち直した名前');
    expect(stripTaskNamePrefix('🎨 デザイン', nestedTask)).toBe('🎨 デザイン');
  });
});

describe('列定義', () => {
  it('1列目がIDで、フィールド名に重複が無いこと', () => {
    for (const definitions of [TASK_COLUMN_DEFINITIONS, LINK_COLUMN_DEFINITIONS]) {
      const fields = definitions.map((column) => column.field);
      expect(fields[0]).toBe('id');
      expect(new Set(fields).size).toBe(fields.length);
    }
  });

  it('Tasksシートは 開始日〜文字色 が3〜12列目に並んでいること（中央揃えの対象範囲）', () => {
    const fields = TASK_COLUMN_DEFINITIONS.map((column) => column.field);

    expect(fields.slice(2, 12)).toEqual([
      'start_date', 'end_date', 'duration', 'progress', 'parent',
      'kind_task', 'owner_id', 'sortorder', 'color', 'textColor',
    ]);
  });
});
