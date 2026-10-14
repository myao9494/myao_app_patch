/**
 * @vitest-environment jsdom
 * サーバーのデータを gantt へ差分反映する処理（ganttSync）のテスト
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gantt } from 'dhtmlx-gantt';
import type { Link, Task } from '../../../types/gantt';
import {
  confirmPendingAdd,
  createGanttSyncState,
  protectPendingAdd,
  syncGanttData,
  type GanttSyncState,
} from '../ganttSync';
import { childIds, makeLink, makeTask, setupGantt, waitForUndoBatch } from './ganttTestHarness';

let teardown: () => void;
let state: GanttSyncState;

/** プロジェクト(1) の下に タスク 2, 3, 4 が並ぶ初期データ */
function initialTasks(): Task[] {
  return [
    makeTask(1, { text: 'Project', kind_task: 2 }),
    makeTask(2, { parent: 1, sortorder: 0 }),
    makeTask(3, { parent: 1, sortorder: 1 }),
    makeTask(4, { parent: 1, sortorder: 2 }),
  ];
}

function replaceTask(tasks: Task[], id: number, changes: Partial<Task>): Task[] {
  return tasks.map((task) => (task.id === id ? { ...task, ...changes } : task));
}

function sync(tasks: Task[], links: Link[] = []): boolean {
  return syncGanttData(tasks, links, state);
}

beforeEach(() => {
  teardown = setupGantt();
  state = createGanttSyncState();
});

afterEach(() => {
  teardown();
  vi.restoreAllMocks();
});

describe('初回ロード', () => {
  it('階層と並び順を保って読み込み、すべて開いた状態にすること', () => {
    const changed = sync(initialTasks(), [makeLink(10, 2, 3)]);

    expect(changed).toBe(true);
    expect(childIds(0)).toEqual([1]);
    expect(childIds(1)).toEqual([2, 3, 4]);
    expect(gantt.getTask(1).$open).toBe(true);
    expect(gantt.getTask(2).start_date).toEqual(new Date(2026, 2, 10));
    expect(gantt.getLinks().map((link) => [link.id, link.source, link.target, link.type])).toEqual([
      [10, 2, 3, '0'],
    ]);
  });

  it('データが空なら何もしないこと', () => {
    expect(sync([])).toBe(false);
    expect(gantt.getTaskCount()).toBe(0);
  });
});

