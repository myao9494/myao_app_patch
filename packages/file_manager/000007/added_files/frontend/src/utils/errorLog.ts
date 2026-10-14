/**
 * エラーのコンソール出力
 * - logError: 握りつぶさず原因（文脈・メッセージ・スタック）をコンソールに残す
 * - installGlobalErrorLogging: 捕捉されなかった例外・Promise拒否をコンソールに残す
 */

/** 文脈つきでエラーをコンソールに出力する */
export function logError(context: string, err: unknown): void {
  console.error(`[file_manager] ${context}`, err);
}

/** window 全体の未処理エラーをコンソールに出力する（解除関数を返す） */
export function installGlobalErrorLogging(target: Window = window): () => void {
  const onError = (event: ErrorEvent) => {
    logError("未処理のエラー", event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    logError("未処理のPromise拒否", event.reason);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
