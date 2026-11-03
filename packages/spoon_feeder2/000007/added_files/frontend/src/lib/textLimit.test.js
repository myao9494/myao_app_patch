import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_MAX_CHARS, MAX_TEXT_MAX_CHARS, MIN_TEXT_MAX_CHARS, parseTextMaxChars } from './textLimit';

describe('parseTextMaxChars', () => {
  it('既定は500万文字', () => {
    expect(DEFAULT_TEXT_MAX_CHARS).toBe(5000000);
    expect(parseTextMaxChars(null)).toBe(5000000);
  });

  it('数値でない入力は既定値にする', () => {
    expect(parseTextMaxChars('')).toBe(DEFAULT_TEXT_MAX_CHARS);
    expect(parseTextMaxChars('abc')).toBe(DEFAULT_TEXT_MAX_CHARS);
  });

  it('指定した文字数を受け付け、小数は切り捨てる', () => {
    expect(parseTextMaxChars('200000')).toBe(200000);
    expect(parseTextMaxChars('150000.9')).toBe(150000);
  });

  it('範囲外は1万〜1億文字に丸める', () => {
    expect(parseTextMaxChars('0')).toBe(MIN_TEXT_MAX_CHARS);
    expect(parseTextMaxChars('-5')).toBe(MIN_TEXT_MAX_CHARS);
    expect(parseTextMaxChars('999999999999')).toBe(MAX_TEXT_MAX_CHARS);
  });
});
