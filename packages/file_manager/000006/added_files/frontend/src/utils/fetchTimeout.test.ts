/**
 * APIタイムアウト処理のテスト
 * - setupFetchTimeout() による window.fetch へのパッチ適用
 * - 制限時間経過時の AbortError 発生およびエラーメッセージの確認
 * - アップロード処理等でのタイムアウト除外設定の確認
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isTimeoutExempt, setupFetchTimeout } from './fetchTimeout';
import * as config from '../config';

describe('setupFetchTimeout', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // getApiTimeout をモックできるように設定
    vi.spyOn(config, 'getApiTimeout').mockReturnValue(2); // テスト用に2秒に設定
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should patch window.fetch and timeout normal API requests', async () => {
    // 応答が完了しないが、AbortSignal がトリガーされたら AbortError で reject するfetchをモックする
    const mockFetch = vi.fn().mockImplementation((input, init) => {
      return new Promise<Response>((resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('The user aborted a request.', 'AbortError'));
          });
        }
      });
    });
    globalThis.fetch = mockFetch;

    setupFetchTimeout();

    const fetchPromise = fetch('/api/files?path=/test');

    // 2秒進める
    vi.advanceTimersByTime(2000);

    await expect(fetchPromise).rejects.toThrow('リクエストがタイムアウトしました');
    expect(mockFetch).toHaveBeenCalled();
  });

  it('should not timeout if request completes before timeout', async () => {
    const mockResponse = { ok: true, json: async () => ({}) } as Response;
    const mockFetch = vi.fn().mockResolvedValue(mockResponse);
    globalThis.fetch = mockFetch;

    setupFetchTimeout();

    const fetchPromise = fetch('/api/files?path=/test');

    // 1秒だけ進める（タイムアウトは2秒）
    vi.advanceTimersByTime(1000);

    // Promiseが解決されることを確認
    const res = await fetchPromise;
    expect(res.ok).toBe(true);
  });

  it('should ignore timeout for /api/upload requests', async () => {
    // 応答が完了しないダミーのfetch
    const mockFetchPromise = new Promise<Response>(() => {});
    const mockFetch = vi.fn().mockReturnValue(mockFetchPromise);
    globalThis.fetch = mockFetch;

    setupFetchTimeout();

    const fetchPromise = fetch('/api/upload?path=/test');

    // タイムアウトの2秒（さらには10秒）進めてもタイムアウトしない
    vi.advanceTimersByTime(10000);

    // タイムアウトが動作していない（エラーがスローされていない）
    let isPending = true;
    fetchPromise.finally(() => { isPending = false; });
    
    // マイクロタスクキューをクリア
    await Promise.resolve();
    
    expect(isPending).toBe(true);
  });
});

describe('isTimeoutExempt', () => {
  it('exempts long-running write operations so the UI never reports a false failure', () => {
    expect(isTimeoutExempt('/api/upload?path=/x')).toBe(true);
    expect(isTimeoutExempt('/api/move/batch')).toBe(true);
    expect(isTimeoutExempt('/api/move')).toBe(true);
    expect(isTimeoutExempt('/api/copy/batch')).toBe(true);
    expect(isTimeoutExempt('/api/delete/batch')).toBe(true);
    expect(isTimeoutExempt('http://host:8001/api/update-file')).toBe(true);
    expect(isTimeoutExempt('/api/unzip')).toBe(true);
  });

  it('keeps the timeout for listing and lookups', () => {
    expect(isTimeoutExempt('/api/files?path=/api/move')).toBe(false);
    expect(isTimeoutExempt('/api/path-info?path=/x')).toBe(false);
    expect(isTimeoutExempt('/api/movement')).toBe(false);
  });
});
