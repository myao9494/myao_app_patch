/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { resolveTimelineShortcutContext, resolveTimelineCellContext } from '../ganttTimelineShortcut';

describe('resolveTimelineShortcutContext', () => {
  it('タイムライン上のマウス位置から対象タスクと日付を解決できること', () => {
    const timelineElement = document.createElement('div');
    timelineElement.className = 'gantt_task_data';
    Object.defineProperty(timelineElement, 'scrollLeft', { value: 120, configurable: true });
    timelineElement.getBoundingClientRect = () =>
      ({ left: 40, top: 0, right: 440, bottom: 300, width: 400, height: 300, x: 40, y: 0, toJSON: () => ({}) }) as DOMRect;

    const cell = document.createElement('div');
    cell.className = 'gantt_task_cell';
    const row = document.createElement('div');
    row.setAttribute('data-task-id', '12');
    row.appendChild(cell);
    timelineElement.appendChild(row);
    document.body.appendChild(timelineElement);

    const result = resolveTimelineShortcutContext({
      eventTarget: cell,
      clientX: 90,
      timelineElement,
      taskAttribute: 'data-task-id',
      dateFromPos: (x) => {
        expect(x).toBe(170);
        return new Date(2026, 3, 8, 15, 30, 0);
      },
    });

    expect(result).toEqual({
      taskId: 12,
      date: new Date(2026, 3, 8),
    });
  });

  it('タイムライン外のイベントは無視すること', () => {
    const timelineElement = document.createElement('div');
    timelineElement.className = 'gantt_task_data';
    timelineElement.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    const other = document.createElement('div');
    document.body.appendChild(other);

    const result = resolveTimelineShortcutContext({
      eventTarget: other,
      clientX: 50,
      timelineElement,
      taskAttribute: 'data-task-id',
      dateFromPos: () => new Date(2026, 3, 8),
    });

    expect(result).toBeNull();
  });
});

describe('resolveTimelineCellContext', () => {
  it('タスクバー要素のクリックからタスクIDと日付を行列から正しく解決できること', () => {
    const timelineElement = document.createElement('div');
    timelineElement.className = 'gantt_task_data';
    Object.defineProperty(timelineElement, 'scrollLeft', { value: 100, configurable: true });
    Object.defineProperty(timelineElement, 'scrollTop', { value: 0, configurable: true });
    timelineElement.getBoundingClientRect = () =>
      ({ left: 50, top: 0, right: 450, bottom: 300, width: 400, height: 300, x: 50, y: 0, toJSON: () => ({}) }) as DOMRect;

    const taskBar = document.createElement('div');
    taskBar.setAttribute('task_id', '42');
    timelineElement.appendChild(taskBar);
    document.body.appendChild(timelineElement);

    const result = resolveTimelineCellContext({
      clientX: 150,
      clientY: 30,
      timelineElement,
      eventTarget: taskBar,
      taskAttribute: 'task_id',
      dateFromPos: (x) => {
        // x = 150 - 50 + 100 = 200
        expect(x).toBe(200);
        return new Date(2026, 4, 10, 10, 0, 0);
      },
    });

    expect(result).toEqual({
      taskId: 42,
      date: new Date(2026, 4, 10),
    });
  });

  it('タスクバーのない背景セルクリック時でも、Y座標（行）とX座標（列）からタスクIDと日付を解決できること', () => {
    const timelineElement = document.createElement('div');
    timelineElement.className = 'gantt_task_data';
    Object.defineProperty(timelineElement, 'scrollLeft', { value: 50, configurable: true });
    Object.defineProperty(timelineElement, 'scrollTop', { value: 40, configurable: true });
    timelineElement.getBoundingClientRect = () =>
      ({ left: 20, top: 10, right: 420, bottom: 310, width: 400, height: 300, x: 20, y: 10, toJSON: () => ({}) }) as DOMRect;

    const bgCell = document.createElement('div');
    bgCell.className = 'gantt_task_cell';
    timelineElement.appendChild(bgCell);
    document.body.appendChild(timelineElement);

    const result = resolveTimelineCellContext({
      clientX: 120,
      clientY: 70,
      timelineElement,
      eventTarget: bgCell,
      taskAttribute: 'task_id',
      dateFromPos: (x) => {
        // x = 120 - 20 + 50 = 150
        expect(x).toBe(150);
        return new Date(2026, 4, 15);
      },
      getItemIndexByTopPosition: (top) => {
        // top = 70 - 10 + 40 = 100
        expect(top).toBe(100);
        return 2;
      },
      getTaskByIndex: (index) => {
        expect(index).toBe(2);
        return { id: 99, text: 'Test Task in Row 2' };
      },
    });

    expect(result).toEqual({
      taskId: 99,
      date: new Date(2026, 4, 15),
    });
  });

  it('該当するタスクが存在しない領域ではnullを返すこと', () => {
    const timelineElement = document.createElement('div');
    timelineElement.className = 'gantt_task_data';
    Object.defineProperty(timelineElement, 'scrollLeft', { value: 0, configurable: true });
    Object.defineProperty(timelineElement, 'scrollTop', { value: 0, configurable: true });
    timelineElement.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    const result = resolveTimelineCellContext({
      clientX: 50,
      clientY: 250,
      timelineElement,
      eventTarget: timelineElement,
      dateFromPos: () => new Date(2026, 4, 15),
      getItemIndexByTopPosition: () => -1,
      getTaskByIndex: () => null,
    });

    expect(result).toBeNull();
  });
});
