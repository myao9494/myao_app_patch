/**
 * Gantt関連テストの共通ヘルパー
 * モックではなく実物の DHTMLX Gantt を jsdom 上で初期化して使う
 * （gantt はシングルトンなので、テストごとに必ず teardown でデータを消す）。
 */
import { gantt } from 'dhtmlx-gantt';
import type { Link, Task } from '../../../types/gantt';

export function setupGantt(): () => void {
  const container = document.createElement('div');
  document.body.appendChild(container);

  gantt.plugins({ undo: true, marker: true, multiselect: true });
  gantt.config.undo = true;
  gantt.init(container);

  return () => {
    gantt.clearAll();
    gantt.clearUndoStack?.();
    gantt.clearRedoStack?.();
    container.remove();
  };
}

export function makeTask(id: number, overrides: Partial<Task> = {}): Task {
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
    is_pinned: false,
    ...overrides,
  };
}

export function makeLink(id: number, source: number, target: number, type: Link['type'] = 0): Link {
  return { id, source, target, type };
}

/** 保留中の Promise（APIモックの応答処理など）を消化する */
export function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** DHTMLXのUndoプラグインは、操作を約10ms分まとめてから履歴に積む。それを待つ */
export function waitForUndoBatch(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

/** gantt上の、指定した親の子タスクIDを表示順で返す */
export function childIds(parentId: number | string = 0): number[] {
  return gantt.getChildren(parentId).map(Number);
}
