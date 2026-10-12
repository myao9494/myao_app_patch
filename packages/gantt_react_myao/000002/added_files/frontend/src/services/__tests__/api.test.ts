/**
 * APIクライアント（services/api）のテスト。HTTP通信は axios のアダプターを差し替えてモックする。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import api, { cloneTask, describeApiError, getTasks, updateTask } from '../api';

const originalAdapter = api.defaults.adapter;
let requests: InternalAxiosRequestConfig[] = [];

/** 指定したステータスとボディを返すアダプターに差し替える（4xx/5xx は axios と同じく例外にする） */
function respondWith(status: number, data: unknown) {
  const adapter: AxiosAdapter = async (config) => {
    requests.push(config);
    const response = { data, status, statusText: '', headers: {}, config };
    if (status >= 400) {
      throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, null, response);
    }
    return response;
  };
  api.defaults.adapter = adapter;
}

afterEach(() => {
  api.defaults.adapter = originalAdapter;
  requests = [];
});

describe('API呼び出しの結果', () => {
  it('成功時は success と応答データを返すこと', async () => {
    respondWith(200, { tasks: [], links: [] });

    expect(await getTasks()).toEqual({ success: true, data: { tasks: [], links: [] } });
    expect(requests[0].url).toBe('/api/tasks');
  });

  it('失敗時は例外を投げず、バックエンドの詳細メッセージを error に入れること', async () => {
    respondWith(404, { detail: 'Task not found' });

    expect(await updateTask(1, { text: 'x' })).toEqual({ success: false, error: 'Task not found' });
  });

  it('詳細メッセージが無い失敗では、通信エラーのメッセージを返すこと', async () => {
    respondWith(500, 'Internal Server Error');

    const result = await getTasks();

    expect(result.success).toBe(false);
    expect(result.error).toBe('Request failed with status code 500');
  });

  it('複製先の指定は、指定されたときだけクエリパラメータにすること', async () => {
    respondWith(200, {});

    await cloneTask(3);
    await cloneTask(3, 7);

    expect(requests.map((request) => [request.url, request.params])).toEqual([
      ['/api/tasks/3/clone', {}],
      ['/api/tasks/3/clone', { target_id: 7 }],
    ]);
  });
});

describe('describeApiError', () => {
  it('バリデーションエラーのように detail が文字列でない場合は、例外のメッセージを使うこと', () => {
    const error = new AxiosError('Request failed with status code 422', 'ERR_BAD_REQUEST', undefined, null, {
      data: { detail: [{ msg: 'field required' }] },
      status: 422,
      statusText: '',
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    });

    expect(describeApiError(error)).toBe('Request failed with status code 422');
  });

  it('Error でない値には既定のメッセージを返すこと', () => {
    expect(describeApiError('oops')).toBe('通信エラー');
    expect(describeApiError(null, '同義語APIエラー')).toBe('同義語APIエラー');
  });
});
