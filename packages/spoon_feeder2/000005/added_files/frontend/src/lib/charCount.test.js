import { describe, expect, it } from 'vitest';
import { CHAR_LIMIT, countChars, formatMan } from './charCount';

describe('countChars', () => {
  it('空や未定義は0文字', () => {
    expect(countChars('')).toBe(0);
    expect(countChars(undefined)).toBe(0);
  });

  it('日本語と改行を1文字ずつ数える', () => expect(countChars('あい\nう')).toBe(4));

  it('絵文字などのサロゲートペアは1文字として数える', () => expect(countChars('a😀b')).toBe(3));
});

describe('formatMan', () => {
  it('万文字単位で小数2桁まで表示する', () => {
    expect(formatMan(123456)).toBe('12.35万文字');
    expect(formatMan(200000)).toBe('20.00万文字');
    expect(formatMan(0)).toBe('0.00万文字');
  });

  it('上限は20万文字', () => expect(CHAR_LIMIT).toBe(200000));
});
