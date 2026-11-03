/**
 * 画面に依存しない小さな共通関数。
 */

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 右クリックメニューを画面内に収める位置を返す（x, y, 大きさ, 画面の広さはすべて実際の画面上のpx）。
 * 親に zoom（表示倍率）が掛かっていると fixed の left/top も拡大されるため、倍率で割って返す。
 */
export function contextMenuPosition(x, y, size, viewport, scale = 1, margin = 8) {
  const left = Math.max(margin, Math.min(x, viewport.width - size.width - margin));
  const top = Math.max(margin, Math.min(y, viewport.height - size.height - margin));
  return { left: left / scale, top: top / scale };
}

export function isTypingTarget(target) {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) || target?.isContentEditable;
}

export function normalizeLineEndings(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 配列を size 件ずつに分ける（大きな一覧をブロック単位で描画するため）。 */
export function chunkItems(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
