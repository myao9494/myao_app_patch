/**
 * AIインプット出力の文字数・容量の表示。
 * - countChars: サロゲートペア（絵文字など）を 1 文字と数える（バックエンドの Python len と同じ数え方）。
 * - formatMan: 文字数を「12.35万文字」の形にする。
 * - formatMegabytes: 容量を「4.50MB」（1MB = 1,000,000 バイト、社内AIの 4.5MB 制限と同じ単位）の形にする。
 * - DEFAULT_CHAR_LIMIT / DEFAULT_SIZE_LIMIT_BYTES: サーバーが上限を返さないときに使う社内AIの上限。
 */
export const DEFAULT_CHAR_LIMIT = 200_000;
export const DEFAULT_SIZE_LIMIT_BYTES = 4_500_000;

const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

export function countChars(text: string | null | undefined): number {
  const value = text ?? "";
  return value.length - (value.match(SURROGATE_PAIR)?.length ?? 0);
}

export function formatMan(count: number): string {
  return `${(count / 10_000).toFixed(2)}万文字`;
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(2)}MB`;
}
