/**
 * タスク名（text）まわりの文字列ユーティリティ
 * - UIからコピーされたタスク名の先頭に混入するインデント・アイコンの除去
 * - ガントチャートのHTMLテンプレートへ埋め込む際のエスケープ
 */

// バックエンド（services/task_text.py の LEADING_NOISE_RE）と同じ文字集合。
// 絵文字はサロゲートペアなので、u フラグが無いと片方だけ削れて文字化けする。
const LEADING_NOISE_RE = /^[\s\u3000📁📄📅🔍📝📌]+/u;

/** タスク名の先頭にある空白類（全角スペース含む）とアイコン絵文字を取り除く */
export function stripLeadingNoise(text: string | null | undefined): string {
  return (text ?? '').replace(LEADING_NOISE_RE, '');
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** HTMLの本文・属性値に安全に埋め込めるようエスケープする */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}
