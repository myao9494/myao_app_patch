/**
 * @vitest-environment jsdom
 * Gantt上の操作をバックエンドへ保存するイベントハンドラ（ganttEvents）のテスト
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gantt } from 'dhtmlx-gantt';
import type { Task } from '../../../types/gantt';
import { formatEditDate } from '../../../constants/gantt';
import { reorderTasks } from '../../../services/api';
import { attachGanttEvents, type GanttDataCallbacks, type GanttEventDeps } from '../ganttEvents';
import { createGanttSyncState, syncGanttData, type GanttSyncState } from '../ganttSync';
import { childIds, flushPromises, makeLink, makeTask, setupGantt, waitForUndoBatch } from './ganttTestHarness';

vi.mock('../../../services/api', () => ({
  reorderTasks: vi.fn(() => Promise.resolve({ success: true })),
}));

let teardown: () => void;
let detach: () => void;
let state: GanttSyncState;
let callbacks: Required<GanttDataCallbacks>;
let requestSync: ReturnType<typeof vi.fn<() => void>>;
let serverTasks: Task[];

function attach(overrides: Partial<GanttEventDeps> = {}): () => void {
  return attachGanttEvents({
    getCallbacks: () => callbacks,
    getSyncState: () => state,
    requestSync,
    onTaskSelected: () => {},
    onContextMenu: () => {},
    ...overrides,
  });
}

beforeEach(() => {
  teardown = setupGantt();
  state = createGanttSyncState();
  requestSync = vi.fn<() => void>();
  callbacks = {
    onTaskUpdate: vi.fn(() => Promise.resolve(true)),
    onTaskCreate: vi.fn((task: Partial<Task>) => Promise.resolve(makeTask(task.id ?? 100, task))),
    onTaskDelete: vi.fn(() => Promise.resolve(true)),
    onLinkCreate: vi.fn(() => Promise.resolve(makeLink(500, 2, 3))),
    onLinkUpdate: vi.fn(),
    onLinkDelete: vi.fn(),
  };
  serverTasks = [
    makeTask(1, { text: 'Project', kind_task: 2 }),
    makeTask(2, { parent: 1, sortorder: 0 }),
    makeTask(3, { parent: 1, sortorder: 1 }),
    makeTask(4, { parent: 1, sortorder: 2 }),
  ];
  syncGanttData(serverTasks, [], state);
  detach = attach();
});

afterEach(() => {
  detach();
  teardown();
  vi.clearAllMocks();
});

function editTask(id: number, fields: Record<string, unknown>) {
  Object.assign(gantt.getTask(id), fields);
  gantt.updateTask(id);
}

describe('タスクの更新', () => {
  it('1回の更新で保存を1回だけ呼び、日付を文字列にした内容を送ること', () => {
    editTask(2, { progress: 0.5, start_date: new Date(2026, 2, 11), end_date: new Date(2026, 2, 14) });

    expect(callbacks.onTaskUpdate).toHaveBeenCalledTimes(1);
    expect(callbacks.onTaskUpdate).toHaveBeenCalledWith(2, expect.objectContaining({
      text: 'Task 2',
      progress: 0.5,
      start_date: '2026-03-11 00:00:00',
      end_date: '2026-03-14 00:00:00',
      parent: 1,
      is_pinned: false,
    }));
  });

  it('編集日の履歴に今日を1度だけ追記して保存すること', () => {
    const today = formatEditDate(new Date());

    editTask(2, { edit_date: '2020-1-1' });
    editTask(2, { memo: 'again' });

    expect(gantt.getTask(2).edit_date).toBe(`2020-1-1,${today}`);
    expect(callbacks.onTaskUpdate).toHaveBeenLastCalledWith(2, expect.objectContaining({
      edit_date: `2020-1-1,${today}`,
    }));
  });

  it('タスク名の先頭のインデントとアイコンを除き、その他の絵文字は壊さないこと', () => {
    editTask(2, { text: '\u3000📄 📊 レポート' });

    expect(gantt.getTask(2).text).toBe('📊 レポート');
    expect(callbacks.onTaskUpdate).toHaveBeenCalledWith(2, expect.objectContaining({ text: '📊 レポート' }));
  });

  it('保存の応答待ちの間は「保存中」として記録し、完了したら解除して再同期を依頼すること', async () => {
    editTask(2, { progress: 0.5 });
    editTask(2, { progress: 0.75 });
    expect(state.pendingSaves.get(2)).toBe(2);

    await flushPromises();

    expect(state.pendingSaves.has(2)).toBe(false);
    expect(requestSync).toHaveBeenCalledTimes(2);
  });

  it('保存に失敗したら、次の同期でサーバーの値に戻ること', async () => {
    vi.mocked(callbacks.onTaskUpdate).mockResolvedValueOnce(false);
    requestSync.mockImplementation(() => syncGanttData(serverTasks, [], state));

    editTask(2, { text: 'Edit that fails to save' });
    await flushPromises();

    expect(gantt.getTask(2).text).toBe('Task 2');
  });
});

describe('ハンドラの解除（画面切り替え時の多重登録の防止）', () => {
  it('解除後は保存を呼ばないこと', () => {
    detach();

    editTask(2, { progress: 0.5 });
    gantt.deleteTask(3);

    expect(callbacks.onTaskUpdate).not.toHaveBeenCalled();
    expect(callbacks.onTaskDelete).not.toHaveBeenCalled();
  });

  it('登録と解除を繰り返しても、更新・削除・リンク作成がそれぞれ1回だけ保存されること', async () => {
    // ガント画面とグリッド画面を行き来する（マウントとアンマウントを繰り返す）のに相当
    for (let i = 0; i < 3; i++) {
      detach();
      detach = attach();
    }

    editTask(2, { progress: 0.5 });
    gantt.addLink({ id: 'temp-link', source: 2, target: 3, type: '0' });
    gantt.deleteTask(4);
    await flushPromises();

    expect(callbacks.onTaskUpdate).toHaveBeenCalledTimes(1);
    expect(callbacks.onLinkCreate).toHaveBeenCalledTimes(1);
    expect(callbacks.onTaskDelete).toHaveBeenCalledTimes(1);
  });
});

describe('タスクの削除', () => {
  it('削除をバックエンドへ伝え、応答待ちの間は「削除中」として記録すること', async () => {
    gantt.deleteTask(3);

    expect(callbacks.onTaskDelete).toHaveBeenCalledWith(3);
    expect(state.pendingDeletes.has(3)).toBe(true);

    await flushPromises();
    expect(requestSync).toHaveBeenCalled();
  });

  it('削除に失敗したら、次の同期でタスクが復元されること', async () => {
    vi.mocked(callbacks.onTaskDelete).mockResolvedValueOnce(false);
    requestSync.mockImplementation(() => syncGanttData(serverTasks, [], state));

    gantt.deleteTask(3);
    expect(gantt.isTaskExists(3)).toBe(false);
    await flushPromises();

    expect(childIds(1)).toEqual([2, 3, 4]);
  });

  it('同期処理による削除ではバックエンドを呼ばないこと', () => {
    syncGanttData(serverTasks.filter((task) => task.id !== 3), [], state);

    expect(gantt.isTaskExists(3)).toBe(false);
    expect(callbacks.onTaskDelete).not.toHaveBeenCalled();
  });
});

describe('Undo/Redo', () => {
  it('更新のUndoは、元の値を1回だけ保存すること', async () => {
    editTask(2, { progress: 0.5 });
    await waitForUndoBatch();
    vi.mocked(callbacks.onTaskUpdate).mockClear();

    gantt.undo();

    expect(gantt.getTask(2).progress).toBe(0);
    expect(callbacks.onTaskUpdate).toHaveBeenCalledTimes(1);
    expect(callbacks.onTaskUpdate).toHaveBeenCalledWith(2, expect.objectContaining({ progress: 0 }));
  });

  it('削除のUndoで復活したタスクを、同じIDのままバックエンドに作り直すこと', async () => {
    gantt.deleteTask(3);
    await waitForUndoBatch();

    gantt.undo();
    expect(gantt.isTaskExists(3)).toBe(true);
    expect(state.pendingTaskAdds.has('3')).toBe(true);
    await flushPromises();

    expect(callbacks.onTaskCreate).toHaveBeenCalledTimes(1);
    expect(callbacks.onTaskCreate).toHaveBeenCalledWith(expect.objectContaining({
      id: 3,
      text: 'Task 3',
      parent: 1,
      start_date: '2026-03-10 00:00:00',
    }));
    expect(state.pendingDeletes.has(3)).toBe(false);
  });

  it('作り直した直後に古い一覧で同期されても、復活したタスクを消さないこと', async () => {
    // 作成APIの応答直後は、画面側のデータ（React の state）がまだ古いことがある
    const staleTasks = serverTasks.filter((task) => task.id !== 3);
    requestSync.mockImplementation(() => syncGanttData(staleTasks, [], state));
    gantt.deleteTask(3);
    await waitForUndoBatch();
    await flushPromises();

    gantt.undo();
    await flushPromises();

    expect(callbacks.onTaskCreate).toHaveBeenCalledTimes(1);
    expect(gantt.isTaskExists(3)).toBe(true);

    syncGanttData(serverTasks, [], state);
    expect(state.pendingTaskAdds.size).toBe(0);
  });

  it('作り直しに失敗したら、復活したタスクを取り除くこと', async () => {
    const staleTasks = serverTasks.filter((task) => task.id !== 3);
    requestSync.mockImplementation(() => syncGanttData(staleTasks, [], state));
    vi.mocked(callbacks.onTaskCreate).mockResolvedValueOnce(undefined);
    gantt.deleteTask(3);
    await waitForUndoBatch();
    await flushPromises();

    gantt.undo();
    await flushPromises();

    expect(gantt.isTaskExists(3)).toBe(false);
  });

  it('プロジェクトの削除をUndoしたら、子タスクもまとめて作り直すこと', async () => {
    gantt.deleteTask(1);
    await waitForUndoBatch();

    gantt.undo();
    await flushPromises();

    const recreatedIds = vi.mocked(callbacks.onTaskCreate).mock.calls.map(([task]) => task.id);
    expect(recreatedIds.sort()).toEqual([1, 2, 3, 4]);
  });

  it('削除の応答が返る前にUndoしても、削除の完了を待ってから作り直すこと', async () => {
    const order: string[] = [];
    let finishDelete: (deleted: boolean) => void = () => {};
    vi.mocked(callbacks.onTaskDelete).mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishDelete = (deleted) => {
        order.push('delete finished');
        resolve(deleted);
      };
    }));
    vi.mocked(callbacks.onTaskCreate).mockImplementationOnce((task) => {
      order.push('create started');
      return Promise.resolve(makeTask(task.id ?? 0, task));
    });

    gantt.deleteTask(3);
    await waitForUndoBatch();
    gantt.undo();
    await flushPromises();
    expect(callbacks.onTaskCreate).not.toHaveBeenCalled();

    finishDelete(true);
    await flushPromises();

    expect(order).toEqual(['delete finished', 'create started']);
  });

  it('追加のUndoは削除として保存し、Redoで作り直すこと', async () => {
    gantt.addTask({ id: 9, text: 'Added', start_date: new Date(2026, 2, 10), duration: 1, parent: 1 }, 1);
    await waitForUndoBatch();

    gantt.undo();
    expect(callbacks.onTaskDelete).toHaveBeenCalledWith(9);
    await flushPromises();

    gantt.redo();
    await flushPromises();
    expect(callbacks.onTaskCreate).toHaveBeenCalledWith(expect.objectContaining({ id: 9, text: 'Added' }));
  });
});

describe('リンク', () => {
  it('作成したリンクをバックエンドに保存し、採番されたIDへ付け替えること', async () => {
    gantt.addLink({ id: 'temp-link', source: 2, target: 3, type: '0' });
    expect(state.pendingLinkAdds.has('temp-link')).toBe(true);

    await flushPromises();

    expect(callbacks.onLinkCreate).toHaveBeenCalledWith({ source: 2, target: 3, type: 0 });
    expect(gantt.isLinkExists(500)).toBe(true);
    expect(gantt.isLinkExists('temp-link')).toBe(false);
  });

  it('作成直後に古い一覧で同期されてもリンクを消さず、作成に失敗したら取り除くこと', async () => {
    requestSync.mockImplementation(() => syncGanttData(serverTasks, [], state));

    gantt.addLink({ id: 'temp-link', source: 2, target: 3, type: '0' });
    await flushPromises();
    expect(gantt.isLinkExists(500)).toBe(true);

    vi.mocked(callbacks.onLinkCreate).mockResolvedValueOnce(undefined);
    gantt.addLink({ id: 'temp-link-2', source: 3, target: 4, type: '0' });
    await flushPromises();
    expect(gantt.isLinkExists('temp-link-2')).toBe(false);
  });

  it('更新と削除をバックエンドへ伝えること', () => {
    syncGanttData(serverTasks, [makeLink(10, 2, 3)], state);

    gantt.getLink(10).target = 4;
    gantt.updateLink(10);
    gantt.deleteLink(10);

    expect(callbacks.onLinkUpdate).toHaveBeenCalledWith(10, { source: 2, target: 4, type: 0 });
    expect(callbacks.onLinkDelete).toHaveBeenCalledWith(10);
  });

  it('同期処理によるリンクの追加・削除ではバックエンドを呼ばないこと', () => {
    syncGanttData(serverTasks, [makeLink(10, 2, 3)], state);
    gantt.render();
    syncGanttData(serverTasks, [], state);

    expect(callbacks.onLinkCreate).not.toHaveBeenCalled();
    expect(callbacks.onLinkDelete).not.toHaveBeenCalled();
  });
});

describe('並び替え', () => {
  it('移動先の親に属する全タスクの並び順をまとめて保存すること', () => {
    gantt.moveTask(4, 0, 1);

    expect(childIds(1)).toEqual([4, 2, 3]);
    expect(reorderTasks).toHaveBeenCalledWith({
      items: [
        { id: 4, sortorder: 0, parent: 1 },
        { id: 2, sortorder: 1, parent: 1 },
        { id: 3, sortorder: 2, parent: 1 },
      ],
    });
  });
});

describe('画面側への通知', () => {
  it('タスクの選択と右クリックを通知すること', () => {
    detach();
    const onTaskSelected = vi.fn();
    const onContextMenu = vi.fn();
    detach = attach({ onTaskSelected, onContextMenu });
    const event = new MouseEvent('contextmenu', { cancelable: true });

    gantt.selectTask(2);
    gantt.callEvent('onContextMenu', [2, null, event]);

    expect(onTaskSelected).toHaveBeenCalledWith(2);
    expect(onContextMenu).toHaveBeenCalledWith(2, event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Lightboxを開く前に階層パスをタスクへ設定すること', () => {
    gantt.callEvent('onBeforeLightbox', [3]);

    expect(gantt.getTask(3).hierarchy_path).toBe('[1]Project &gt; [3]Task 3');
  });
});
