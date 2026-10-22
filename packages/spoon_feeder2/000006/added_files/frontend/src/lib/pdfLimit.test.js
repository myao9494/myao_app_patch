import { describe, expect, it } from 'vitest';
import { DEFAULT_PDF_MAX_MB, parsePdfMaxMb } from './pdfLimit';

describe('parsePdfMaxMb', () => {
  it('既定は10MB', () => {
    expect(DEFAULT_PDF_MAX_MB).toBe(10);
    expect(parsePdfMaxMb(null)).toBe(10);
  });

  it('数値でない入力は既定値にする', () => {
    expect(parsePdfMaxMb('')).toBe(10);
    expect(parsePdfMaxMb('abc')).toBe(10);
  });

  it('小数を受け付け、範囲外は0.5〜1000MBに丸める', () => {
    expect(parsePdfMaxMb('7.5')).toBe(7.5);
    expect(parsePdfMaxMb('0')).toBe(0.5);
    expect(parsePdfMaxMb('99999')).toBe(1000);
  });
});
