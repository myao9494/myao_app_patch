/**
 * サーバーターミナル（xterm.js）の入力処理ヘルパー
 * - Tab キーでブラウザのフォーカスが移動しないようにする判定
 * - ローカルエコー（Windows のパイプ実装でエコーが返らない場合）用の変換
 * - 入力中の1行の追跡と、行の置き換え用エスケープシーケンスの生成
 * - 再接続待ち時間（指数バックオフ、最大5秒）
 */
export function shouldPreventTerminalTabFocus(event: KeyboardEvent): boolean {
  return event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey;
}

export function applyLocalTerminalEcho(data: string): string {
  if (data === "\r") {
    return "\r\n";
  }
  if (data === "\u007F") {
    return "\b \b";
  }
  return data;
}

export function updateTrackedTerminalInput(currentLine: string, data: string): string {
  if (data === "\r") {
    return "";
  }
  if (data === "\u007F") {
    return currentLine.slice(0, -1);
  }
  if (data === "\t") {
    return currentLine;
  }
  if (data.startsWith("\u001B")) {
    return currentLine;
  }
  return `${currentLine}${data}`;
}

export function buildLocalLineReplacement(currentLine: string, nextLine: string, cursorIndex: number): string {
  const eraseCurrentLine = "\b \b".repeat(currentLine.length);
  const moveCursorLeft = nextLine.length > cursorIndex ? `\u001B[${nextLine.length - cursorIndex}D` : "";
  return `${eraseCurrentLine}${nextLine}${moveCursorLeft}`;
}

export function isPrintableTerminalInput(data: string): boolean {
  return data.length > 0 && !data.includes("\r") && !data.includes("\u007F") && !data.startsWith("\u001B");
}

export function getTerminalReconnectDelay(attempt: number): number {
  return Math.min(500 * (2 ** Math.max(0, attempt)), 5_000);
}
