/**
 * @vitest-environment jsdom
 * 外部からの入力画面オープン要求を受け取るフック（useOpenInputRequests）のテスト。APIはモックする。
 */
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import * as api from '../../services/api';
import { useOpenInputRequests } from '../useOpenInputRequests';

vi.mock('../../services/api');

const STORAGE_KEY = 'gantt_lastOpenInputRequestId';
const pending = (requestId: number, taskId = 7) => ({
  success: true as const,
  data: { request_id: requestId, task_id: taskId, created_at: '2026-01-01 00:00:00' },
});

function renderAt(path: string) {
  const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>;
  return renderHook(() => ({ open: useOpenInputRequests(), location: useLocation() }), { wrapper });
}

/** 非同期のポーリング処理が完了するまで待つ */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
  vi.mocked(api.sendTaskInputOpenClientHeartbeat).mockResolvedValue({ success: true, data: { status: 'ok' } });
  vi.mocked(api.getTaskInputOpenRequest).mockResolvedValue({ success: true, data: null });
  vi.mocked(api.acknowledgeTaskInputOpenRequest).mockResolvedValue({
    success: true, data: { status: 'ok', cleared: true, request_id: 0 },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('ハートビート', () => {
  it('開いたときに1回送り、その後は5秒ごとに送ること', async () => {
    renderAt('/');
    await settle();
    expect(api.sendTaskInputOpenClientHeartbeat).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(api.sendTaskInputOpenClientHeartbeat).toHaveBeenCalledTimes(3);
  });
});

describe('リクエストの受け取り', () => {
  it('未処理のリクエストがあれば、タスクIDつきで返すこと', async () => {
    vi.mocked(api.getTaskInputOpenRequest).mockResolvedValue(pending(5, 42));
    const { result } = renderAt('/');

    await settle();

    expect(result.current.open.request).toMatchObject({ requestId: 5, taskId: 42 });
  });

  it('処理済みのID以下のリクエストは無視すること', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, '5');
    vi.mocked(api.getTaskInputOpenRequest).mockResolvedValue(pending(5));
    const { result } = renderAt('/');

    await settle();

    expect(result.current.open.request).toBeNull();
  });

  it('ガント以外の画面にいるときは、ガント画面へ切り替えること', async () => {
    vi.mocked(api.getTaskInputOpenRequest).mockResolvedValue(pending(5));
    const { result } = renderAt('/grid');

    await settle();

    expect(result.current.location.pathname).toBe('/');
  });
});

describe('処理済みの通知', () => {
  it('処理済みにすると、バックエンドへ ack し、IDを覚えて同じリクエストを再処理しないこと', async () => {
    vi.mocked(api.getTaskInputOpenRequest).mockResolvedValue(pending(5));
    const { result } = renderAt('/');
    await settle();

    act(() => result.current.open.markHandled(5));
    const firstAttempt = result.current.open.request;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(api.acknowledgeTaskInputOpenRequest).toHaveBeenCalledWith(5);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('5');
    expect(result.current.open.request).toBe(firstAttempt);
  });

  it('古いIDで処理済みにしても、覚えている最大IDは小さくならないこと', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, '9');
    const { result } = renderAt('/');

    act(() => result.current.open.markHandled(3));

    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('9');
  });
});