describe('差分反映', () => {
  it('内容が変わっていなければ gantt に触れないこと', () => {
    sync(initialTasks());
    const updateTask = vi.spyOn(gantt, 'updateTask');

    // 再取得で配列やオブジェクトが作り直されても、内容が同じなら変更なしと判定する
    const changed = sync(initialTasks());

    expect(changed).toBe(false);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('サーバー側で変わったタスクだけを更新し、開閉状態は保つこと', () => {
    const tasks = initialTasks();
    sync(tasks);
    gantt.close(1);
    const updateTask = vi.spyOn(gantt, 'updateTask');

    const changed = sync(replaceTask(replaceTask(tasks, 1, { text: 'Renamed' }), 3, { progress: 0.5 }));

    expect(changed).toBe(true);
    expect(updateTask.mock.calls.map(([id]) => id)).toEqual([1, 3]);
    expect(gantt.getTask(1).text).toBe('Renamed');
    expect(gantt.getTask(1).$open).toBe(false);
    expect(gantt.getTask(3).progress).toBe(0.5);
  });

  it('画面上で編集済みで応答待ちのタスクを、古い再取得結果で巻き戻さないこと', () => {
    const tasks = initialTasks();
    sync(tasks);
    gantt.getTask(2).text = 'Edited locally';

    // 保存の応答が届く前に、別の要因（ポーリング等）で編集前のデータが届いた
    sync(initialTasks());

    expect(gantt.getTask(2).text).toBe('Edited locally');
  });

  it('保存中のタスクはサーバーの値で上書きせず、保存完了後に反映すること', () => {
    const tasks = initialTasks();
    sync(tasks);
    gantt.getTask(2).text = 'Second edit';
    state.pendingSaves.set(2, 1);
    const firstSaveResponse = replaceTask(tasks, 2, { text: 'First edit' });

    sync(firstSaveResponse);
    expect(gantt.getTask(2).text).toBe('Second edit');

    state.pendingSaves.delete(2);
    sync(replaceTask(tasks, 2, { text: 'Second edit', edit_date: '2026-03-18' }));
    expect(gantt.getTask(2).edit_date).toBe('2026-03-18');
  });

  it('保存に失敗したタスク（前回反映の記録を消したもの）は、サーバーの値へ戻すこと', () => {
    const tasks = initialTasks();
    sync(tasks);
    gantt.getTask(2).text = 'Edit that failed to save';

    state.lastSynced.delete(2);
    const changed = sync(tasks);

    expect(changed).toBe(true);
    expect(gantt.getTask(2).text).toBe('Task 2');
  });
});

describe('タスクの追加と削除', () => {
  it('サーバーから消えたタスクを、削除APIを呼ばせずに gantt から取り除くこと', () => {
    const tasks = initialTasks();
    sync(tasks);
    const syncingFlagsDuringDelete: boolean[] = [];
    const eventId = gantt.attachEvent('onBeforeTaskDelete', () => {
      syncingFlagsDuringDelete.push(state.isSyncing);
      return true;
    });

    sync(tasks.filter((task) => task.id !== 3));
    gantt.detachEvent(eventId);

    expect(childIds(1)).toEqual([2, 4]);
    // イベント自体を抑止しているか、発火しても同期中と分かる状態であること
    expect(syncingFlagsDuringDelete.every(Boolean)).toBe(true);
    expect(state.isSyncing).toBe(false);
  });

  it('他の画面で追加されたタスクを、並び順どおりの位置に挿入すること', () => {
    const tasks = initialTasks();
    sync(tasks);

    // タスク2を複製 → 直後に 5 が入り、後続の並び順が1つずつ繰り下がる
    sync([
      tasks[0],
      tasks[1],
      makeTask(5, { parent: 1, sortorder: 1 }),
      { ...tasks[2], sortorder: 2 },
      { ...tasks[3], sortorder: 3 },
    ]);

    expect(childIds(1)).toEqual([2, 5, 3, 4]);
    expect(gantt.getTask(3).sortorder).toBe(2);
  });

  it('画面上で削除して応答待ちのタスクと、その子孫を復活させないこと', () => {
    const tasks = initialTasks();
    sync(tasks);
    gantt.silent(() => gantt.deleteTask(1));
    state.pendingDeletes.add(1);

    sync(tasks);

    expect(gantt.getTaskCount()).toBe(0);
  });

  it('削除が完了したら応答待ちの記録を消し、削除に失敗した場合は復元すること', () => {
    const tasks = initialTasks();
    sync(tasks);
    gantt.silent(() => gantt.deleteTask(4));
    state.pendingDeletes.add(4);

    sync(tasks.filter((task) => task.id !== 4));
    expect(state.pendingDeletes.has(4)).toBe(false);

    // 別のタスクの削除に失敗した場合: 呼び出し側が応答待ちから外すと、次の同期で復元される
    gantt.silent(() => gantt.deleteTask(3));
    sync(tasks.filter((task) => task.id !== 4));
    expect(childIds(1)).toEqual([2, 3]);
  });

  it('追加したタスクが行として表示され、gantt内部の件数とも一致すること', () => {
    // silent で追加すると DHTMLX の並び順キャッシュが更新されず、行が表示されない不具合があった
    const tasks = initialTasks();
    sync(tasks);

    sync([...tasks, makeTask(5, { kind_task: 2, sortorder: 1 }), makeTask(6, { parent: 5 })]);
    gantt.render();

    expect(gantt.getTaskCount()).toBe(6);
    expect(gantt.getGlobalTaskIndex(6)).toBe(5);
    expect(gantt.getTaskByIndex(5).id).toBe(6);
  });

  it('子が親より先に並んだデータでも、親から順に追加すること', () => {
    sync(initialTasks());

    // 並びは (親ID, 並び順) の昇順。親(20)のIDが子の親ID(20)より後ろの行に来る
    sync([...initialTasks(), makeTask(21, { parent: 20 }), makeTask(20, { parent: 30 }), makeTask(30, { sortorder: 9 })]);

    expect(childIds(0)).toEqual([1, 30]);
    expect(childIds(30)).toEqual([20]);
    expect(childIds(20)).toEqual([21]);
  });

  it('大量のタスクが一度に増えた場合は全体を読み込み直し、閉じていたプロジェクトは閉じたままにすること', () => {
    const tasks = initialTasks();
    sync(tasks);
    gantt.close(1);
    const imported = Array.from({ length: 60 }, (_, index) => makeTask(100 + index, { sortorder: index + 1 }));

    const changed = sync([...tasks, ...imported]);

    expect(changed).toBe(true);
    expect(gantt.getTaskCount()).toBe(64);
    expect(gantt.getTask(1).$open).toBe(false);
    expect(sync([...tasks, ...imported])).toBe(false);
  });

  describe('作成APIの応答待ちで gantt 上にだけあるタスク（Undoでの復活）', () => {
    function restoreLocally(tasks: Task[]) {
      sync(tasks);
      gantt.silent(() => gantt.deleteTask(4));
      sync(tasks.filter((task) => task.id !== 4));
      gantt.addTask({ id: 4, text: 'Restored by undo', start_date: new Date(2026, 2, 10), duration: 1 }, 1);
    }

    it('応答待ちの間は消さないこと', () => {
      const tasks = initialTasks();
      restoreLocally(tasks);
      protectPendingAdd(state.pendingTaskAdds, 4);

      sync(tasks.filter((task) => task.id !== 4));

      expect(gantt.isTaskExists(4)).toBe(true);
    });

    it('作成に成功した直後、まだ古いデータで同期されても消さないこと', () => {
      const tasks = initialTasks();
      restoreLocally(tasks);
      protectPendingAdd(state.pendingTaskAdds, 4);
      confirmPendingAdd(state.pendingTaskAdds, 4);

      // 作成後の再取得結果が画面に届く前の、古い一覧（タスク4を含まない）での同期
      sync(tasks.filter((task) => task.id !== 4));
      expect(gantt.isTaskExists(4)).toBe(true);

      // 新しい一覧が届いたら保護を解除する
      sync(tasks);
      expect(state.pendingTaskAdds.size).toBe(0);
      expect(gantt.getTask(4).text).toBe('Task 4');
    });

    it('作成に成功してもサーバーの一覧に現れないままなら、一定時間後に保護を解除して消すこと', () => {
      vi.useFakeTimers();
      try {
        const tasks = initialTasks();
        restoreLocally(tasks);
        confirmPendingAdd(state.pendingTaskAdds, 4);

        vi.advanceTimersByTime(11_000);
        sync(tasks.filter((task) => task.id !== 4));

        expect(gantt.isTaskExists(4)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('作成に失敗して保護が外されたら、次の同期で消すこと', () => {
      const tasks = initialTasks();
      restoreLocally(tasks);

      sync(tasks.filter((task) => task.id !== 4));

      expect(gantt.isTaskExists(4)).toBe(false);
    });
  });
});

describe('リンク', () => {
  it('追加・変更・削除を反映し、変更が無ければ触れないこと', () => {
    const tasks = initialTasks();
    sync(tasks, [makeLink(10, 2, 3), makeLink(11, 3, 4)]);

    expect(sync(tasks, [makeLink(10, 2, 3), makeLink(11, 3, 4)])).toBe(false);

    const changed = sync(tasks, [makeLink(10, 2, 4, 1), makeLink(12, 2, 3)]);

    expect(changed).toBe(true);
    gantt.render(); // 変更があった場合、呼び出し側（GanttChart）が再描画する。リンク一覧はそこで更新される
    const links = gantt.getLinks().map((link) => [Number(link.id), Number(link.source), Number(link.target), String(link.type)]);
    expect(links.sort()).toEqual([[10, 2, 4, '1'], [12, 2, 3, '0']]);
  });

  it('作成APIの応答待ちのリンクを消さないこと', () => {
    const tasks = initialTasks();
    sync(tasks);
    gantt.silent(() => gantt.addLink({ id: 'temp-1', source: 2, target: 3, type: '0' }));
    protectPendingAdd(state.pendingLinkAdds, 'temp-1');

    sync(tasks);

    expect(gantt.isLinkExists('temp-1')).toBe(true);
  });
});

describe('Undo/Redoの履歴', () => {
  it('同期による変更を履歴に積まず、ユーザー操作の履歴を保つこと', async () => {
    const tasks = initialTasks();
    sync(tasks);
    gantt.getTask(2).text = 'User edit';
    gantt.updateTask(2);
    await waitForUndoBatch();
    const undoStackBefore = gantt.getUndoStack().length;
    expect(undoStackBefore).toBeGreaterThan(0);

    sync([
      ...replaceTask(tasks, 3, { text: 'Changed elsewhere' }).filter((task) => task.id !== 4),
      makeTask(5, { parent: 1, sortorder: 5 }),
    ]);
    await waitForUndoBatch();

    expect(gantt.getUndoStack()).toHaveLength(undoStackBefore);
    gantt.undo();
    expect(gantt.getTask(2).text).toBe('Task 2');
    expect(gantt.getTask(3).text).toBe('Changed elsewhere');
  });
});
