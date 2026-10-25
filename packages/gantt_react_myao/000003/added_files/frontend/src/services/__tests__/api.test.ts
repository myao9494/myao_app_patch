/**
 * APIクライアント（services/api）のテスト。HTTP通信は axios のアダプターを差し替えてモックする。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import api, * as client from '../api';
import { cloneTask, describeApiError, getTasks, observeMutationSequence, updateTask } from '../api';

const originalAdapter = api.defaults.adapter;
let requests: InternalAxiosRequestConfig[] = [];

/** 指定したステータスとボディを返すアダプターに差し替える（4xx/5xx は axios と同じく例外にする） */
function respondWith(status: number, data: unknown, headers: Record<string, string> = {}) {
  const adapter: AxiosAdapter = async (config) => {
    requests.push(config);
    const response = { data, status, statusText: '', headers, config };
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
  vi.restoreAllMocks();
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

describe('更新シーケンスの通知', () => {
  it('変更系APIの成功応答にあるシーケンス番号を、登録されたリスナーへ渡すこと', async () => {
    const received: number[] = [];
    const unsubscribe = observeMutationSequence((sequence) => received.push(sequence));
    respondWith(200, {}, { 'x-update-sequence': '8' });

    await updateTask(1, { text: 'x' });
    unsubscribe();
    await updateTask(1, { text: 'y' });

    expect(received).toEqual([8]);
  });

  it('取得（GET）の応答や、番号のない応答、失敗した応答では通知しないこと', async () => {
    const received: number[] = [];
    const unsubscribe = observeMutationSequence((sequence) => received.push(sequence));

    respondWith(200, {}, { 'x-update-sequence': '8' });
    await getTasks();
    respondWith(200, {});
    await updateTask(1, { text: 'x' });
    respondWith(404, { detail: 'Task not found' }, { 'x-update-sequence': '9' });
    await updateTask(1, { text: 'x' });
    unsubscribe();

    expect(received).toEqual([]);
  });
});

describe('エンドポイントごとのリクエスト', () => {
  /** [呼び出し, 期待するメソッド, URL, クエリ, ボディ] */
  const cases: Array<[string, () => Promise<unknown>, string, string, Record<string, unknown> | undefined, unknown]> = [
    ['getTask', () => client.getTask(3), 'get', '/api/tasks/3', undefined, undefined],
    ['createTask', () => client.createTask({ text: 'A', start_date: 's', end_date: 'e' }), 'post', '/api/tasks', undefined, { text: 'A', start_date: 's', end_date: 'e' }],
    ['updateTask', () => client.updateTask(3, { text: 'B' }), 'put', '/api/tasks/3', undefined, { text: 'B' }],
    ['deleteTask', () => client.deleteTask(3), 'delete', '/api/tasks/3', undefined, undefined],
    ['createObsidianNote', () => client.createObsidianNote(3, '/vault'), 'post', '/api/tasks/3/obsidian', { obsidian_home: '/vault' }, undefined],
    ['createObsidianNote(ホーム未設定)', () => client.createObsidianNote(3), 'post', '/api/tasks/3/obsidian', undefined, undefined],
    ['resolveTaskLink', () => client.resolveTaskLink(3, '/vault'), 'post', '/api/tasks/3/resolve-link', { obsidian_home: '/vault' }, undefined],
    ['reorderTasks', () => client.reorderTasks({ items: [{ id: 1, sortorder: 0, parent: 0 }] }), 'post', '/api/tasks/reorder', undefined, { items: [{ id: 1, sortorder: 0, parent: 0 }] }],
    ['getGanttUpdateSequence', () => client.getGanttUpdateSequence(), 'get', '/api/tasks/update-sequence', undefined, undefined],
    ['requestTaskInputOpen', () => client.requestTaskInputOpen(3), 'post', '/api/tasks/3/open-input', undefined, undefined],
    ['getTaskInputOpenRequest', () => client.getTaskInputOpenRequest(), 'get', '/api/tasks/open-input-request', undefined, undefined],
    ['acknowledgeTaskInputOpenRequest', () => client.acknowledgeTaskInputOpenRequest(9), 'post', '/api/tasks/open-input-request/9/ack', undefined, undefined],
    ['sendTaskInputOpenClientHeartbeat', () => client.sendTaskInputOpenClientHeartbeat(), 'post', '/api/tasks/open-input-client-heartbeat', undefined, undefined],
    ['getLinks', () => client.getLinks(), 'get', '/api/links', undefined, undefined],
    ['createLink', () => client.createLink({ source: 1, target: 2, type: 0 }), 'post', '/api/links', undefined, { source: 1, target: 2, type: 0 }],
    ['updateLink', () => client.updateLink(4, { type: 2 }), 'put', '/api/links/4', undefined, { type: 2 }],
    ['deleteLink', () => client.deleteLink(4), 'delete', '/api/links/4', undefined, undefined],
    ['syncObsidianCsv', () => client.syncObsidianCsv('/vault'), 'post', '/api/obsidian/export-sync', { obsidian_home: '/vault' }, undefined],
    ['getObsidianCsvSyncSummary', () => client.getObsidianCsvSyncSummary('/vault'), 'get', '/api/obsidian/export-sync-summary', { obsidian_home: '/vault' }, undefined],
    ['getHolidays', () => client.getHolidays(), 'get', '/api/holidays', undefined, undefined],
    ['addHoliday', () => client.addHoliday('2026-01-01'), 'post', '/api/holidays', undefined, { date: '2026-01-01' }],
    ['deleteHoliday', () => client.deleteHoliday('2026-01-01'), 'delete', '/api/holidays/2026-01-01', undefined, undefined],
    ['updateHolidayRawText', () => client.updateHolidayRawText('x'), 'put', '/api/holidays/raw', undefined, { raw_text: 'x' }],
    ['getBusinessTrips', () => client.getBusinessTrips(), 'get', '/api/business-trips', undefined, undefined],
    ['addBusinessTrip', () => client.addBusinessTrip('2026-01-01', 'day_trip'), 'post', '/api/business-trips', undefined, { date: '2026-01-01', type: 'day_trip' }],
    ['updateBusinessTripRawText', () => client.updateBusinessTripRawText('x'), 'put', '/api/business-trips/raw', undefined, { raw_text: 'x' }],
    ['getSynonyms', () => client.getSynonyms(), 'get', '/api/synonyms', undefined, undefined],
    ['initGrid', () => client.initGrid(), 'post', '/api/grid/init', undefined, undefined],
    ['updateGridTask', () => client.updateGridTask(5, { text: 'x' }), 'put', '/api/grid/tasks/5', undefined, { text: 'x' }],
    ['updateGridLink', () => client.updateGridLink(5, { type: 1 }), 'put', '/api/grid/links/5', undefined, { type: 1 }],
    ['getGridDiff', () => client.getGridDiff(), 'get', '/api/grid/diff', undefined, undefined],
    ['commitGrid', () => client.commitGrid(), 'post', '/api/grid/commit', undefined, undefined],
    ['revertGridDiff', () => client.revertGridDiff('tasks', 5, 'text'), 'post', '/api/grid/revert', undefined, { table: 'tasks', id: 5, field: 'text' }],
  ];

  it.each(cases)('%s は、期待するメソッド・URL・パラメータ・ボディで呼ぶこと', async (_name, call, method, url, params, body) => {
    respondWith(200, {});

    await call();

    const sent = requests[0];
    expect(sent.method).toBe(method);
    expect(sent.url).toBe(url);
    expect(sent.params).toEqual(params);
    // ボディなしの POST は null として送られる
    expect((sent.data == null ? null : JSON.parse(sent.data)) ?? undefined).toEqual(body);
  });

  it('日付の解除は、URLに使えない文字をエンコードすること', async () => {
    respondWith(200, {});

    await client.deleteHoliday('2026/01/01');

    expect(requests[0].url).toBe('/api/holidays/2026%2F01%2F01');
  });

  it('同義語APIの失敗では、専用の既定メッセージを返すこと', async () => {
    api.defaults.adapter = async () => { throw 'unexpected'; };

    expect(await client.getSynonyms()).toEqual({ success: false, error: '同義語APIエラー' });
  });
});

describe('CSVのインポート/エクスポート', () => {
  it('インポートは、ファイルを multipart で送ること', async () => {
    respondWith(200, { imported_count: 1, skipped_count: 0, errors: [] });

    const result = await client.importCSV(new File(['id,text'], 'tasks.csv'));

    expect(result.success).toBe(true);
    expect(requests[0].url).toBe('/api/import/csv');
    expect(requests[0].data).toBeInstanceOf(FormData);
    expect((requests[0].data as FormData).get('file')).toBeInstanceOf(File);
  });

  it('エクスポートは、成功したら Blob を返し、失敗したら null を返すこと', async () => {
    const blob = new Blob(['zip']);
    respondWith(200, blob);
    expect(await client.exportCSV()).toBe(blob);
    expect(requests[0].responseType).toBe('blob');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    respondWith(500, 'error');
    expect(await client.exportCSV()).toBeNull();
  });
});
