/**
 * 想定外のエラーを画面へ出すときの共通処理。
 * - Reactの描画エラーは ErrorBoundary、ボタン操作や非同期処理のエラーは GlobalErrorNotice が受け止める
 * - 処理を止めないブラウザーの警告は通知しない
 */

// ResizeObserver の通知が1フレームに収まらなかっただけの警告で、動作には影響しない
const IGNORED_MESSAGES = ["ResizeObserver loop"];

export function describeError(error) {
  if (!error) return "原因不明のエラーです";
  const message = typeof error === "string" ? error : error.message;
  return String(message || error).slice(0, 500);
}

export function shouldIgnoreGlobalError(error) {
  // 利用者が中断した通信はエラーとして知らせない
  if (error?.name === "AbortError") return true;
  const message = describeError(error);
  return IGNORED_MESSAGES.some((ignored) => message.includes(ignored));
}
