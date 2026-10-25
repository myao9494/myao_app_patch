/**
 * @vitest-environment jsdom
 * グリッド編集のステージング管理フック（useGridStaging）のテスト。APIはモックする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import * as api from '../../services/api';
import type { GridDiffItem } from '../../types/gantt';
import { useGridStaging } from '../useGridStaging';

vi.mock('../../services/api');

const diff = (field: string): GridDiffItem => ({ id: 1, table: 'tasks', field, original: 'a', current: 'b' });
const onCommitted = vi.fn(() => Promise.resolve());
let alertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.mocked(api.initGrid).mockResolvedValue({ success: true, data: { tasks_count: 1, links_count: 0 } });
  vi.mocked(api.getGridDiff).mockResolvedValue({ success: true, data: { diffs: [diff('text')] } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

async function renderActive() {
  const rendered = renderHook(({ active }) => useGridStaging({ active, onCommitted }), {
    initialProps: { active: true },
  });
  await waitFor(() => expect(rendered.result.current.diffs).toHaveLength(1));
  return rendered;
}

describe('ステージングの初期化', () => {
  it('グリッド画面でないときは、何も呼ばないこと', () => {
    renderHook(() => useGridStaging({ active: false, onCommitted }));

    expect(api.initGrid).not.toHaveBeenCalled();
  });

  it('グリッド画面に入ったら、ステージングを初期化して差分を取得すること', async () => {
    const { result } = await renderActive();

    expect(api.initGrid).toHaveBeenCalledTimes(1);
    expect(result.current.diffs).toEqual([diff('text')]);
  });

  it('グリッド画面を離れたら、差分と選択を捨てること', async () => {
    const { result, rerender } = await renderActive();
    act(() => result.current.setSelectedDiff(diff('text')));

    rerender({ active: false });

    await waitFor(() => expect(result.current.diffs).toEqual([]));
    expect(result.current.selectedDiff).toBeNull();
  });
});

describe('コミット', () => {
  it('反映したら本データを取り直し、ステージングを初期化し直して差分を空にすること', async () => {
    vi.mocked(api.commitGrid).mockResolvedValue({
      success: true,
      data: { updated_tasks: 2, updated_links: 1, errors: [] },
    });
    const { result } = await renderActive();

    await act(() => result.current.commit());

    expect(alertSpy).toHaveBeenCalledWith('アップロード完了: Tasks 2件, Links 1件');
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(api.initGrid).toHaveBeenCalledTimes(2);
    expect(result.current.diffs).toEqual([]);
    expect(result.current.committing).toBe(false);
  });

  it('エラーがあれば内容を表示すること', async () => {
    vi.mocked(api.commitGrid).mockResolvedValue({
      success: true,
      data: { updated_tasks: 0, updated_links: 0, errors: ['boom'] },
    });
    const { result } = await renderActive();

    await act(() => result.current.commit());

    expect(alertSpy).toHaveBeenCalledWith('アップロードにエラーがありました: boom');
  });

  it('APIが失敗したら何も変えず、処理中の状態も戻すこと', async () => {
    vi.mocked(api.commitGrid).mockResolvedValue({ success: false, error: 'x' });
    const { result } = await renderActive();

    await act(() => result.current.commit());

    expect(onCommitted).not.toHaveBeenCalled();
    expect(result.current.diffs).toHaveLength(1);
    expect(result.current.committing).toBe(false);
  });
});

describe('差分の取り消し', () => {
  it('取り消したら差分を取り直し、その差分を選択中なら選択も外すこと', async () => {
    vi.mocked(api.revertGridDiff).mockResolvedValue({ success: true, data: undefined });
    const { result } = await renderActive();
    act(() => result.current.setSelectedDiff(diff('text')));
    vi.mocked(api.getGridDiff).mockResolvedValue({ success: true, data: { diffs: [] } });

    await act(() => result.current.revert(diff('text')));

    expect(api.revertGridDiff).toHaveBeenCalledWith('tasks', 1, 'text');
    expect(result.current.diffs).toEqual([]);
    expect(result.current.selectedDiff).toBeNull();
  });

  it('別の項目を選択中なら、選択は残すこと', async () => {
    vi.mocked(api.revertGridDiff).mockResolvedValue({ success: true, data: undefined });
    const { result } = await renderActive();
    act(() => result.current.setSelectedDiff(diff('memo')));

    await act(() => result.current.revert(diff('text')));

    expect(result.current.selectedDiff).toEqual(diff('memo'));
  });

  it('失敗したらエラーを表示し、差分は取り直さないこと', async () => {
    vi.mocked(api.revertGridDiff).mockResolvedValue({ success: false, error: 'nope' });
    const { result } = await renderActive();
    vi.mocked(api.getGridDiff).mockClear();

    await act(() => result.current.revert(diff('text')));

    expect(alertSpy).toHaveBeenCalledWith('元に戻す処理に失敗しました: nope');
    expect(api.getGridDiff).not.toHaveBeenCalled();
  });
});
