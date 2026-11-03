/**
 * テキスト出力を分割する最大文字数の入力解釈 (textLimit.js)
 *
 * 仕様:
 * 1. 既定は500万文字。バックエンド(output_limits.py)の範囲(1万〜1億文字)に合わせる。
 * 2. 空・数値でない入力は既定値、範囲外は上限/下限に丸める。小数は切り捨てる。
 **/

export const DEFAULT_TEXT_MAX_CHARS = 5000000;
export const MIN_TEXT_MAX_CHARS = 10000;
export const MAX_TEXT_MAX_CHARS = 100000000;

export function parseTextMaxChars(raw) {
  const value = Math.floor(Number.parseFloat(raw));
  if (!Number.isFinite(value)) return DEFAULT_TEXT_MAX_CHARS;
  return Math.min(MAX_TEXT_MAX_CHARS, Math.max(MIN_TEXT_MAX_CHARS, value));
}
