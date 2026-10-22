/**
 * 図PDFの上限サイズ(MB)の入力解釈 (pdfLimit.js)
 *
 * 仕様:
 * 1. 既定は10MB。バックエンド(output_limits.py)の範囲(0.5〜1000MB)に合わせる。
 * 2. 空・数値でない・範囲外の入力は、有効な値に丸める（空・数値でない場合は既定値、範囲外は上限/下限）。
 **/

export const DEFAULT_PDF_MAX_MB = 10;
export const MIN_PDF_MAX_MB = 0.5;
export const MAX_PDF_MAX_MB = 1000;

export function parsePdfMaxMb(raw) {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return DEFAULT_PDF_MAX_MB;
  return Math.min(MAX_PDF_MAX_MB, Math.max(MIN_PDF_MAX_MB, value));
}
