/**
 * @vitest-environment jsdom
 * タスク・リンクのデータ管理フック（useGanttData）のテスト。APIはモックする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import * as api from '../../services/api';
import type { Link, Task } from '../../types/gantt';
import { useGanttData } from '../useGanttData';

vi.mock('../../services/api');

const POLL_INTERVAL_MS = 2000;

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

/** バックエンドの状態（モック） */
let server: { tasks: Task[]; links: Link[]; sequence: number; online: boolean };
/** フックが api.observeMutationSequence に登録したリスナー（変更系APIの応答をテストから再現する） */
let notifyMutationSequence: (sequence: number) => void;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  server = { tasks: [makeTask(1), makeTask(2)], links: [], sequence: 5, online: true };

  notifyMutationSequence = () => {};
  vi.mocked(api.observeMutationSequence).mockImplementation((listener) => {
    notifyMutationSequence = listener;
    return () => {};
  });
  vi.mocked(api.getGanttUpdateSequence).mockImplementation(async () =>
    server.online ? { success: true, data: { sequence: server.sequence } } : { success: false, error: 'offline' }
  );
  vi.mocked(api.getTasks).mockImplementation(async () =>
    server.online
      ? { success: true, data: { tasks: server.tasks, links: server.links } }
      : { success: false, error: 'Network Error' }
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

async function renderLoaded() {
  const rendered = renderHook(() => useGanttData());
  await waitFor(() => expect(rendered.result.current.loading).toBe(false));
  return rendered;
}

async function advancePoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  });
}

describe('初回取得', () => {
  it('タスクとリンクを取得して読み込み完了にすること', async () => {
    const { result } = await renderLoaded();

    expect(result.current.tasks.map((task) => task.id)).toEqual([1, 2]);
    expect(result.current.error).toBeNull();
  });

  it('取得に失敗したらエラーを出し、バックエンドが復帰したら自動で取り直すこと', async () => {
    server.online = false;
    const { result } = await renderLoaded();
    expect(result.current.error).toBe('Network Error');
    expect(result.current.tasks).toEqual([]);

    server.online = true;
    await advancePoll();

    expect(result.current.tasks.map((task) => task.id)).toEqual([1, 2]);
    expect(result.current.error).toBeNull();
  });
});

describe('自動更新（更新シーケンスのポーリング）', () => {
  it('シーケンスが変わらなければ取り直さないこと', async () => {
    await renderLoaded();
    vi.mocked(api.getTasks).mockClear();

    await advancePoll();
    await advancePoll();

    expect(api.getTasks).not.toHaveBeenCalled();
  });

  it('他のタブやランチャーからの変更でシーケンスが進んだら取り直すこと', async () => {
    const { result } = await renderLoaded();

    server.tasks = [...server.tasks, makeTask(3)];
    server.sequence = 6;
    await advancePoll();

    expect(result.current.tasks.map((task) => task.id)).toEqual([1, 2, 3]);
  });

  it('バックエンドの再起動でシーケンスが小さい値に戻っても、変更として取り直すこと', async () => {
    const { result } = await renderLoaded();

    server.tasks = [makeTask(1)];
    server.sequence = 0;
    await advancePoll();

    expect(result.current.tasks.map((task) => task.id)).toEqual([1]);

    // 取り直した後は、新しいシーケンスを基準にする
    vi.mocked(api.getTasks).mockClear();
    await advancePoll();
    expect(api.getTasks).not.toHaveBeenCalled();
  });

  it('取り直しに失敗しても、表示中のデータは消さないこと', async () => {
    const { result } = await renderLoaded();

    server.sequence = 6;
    vi.mocked(api.getTasks).mockResolvedValueOnce({ success: false, error: 'Network Error' });
    await advancePoll();

    expect(result.current.error).toBe('Network Error');
    expect(result.current.tasks.map((task) => task.id)).toEqual([1, 2]);

    await advancePoll();
    expect(result.current.error).toBeNull();
  });

  it('取得中に別の更新が入っても、次のポーリングで取り直せること', async () => {
    const { result } = await renderLoaded();

    // シーケンス 6 を読んだ直後・タスク取得の前に、もう1件更新（シーケンス 7）が入る
    server.sequence = 6;
    vi.mocked(api.getTasks).mockImplementationOnce(async () => {
      const snapshot = { tasks: [...server.tasks, makeTask(3)], links: [] };
      server.tasks = [...snapshot.tasks, makeTask(4)];
      server.sequence = 7;
      return { success: true, data: snapshot };
    });
    await advancePoll();
    expect(result.current.tasks.map((task) => task.id)).toEqual([1, 2, 3]);

    await advancePoll();
    expect(result.current.tasks.map((task) => task.id)).toEqual([1, 2, 3, 4]);
  });
});

describe('自分の変更による再取得の省略', () => {
  it('自分の変更でシーケンスが1つだけ進んだ場合は、取り直さないこと', async () => {
    await renderLoaded();
    vi.mocked(api.getTasks).mockClear();

    server.sequence = 6;
    act(() => notifyMutationSequence(6));
    await advancePoll();

    expect(api.getTasks).not.toHaveBeenCalled();
  });

  it('自分の変更の間に他の変更も入っていた場合は、取り直すこと', async () => {
    const { result } = await renderLoaded();

    server.tasks = [...server.tasks, makeTask(3)];
    server.sequence = 7;
    act(() => notifyMutationSequence(7));
    await advancePoll();

    expect(result.current.tasks.map((task) => task.id)).toEqual([1, 2, 3]);
  });

  it('最初の取得が終わる前の通知は無視すること', async () => {
    vi.mocked(api.getTasks).mockImplementation(() => new Promise(() => {}));
    renderHook(() => useGanttData());

    expect(() => act(() => notifyMutationSequence(1))).not.toThrow();
  });
});

