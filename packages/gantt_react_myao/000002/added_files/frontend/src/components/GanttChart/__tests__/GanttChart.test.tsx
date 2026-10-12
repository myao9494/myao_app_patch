/**
 * @vitest-environment jsdom
 * GanttChart コンポーネントを実際にマウントして検証するテスト
 * （gantt の初期化・破棄と、props のデータを gantt へ反映する部分）
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { gantt } from 'dhtmlx-gantt';
import type { Link, Task } from '../../../types/gantt';
import { GanttChart } from '../GanttChart';
import { childIds, flushPromises, makeLink, makeTask } from './ganttTestHarness';

vi.mock('../../../services/api', () => ({
  reorderTasks: vi.fn(() => Promise.resolve({ success: true })),
  createObsidianNote: vi.fn(),
  resolveTaskLink: vi.fn(),
}));

const callbacks = {
  onTaskUpdate: vi.fn(() => Promise.resolve(true)),
  onTaskCreate: vi.fn(() => Promise.resolve(undefined)),
  onTaskDelete: vi.fn(() => Promise.resolve(true)),
  onLinkCreate: vi.fn(() => Promise.resolve(undefined)),
};

function tasksFixture(): Task[] {
  return [
    makeTask(1, { text: 'Project', kind_task: 2 }),
    makeTask(2, { parent: 1, sortorder: 0 }),
    makeTask(3, { parent: 1, sortorder: 1, progress: 1 }),
  ];
}

function chart(tasks: Task[], links: Link[] = [], extraProps: Partial<Parameters<typeof GanttChart>[0]> = {}) {
  return (
    <GanttChart
      tasks={tasks}
      links={links}
      timeScale="month"
      gridWidth={380}
      obsidianHome=""
      {...callbacks}
      {...extraProps}
    />
  );
}

function editTask(id: number, fields: Record<string, unknown>) {
  Object.assign(gantt.getTask(id), fields);
  gantt.updateTask(id);
}

beforeEach(() => {
  // jsdom には無いブラウザAPI
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('データの表示', () => {
  it('props のタスクとリンクを gantt に読み込むこと', () => {
    render(chart(tasksFixture(), [makeLink(10, 2, 3)]));

    expect(childIds(0)).toEqual([1]);
    expect(childIds(1)).toEqual([2, 3]);
    expect(gantt.isLinkExists(10)).toBe(true);
  });

  it('props が変わったら差分だけを gantt に反映すること', () => {
    const tasks = tasksFixture();
    const { rerender } = render(chart(tasks));
    const updateTask = vi.spyOn(gantt, 'updateTask');

    rerender(chart([...tasks.slice(0, 2), { ...tasks[2], text: 'Renamed' }, makeTask(4, { parent: 1, sortorder: 2 })]));

    expect(gantt.getTask(3).text).toBe('Renamed');
    expect(childIds(1)).toEqual([2, 3, 4]);
    expect(updateTask.mock.calls.map(([id]) => id)).toEqual([3]);
    // 同期による変更は保存し直さない
    expect(callbacks.onTaskUpdate).not.toHaveBeenCalled();
  });

  it('フィルターに合わないタスクを非表示にし、条件に合う子を持つ親は残すこと', async () => {
    const filter = { showCompleted: false, showType: 'all' as const, periodMode: 'all' as const, searchText: 'Task 2' };
    render(chart(tasksFixture(), [], { filter }));
    await flushPromises();

    const visibleIds: number[] = [];
    gantt.eachTask((task) => {
      if (gantt.callEvent('onBeforeTaskDisplay', [task.id, task])) visibleIds.push(Number(task.id));
    });
    expect(visibleIds).toEqual([1, 2]);
  });
});

describe('gantt の初期化と破棄', () => {
  it('アンマウントで gantt のデータを消すこと', () => {
    const { unmount } = render(chart(tasksFixture()));

    unmount();

    expect(gantt.getTaskCount()).toBe(0);
  });

  it('画面を切り替えて戻っても（再マウントしても）、保存が多重に呼ばれないこと', () => {
    // ガント画面 ⇔ グリッド画面の行き来に相当。以前は戻るたびにイベントハンドラが増えていた
    for (let i = 0; i < 3; i++) {
      render(chart(tasksFixture())).unmount();
    }
    render(chart(tasksFixture()));

    editTask(2, { progress: 0.5 });
    gantt.deleteTask(3);

    expect(callbacks.onTaskUpdate).toHaveBeenCalledTimes(1);
    expect(callbacks.onTaskDelete).toHaveBeenCalledTimes(1);
  });

  it('再マウント後も、最新の props のデータが読み込まれること', () => {
    render(chart(tasksFixture())).unmount();

    render(chart([makeTask(7), makeTask(8, { sortorder: 1 })]));

    expect(childIds(0)).toEqual([7, 8]);
  });

  it('StrictMode（開発時の二重マウント）でも正しく初期化され、保存が1回だけ呼ばれること', () => {
    render(<StrictMode>{chart(tasksFixture())}</StrictMode>);

    expect(childIds(1)).toEqual([2, 3]);
    editTask(2, { progress: 0.5 });
    expect(callbacks.onTaskUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('保存の失敗', () => {
  it('保存に失敗したタスクは、サーバーの値の表示に戻すこと', async () => {
    callbacks.onTaskUpdate.mockResolvedValueOnce(false);
    render(chart(tasksFixture()));

    editTask(2, { text: 'Edit that fails to save' });
    await flushPromises();

    expect(gantt.getTask(2).text).toBe('Task 2');
  });
});

describe('外部からの入力画面オープン要求', () => {
  it('対象タスクを選択して編集画面を開き、処理済みを通知すること', () => {
    const showLightbox = vi.spyOn(gantt, 'showLightbox').mockImplementation(() => {});
    const onExternalOpenHandled = vi.fn();

    render(chart(tasksFixture(), [], {
      externalOpenTaskRequest: { requestId: 42, taskId: 3, attempt: 1 },
      onExternalOpenHandled,
    }));

    expect(showLightbox).toHaveBeenCalledWith(3);
    expect(gantt.getSelectedTasks().map(Number)).toEqual([3]);
    expect(onExternalOpenHandled).toHaveBeenCalledWith(42);
  });

  it('対象タスクがまだ読み込まれていなければ、読み込まれた時点で開くこと', () => {
    const showLightbox = vi.spyOn(gantt, 'showLightbox').mockImplementation(() => {});
    const onExternalOpenHandled = vi.fn();
    const request = { externalOpenTaskRequest: { requestId: 42, taskId: 9, attempt: 1 }, onExternalOpenHandled };
    const { rerender } = render(chart(tasksFixture(), [], request));
    expect(onExternalOpenHandled).not.toHaveBeenCalled();

    rerender(chart([...tasksFixture(), makeTask(9, { sortorder: 5 })], [], request));

    expect(showLightbox).toHaveBeenCalledWith(9);
    expect(onExternalOpenHandled).toHaveBeenCalledTimes(1);
  });
});
