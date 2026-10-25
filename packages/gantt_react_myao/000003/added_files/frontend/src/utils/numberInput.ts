/**
 * 日数入力欄（表示期間の開始・終了）の入力値を扱う関数。
 * 全角の数字・ハイフンを半角にそろえ、入力途中の "-" や空文字も許容する。
 */

const MAX_ABS_DAYS = 1000;

/** 全角数字と各種ハイフン・マイナスを半角にそろえる */
export function normalizeNumberInput(value: string): string {
  return value
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/[－ー―−]/g, '-');
}

/** 入力中の値として受け付けてよいか（空文字と "-" だけの状態も許す） */
export function isValidNumberInput(value: string): boolean {
  const normalized = normalizeNumberInput(value);
  return normalized === '' || normalized === '-' || /^-?\d+$/.test(normalized);
}

/** 入力の確定時に、数値文字列（-1000〜1000、数値にできなければ 0）へ整える */
export function finalizeNumberInput(value: string): string {
  const num = Number(normalizeNumberInput(value)) || 0;
  return String(Math.max(-MAX_ABS_DAYS, Math.min(MAX_ABS_DAYS, num)));
}
