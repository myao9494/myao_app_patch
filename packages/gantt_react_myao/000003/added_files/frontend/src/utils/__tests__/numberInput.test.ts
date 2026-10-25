import { describe, expect, it } from 'vitest';
import { finalizeNumberInput, isValidNumberInput, normalizeNumberInput } from '../numberInput';

describe('normalizeNumberInput', () => {
  it('全角の数字とハイフン類を半角にすること', () => {
    expect(normalizeNumberInput('－１２')).toBe('-12');
    expect(normalizeNumberInput('ー５')).toBe('-5');
    expect(normalizeNumberInput('−３')).toBe('-3');
  });

  it('半角の値はそのまま返すこと', () => {
    expect(normalizeNumberInput('-7')).toBe('-7');
  });
});

describe('isValidNumberInput', () => {
  it.each(['', '-', '0', '-15', '１２', '－３'])('入力途中も含め %j を受け付けること', (value) => {
    expect(isValidNumberInput(value)).toBe(true);
  });

  it.each(['a', '1.5', '--1', '1-', '１a'])('%j は受け付けないこと', (value) => {
    expect(isValidNumberInput(value)).toBe(false);
  });
});

describe('finalizeNumberInput', () => {
  it('数値にできない値は 0 にすること', () => {
    expect(finalizeNumberInput('')).toBe('0');
    expect(finalizeNumberInput('-')).toBe('0');
  });

  it('-1000〜1000 の範囲に収めること', () => {
    expect(finalizeNumberInput('5000')).toBe('1000');
    expect(finalizeNumberInput('-5000')).toBe('-1000');
    expect(finalizeNumberInput('１２')).toBe('12');
  });
});
