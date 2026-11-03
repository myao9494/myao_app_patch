/**
 * URLクエリパラメータの取得
 * - URLSearchParams がパーセントデコードを1回行うので、取得後に再デコードしない
 *   （再デコードすると "%" を含む実在のパスが別のパスに化け、不正な並びでは例外になる）
 */

export function getPathParam(search: string, key: string): string | null {
  return new URLSearchParams(search).get(key);
}
