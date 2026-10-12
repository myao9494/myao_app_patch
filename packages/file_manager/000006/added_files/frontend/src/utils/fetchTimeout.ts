/**
 * APIリクエストのタイムアウト処理
 * - globalThis.fetch をラップし、一定時間応答がない場合に AbortController によりリクエストを中断する
 * - タイムアウト時間は設定ファイル（settings.json）から動的に読み込む
 * - 次のAPIはタイムアウトを適用しない（isTimeoutExempt）
 *   - アップロード（/api/upload）: 大容量で時間がかかる
 *   - 移動・コピー・削除・ファイル保存・解凍: 途中で通信だけ切るとサーバー側では処理が続き、
 *     「失敗」と表示されたのに実際は完了している、という食い違いが起きるため
 */

import { getApiTimeout } from '../config';

let isPatched = false;

/** タイムアウトを適用しないAPIのパス */
const TIMEOUT_EXEMPT_PATHS = [
  '/api/upload',
  '/api/move',
  '/api/copy/batch',
  '/api/delete',
  '/api/update-file',
  '/api/unzip',
];

export function isTimeoutExempt(url: string): boolean {
  let pathname = url;
  try {
    pathname = new URL(url, 'http://localhost').pathname;
  } catch {
    // 相対パスなどはそのまま判定する
  }
  return TIMEOUT_EXEMPT_PATHS.some((exempt) => pathname === exempt || pathname.startsWith(`${exempt}/`));
}

export function setupFetchTimeout(): void {
  if (isPatched) {
    return;
  }

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);

    if (isTimeoutExempt(urlStr)) {
      return originalFetch(input, init);
    }

    // 動的にタイムアウト値を取得 (秒 -> ミリ秒)
    const timeoutSec = getApiTimeout();
    const timeoutMs = timeoutSec * 1000;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    // 既存のsignalがあればマージすべきだが、本アプリでは現在他のsignalは使用されていないため単純に上書きする
    const newInit: RequestInit = {
      ...init,
      signal: controller.signal,
    };

    try {
      const response = await originalFetch(input, newInit);
      return response;
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') {
        throw new Error(
          `リクエストがタイムアウトしました（設定値: ${timeoutSec}秒）。ネットワークドライブが遅いか、サーバーが応答していません。`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  isPatched = true;
}
