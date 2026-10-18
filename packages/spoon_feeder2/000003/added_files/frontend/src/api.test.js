/**
 * APIクライアントのテスト (api.test.js)
 *
 * 仕様: モックを使わず、ローカルに立てた実HTTPサーバーに対して成功・エラー・GET・本文なしを確認する。
 **/

import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from './api';

let server;
let api;
let lastRequest;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      lastRequest = { method: request.method, url: request.url, contentType: request.headers['content-type'], body: Buffer.concat(chunks).toString() };
      const send = (status, payload) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(payload === undefined ? '' : JSON.stringify(payload)); };
      if (request.url === '/ok') return send(200, { value: 1 });
      if (request.url === '/detail') return send(400, { detail: 'フォルダが存在しません' });
      if (request.url === '/message') return send(500, { message: 'サーバー内部のメッセージ' });
      if (request.url === '/empty-error') return send(502);
      return send(404, {});
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  api = createApi(`http://127.0.0.1:${server.address().port}`);
});

afterAll(() => new Promise(resolve => server.close(resolve)));

describe('api', () => {
  it('JSONをPOSTし、レスポンスのJSONを返す', async () => {
    expect(await api('/ok', { a: 'あ' })).toEqual({ value: 1 });
    expect(lastRequest).toMatchObject({ method: 'POST', contentType: 'application/json', body: '{"a":"あ"}' });
  });

  it('GETでは本文を送らない', async () => {
    await api('/ok', undefined, 'GET');
    expect(lastRequest).toMatchObject({ method: 'GET', body: '' });
  });

  it('HTTPエラーはdetail、messageの順でエラーメッセージにする', async () => {
    await expect(api('/detail', {})).rejects.toThrow('フォルダが存在しません');
    await expect(api('/message', {})).rejects.toThrow('サーバー内部のメッセージ');
  });

  it('本文がJSONでないエラーはHTTPステータスをメッセージにする', async () => {
    await expect(api('/empty-error', {})).rejects.toThrow('HTTP 502');
  });
});
