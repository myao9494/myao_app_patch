/**
 * URL履歴・ナビゲーションユーティリティ（quickアプリ用）
 * - ブラウザのURLクエリパラメータ（?file=...）とファイル閲覧状態の同期
 * - 外部リンクからブラウザの「戻る」ボタンで復帰した際に開いていたファイルを復元
 */

/**
 * URLクエリ文字列からファイルパスを取得する
 * @param search window.location.search などのクエリ文字列
 * @returns ファイルパス、または存在しない場合は null
 */
export function getFilePathFromUrl(search: string): string | null {
  if (!search) return null;
  const params = new URLSearchParams(search);
  const file = params.get('file');
  return file ? file.trim() : null;
}

/**
 * ファイルパスからURL文字列を構築する
 * @param filePath 開くファイルの絶対パス
 * @returns /quick/?file=...
 */
export function buildFileUrl(filePath: string): string {
  const params = new URLSearchParams();
  params.set('file', filePath);
  return `/quick/?${params.toString()}`;
}

/**
 * ブラウザの履歴にファイルオープン状態を記録する
 * @param filePath 開くファイルの絶対パス
 */
export function pushFileHistory(filePath: string): void {
  if (typeof window === 'undefined') return;
  const targetUrl = buildFileUrl(filePath);
  if (window.location.pathname + window.location.search !== targetUrl) {
    window.history.pushState({ filePath }, '', targetUrl);
  }
}

/**
 * ブラウザの履歴からファイルパラメータを削除してトップ画面URLへ更新する
 */
export function clearFileHistory(): void {
  if (typeof window === 'undefined') return;
  if (window.location.search) {
    window.history.pushState(null, '', '/quick/');
  }
}