describe('リンクの保存', () => {
  it('作成に失敗したらエラーを出し、リンクを増やさないこと', async () => {
    const { result } = await renderLoaded();
    vi.mocked(api.createLink).mockResolvedValue({ success: false, error: 'boom' });

    let created: Link | undefined;
    await act(async () => {
      created = await result.current.createLink({ source: 1, target: 2, type: 0 });
    });

    expect(created).toBeUndefined();
    expect(result.current.links).toEqual([]);
    expect(result.current.error).toBe('リンクの作成に失敗しました: boom');
  });

  it('更新に失敗したら、リンクを変えずにエラーを出すこと', async () => {
    server.links = [{ id: 1, source: 1, target: 2, type: 0 }];
    const { result } = await renderLoaded();
    vi.mocked(api.updateLink).mockResolvedValue({ success: false, error: 'boom' });

    await act(async () => {
      await result.current.updateLink(1, { type: 2 });
    });

    expect(result.current.links[0].type).toBe(0);
    expect(result.current.error).toBe('リンクの更新に失敗しました: boom');
  });

  it('削除に失敗したら、リンクを残してエラーを出すこと', async () => {
    server.links = [{ id: 1, source: 1, target: 2, type: 0 }];
    const { result } = await renderLoaded();
    vi.mocked(api.deleteLink).mockResolvedValue({ success: false, error: 'boom' });

    await act(async () => {
      await result.current.deleteLink(1);
    });

    expect(result.current.links).toHaveLength(1);
    expect(result.current.error).toBe('リンクの削除に失敗しました: boom');
  });
});

describe('タスクの保存', () => {
  it('更新に成功したら、バックエンドの応答でローカルのデータを置き換えて true を返すこと', async () => {
    const { result } = await renderLoaded();
    vi.mocked(api.updateTask).mockResolvedValue({
      success: true,
      data: makeTask(2, { text: 'Saved', duration: 9 }),
    });

    let saved = false;
    await act(async () => {
      saved = await result.current.updateTask(2, { text: '  Saved' });
    });

    expect(saved).toBe(true);
    expect(result.current.tasks[1]).toMatchObject({ text: 'Saved', duration: 9 });
  });

  it('更新に失敗したら、データを変えずにエラーを出して false を返すこと', async () => {
    const { result } = await renderLoaded();
    vi.mocked(api.updateTask).mockResolvedValue({ success: false, error: 'Task not found' });

    let saved = true;
    await act(async () => {
      saved = await result.current.updateTask(2, { text: 'x' });
    });

    expect(saved).toBe(false);
    expect(result.current.tasks[1].text).toBe('Task 2');
    expect(result.current.error).toContain('Task not found');
  });

  it('削除に成功したら、子孫も含めてローカルのデータから取り除くこと', async () => {
    server.tasks = [makeTask(1), makeTask(2, { parent: 1 }), makeTask(3)];
    const { result } = await renderLoaded();
    vi.mocked(api.deleteTask).mockResolvedValue({
      success: true,
      data: { deleted_id: 1, deleted_children: [2] },
    });

    let deleted = false;
    await act(async () => {
      deleted = await result.current.deleteTask(1);
    });

    expect(deleted).toBe(true);
    expect(result.current.tasks.map((task) => task.id)).toEqual([3]);
  });

  it('削除に失敗したら false を返し、データは残すこと', async () => {
    const { result } = await renderLoaded();
    vi.mocked(api.deleteTask).mockResolvedValue({ success: false, error: 'boom' });

    let deleted = true;
    await act(async () => {
      deleted = await result.current.deleteTask(1);
    });

    expect(deleted).toBe(false);
    expect(result.current.tasks).toHaveLength(2);
  });

  it('作成時に日付が無ければ、ローカル日付で今日〜7日後を補って全データを取り直すこと', async () => {
    vi.setSystemTime(new Date(2026, 2, 18, 3, 0)); // 日本時間の早朝（UTCではまだ前日）
    const { result } = await renderLoaded();
    vi.mocked(api.createTask).mockImplementation(async (request) => {
      const created = makeTask(3, request as Partial<Task>);
      server.tasks = [...server.tasks, created];
      return { success: true, data: created };
    });

    await act(async () => {
      await result.current.createTask({ parent: 1 });
    });

    expect(api.createTask).toHaveBeenCalledWith({
      parent: 1,
      text: '新規タスク',
      start_date: '2026-03-18 00:00:00',
      end_date: '2026-03-25 00:00:00',
    });
    expect(result.current.tasks.map((task) => task.id)).toEqual([1, 2, 3]);
  });
});

describe('リンクの保存', () => {
  it('作成・更新・削除をローカルのデータへ反映すること', async () => {
    const { result } = await renderLoaded();
    vi.mocked(api.createLink).mockResolvedValue({ success: true, data: { id: 9, source: 1, target: 2, type: 0 } });
    vi.mocked(api.updateLink).mockResolvedValue({ success: true });
    vi.mocked(api.deleteLink).mockResolvedValue({ success: true });

    await act(async () => {
      await result.current.createLink({ source: 1, target: 2, type: 0 });
    });
    expect(result.current.links).toEqual([{ id: 9, source: 1, target: 2, type: 0 }]);

    await act(async () => {
      await result.current.updateLink(9, { type: 1 });
    });
    expect(result.current.links[0].type).toBe(1);

    await act(async () => {
      await result.current.deleteLink(9);
    });
    expect(result.current.links).toEqual([]);
  });
});
