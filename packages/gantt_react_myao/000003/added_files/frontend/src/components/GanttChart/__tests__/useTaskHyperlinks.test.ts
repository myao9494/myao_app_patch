/**
 * @vitest-environment jsdom
 * タスクのハイパーリンク操作（Obsidianノートの作成・リンクを開く）のテスト。APIはモックする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import * as api from '../../../services/api';
import type { Task } from '../../../types/gantt';
import { useTaskHyperlinks } from '../useTaskHyperlinks';

vi.mock('../../../services/api');

const OBSIDIAN_HOME = '/vault';
const updateTaskFields = vi.fn();
let openSpy: ReturnType<typeof vi.spyOn>;
let alertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function setup() {
  return renderHook(() => useTaskHyperlinks({ obsidianHome: OBSIDIAN_HOME, updateTaskFields })).result;
}

describe('openHyperlink', () => {
  it('Obsidian Vault 外のリンクは、確認せずにそのまま開くこと', async () => {
    const hooks = setup();

    await act(() => hooks.current.openHyperlink(1, 'https://example.com'));

    expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank');
    expect(api.resolveTaskLink).not.toHaveBeenCalled();
  });

  it('Vault 内のリンクは、再解決してから開き、パスが変わっていればタスクのリンクを更新すること', async () => {
    vi.mocked(api.resolveTaskLink).mockResolvedValue({
      success: true,
      data: { task_id: 1, hyperlink: 'https://moved.example/note', updated: true },
    });
    const hooks = setup();

    await act(() => hooks.current.openHyperlink(1, '/vault/old.md'));

    expect(api.resolveTaskLink).toHaveBeenCalledWith(1, OBSIDIAN_HOME);
    expect(updateTaskFields).toHaveBeenCalledWith(1, { hyperlink: 'https://moved.example/note' });
    expect(openSpy).toHaveBeenCalledWith('https://moved.example/note', '_blank');
  });

  it('再解決に失敗したら、エラーを表示してリンクは開かないこと', async () => {
    vi.mocked(api.resolveTaskLink).mockResolvedValue({ success: false, error: 'Linked file not found' });
    const hooks = setup();

    await act(() => hooks.current.openHyperlink(1, '/vault/missing.md'));

    expect(alertSpy).toHaveBeenCalledWith('Linked file not found');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('処理中にもう一度呼ばれても、再解決は1回だけにすること', async () => {
    let resolveApi: (value: Awaited<ReturnType<typeof api.resolveTaskLink>>) => void = () => {};
    vi.mocked(api.resolveTaskLink).mockImplementation(() => new Promise((resolve) => { resolveApi = resolve; }));
    const hooks = setup();

    let first!: Promise<void>;
    await act(async () => {
      first = hooks.current.openHyperlink(1, '/vault/a.md');
      await hooks.current.openHyperlink(1, '/vault/a.md');
    });
    await act(async () => {
      resolveApi({ success: true, data: { task_id: 1, hyperlink: '/vault/a.md', updated: false } });
      await first;
    });

    expect(api.resolveTaskLink).toHaveBeenCalledTimes(1);
  });
});

describe('createObsidianNote', () => {
  it('ノートを作成したら、タスクのリンクに設定して開くこと', async () => {
    vi.mocked(api.createObsidianNote).mockResolvedValue({
      success: true,
      data: { id: 1, hyperlink: 'https://note.example/1' } as Task,
    });
    const hooks = setup();

    await act(() => hooks.current.createObsidianNote(1));

    expect(api.createObsidianNote).toHaveBeenCalledWith(1, OBSIDIAN_HOME);
    expect(updateTaskFields).toHaveBeenCalledWith(1, { hyperlink: 'https://note.example/1' });
    expect(openSpy).toHaveBeenCalledWith('https://note.example/1', '_blank');
  });

  it('作成に失敗したら、エラーを表示してリンクは変えないこと', async () => {
    vi.mocked(api.createObsidianNote).mockResolvedValue({ success: false, error: 'boom' });
    const hooks = setup();

    await act(() => hooks.current.createObsidianNote(1));

    expect(alertSpy).toHaveBeenCalledWith('ファイル作成に失敗しました: boom');
    expect(updateTaskFields).not.toHaveBeenCalled();
  });
});
