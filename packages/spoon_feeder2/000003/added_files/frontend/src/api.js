/**
 * バックエンドAPIクライアント (api.js)
 *
 * 仕様:
 * 1. JSONをPOST（またはGET）し、レスポンスのJSONを返す。HTTPエラー時は detail / message / HTTPステータスを持つErrorを投げる。
 * 2. createApi(baseUrl) で接続先を切り替えられる（既定は同一オリジンの相対URL）。
 **/

export const createApi = (baseUrl = '') => async (url, body, method = 'POST') => {
  const response = await fetch(`${baseUrl}${url}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.message || `HTTP ${response.status}`);
  return data;
};

export const api = createApi();
