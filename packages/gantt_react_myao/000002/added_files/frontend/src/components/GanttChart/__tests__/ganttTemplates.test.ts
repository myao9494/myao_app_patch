/**
 * @vitest-environment jsdom
 * ガントチャートの表示テンプレート（ganttTemplates）のテスト
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gantt } from 'dhtmlx-gantt';
import type { Task as GanttTask } from 'dhtmlx-gantt';
import type { BusinessTripType } from '../../../types/gantt';
import { applyStaticTemplates, applyTaskBarTemplates, buildScheduleHtml } from '../ganttTemplates';
import { createGanttSyncState, syncGanttData } from '../ganttSync';
import { makeTask, setupGantt } from './ganttTestHarness';

let teardown: () => void;
const START = new Date(2026, 2, 10);
const END = new Date(2026, 2, 13);

function render(html: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  return wrapper;
}

function barText(task: GanttTask): string {
  return gantt.templates.task_text(START, END, task);
}

function rightsideText(task: GanttTask): string {
  return gantt.templates.rightside_text(START, END, task);
}

beforeEach(() => {
  teardown = setupGantt();
  syncGanttData(
    [
      makeTask(1, { text: 'Project <A&B>', kind_task: 2 }),
      makeTask(2, { text: 'Task "quoted" <b>bold</b>', parent: 1, hyperlink: '/vault/a "b".md' }),
      makeTask(3, { text: 'Milestone', parent: 1, kind_task: 3 }),
      makeTask(4, { text: 'Root task' }),
    ],
    [],
    createGanttSyncState(),
  );
  applyTaskBarTemplates(false);
});

afterEach(() => {
  teardown();
});

describe('タスクバー内のテキスト', () => {
  it('プロジェクトは "[id]名前" を表示し、名前はHTMLとして解釈させないこと', () => {
    const label = render(barText(gantt.getTask(1))).querySelector('span');

    expect(label?.textContent).toBe('[1]Project <A&B>');
    expect(label?.children).toHaveLength(0);
  });

  it('タスクとマイルストーンはバー内にラベルを出さないこと', () => {
    expect(barText(gantt.getTask(2))).toBe('');
    expect(barText(gantt.getTask(3))).toBe('');
  });

  it('ハイパーリンク付きプロジェクトは、リンク先を属性に持つリンクとして表示すること', () => {
    const task = gantt.getTask(1);
    task.hyperlink = 'https://example.com/?a=1&b="2"';

    const link = render(barText(task)).querySelector('a');

    expect(link?.dataset.taskId).toBe('1');
    expect(link?.dataset.hyperlink).toBe('https://example.com/?a=1&b="2"');
    expect(link?.textContent).toBe('[1]Project <A&B>');
  });
});

describe('バー右側のテキスト', () => {
  it('タスクは "[id] 名前 > [親id] 親の名前" を、エスケープして表示すること', () => {
    const wrapper = render(rightsideText(gantt.getTask(2)));
    const link = wrapper.querySelector('a');

    expect(wrapper.textContent).toBe('[2] Task "quoted" <b>bold</b> > [1] Project <A&B>');
    expect(wrapper.querySelector('b')).toBeNull();
    expect(link?.dataset.hyperlink).toBe('/vault/a "b".md');
  });

  it('親のないタスクは自分の名前だけ、プロジェクトは何も表示しないこと', () => {
    expect(rightsideText(gantt.getTask(4))).toBe('[4] Root task');
    expect(rightsideText(gantt.getTask(1))).toBe('');
  });
});

describe('印刷モード', () => {
  it('バー内を空にし、右側にタスク名だけを表示すること', () => {
    applyTaskBarTemplates(true);

    expect(barText(gantt.getTask(1))).toBe('');
    expect(render(rightsideText(gantt.getTask(1))).textContent).toBe('Project <A&B>');
  });

  it('通常モードに戻すと元の表示に戻ること', () => {
    applyTaskBarTemplates(true);
    applyTaskBarTemplates(false);

    expect(rightsideText(gantt.getTask(4))).toBe('[4] Root task');
  });
});

describe('スケジュールのピン', () => {
  it('スケジュール1件につきピンを1つ描き、操作用の情報を属性に持たせること', () => {
    const task = gantt.getTask(2);
    task.task_schedule = '2026-03-11 打合せ <重要>\n不正な行\n2026-03-12 00:00:00 レビュー';

    const pins = render(buildScheduleHtml(task)).querySelectorAll<HTMLElement>('.gantt-schedule-event');

    expect(pins).toHaveLength(2);
    expect(pins[0].dataset).toMatchObject({
      taskId: '2',
      scheduleIndex: '0',
      scheduleDate: '2026-03-11',
      scheduleText: '打合せ <重要>',
    });
    expect(pins[0].querySelector('.gantt-schedule-tooltip')?.textContent).toBe('2026-03-11 打合せ <重要>');
    // ツールチップには時刻を出さない
    expect(pins[1].querySelector('.gantt-schedule-tooltip')?.textContent).toBe('2026-03-12 レビュー');
  });

  it('スケジュールが無ければ何も描かないこと', () => {
    expect(buildScheduleHtml(gantt.getTask(4))).toBe('');
  });
});

describe('行・セルのクラス', () => {
  const holidays = new Set<string>();
  const trips = new Map<string, BusinessTripType>();
  let focusTaskId: number | null = null;

  beforeEach(() => {
    holidays.clear();
    trips.clear();
    focusTaskId = null;
    applyStaticTemplates({
      getHolidays: () => holidays,
      getBusinessTrips: () => trips,
      getKeyboardFocusTaskId: () => focusTaskId,
    });
  });

  function cellClass(date: Date): string {
    return gantt.templates.timeline_cell_class(gantt.getTask(4), date);
  }

  it('土日と登録済みの休日を休日色にすること', () => {
    holidays.add('2026-03-11');

    expect(cellClass(new Date(2026, 2, 14))).toBe('weekend'); // 土曜
    expect(cellClass(new Date(2026, 2, 15))).toBe('weekend'); // 日曜
    expect(cellClass(new Date(2026, 2, 11))).toBe('weekend'); // 登録した休日（水曜）
    expect(cellClass(new Date(2026, 2, 12))).toBe('');
  });

  it('出張日は休日より優先して出張の色にすること', () => {
    holidays.add('2026-03-11');
    trips.set('2026-03-11', 'normal_trip');
    trips.set('2026-03-14', 'day_trip');

    expect(cellClass(new Date(2026, 2, 11))).toBe('business-trip-normal');
    expect(cellClass(new Date(2026, 2, 14))).toBe('business-trip-day');
  });

  it('種別と固定状態をバーのクラスにすること', () => {
    const pinned = gantt.getTask(4);
    pinned.is_pinned = true;

    expect(gantt.templates.task_class(START, END, gantt.getTask(1))).toBe('pro');
    expect(gantt.templates.task_class(START, END, gantt.getTask(3))).toBe('ms');
    expect(gantt.templates.task_class(START, END, pinned)).toBe('task pinned-task');
  });

  it('キーボードでフォーカス中の行だけを強調すること', () => {
    focusTaskId = 2;

    expect(gantt.templates.grid_row_class(START, END, gantt.getTask(2))).toBe('keyboard-focus-row');
    expect(gantt.templates.task_row_class(START, END, gantt.getTask(3))).toBe('');
  });

  it('ツリーのアイコンを種類とリンク先に応じて切り替えること', () => {
    expect(gantt.templates.grid_folder(gantt.getTask(1))).toContain('/icons/catppuccin/folder_project_open.svg');
    expect(gantt.templates.grid_file(gantt.getTask(2))).toContain('/icons/catppuccin/markdown.svg');
    expect(gantt.templates.grid_file(gantt.getTask(4))).toContain('/icons/catppuccin/file.svg');
  });
});
