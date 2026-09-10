/**
 * 電話番号抽出ユーティリティのテスト
 * - 固定電話、携帯電話、フリーダイヤルの抽出検証
 * - ハイフン有無の正規化検証
 */
import { describe, it, expect } from 'vitest';
import { extractPhoneNumbers } from './phone';

describe('extractPhoneNumbers', () => {
  it('携帯電話番号（ハイフンあり）を正しく抽出すること', () => {
    const text = '緊急連絡先：山田父（090-1234-5678）までご連絡ください。';
    const result = extractPhoneNumbers(text);
    expect(result).toHaveLength(1);
    expect(result[0].raw).toBe('090-1234-5678');
    expect(result[0].normalized).toBe('09012345678');
  });

  it('固定電話番号および複数の連絡先を正しく抽出すること', () => {
    const text = `
      学校代表: 03-1234-5678
      職員室直通: 03-9876-5432
      PTA会長携帯: 080-1111-2222
    `;
    const result = extractPhoneNumbers(text);
    expect(result).toHaveLength(3);
    expect(result[0].raw).toBe('03-1234-5678');
    expect(result[1].raw).toBe('03-9876-5432');
    expect(result[2].raw).toBe('080-1111-2222');
  });

  it('ハイフンなしの携帯電話番号も抽出すること', () => {
    const text = '連絡先 09012345678 です';
    const result = extractPhoneNumbers(text);
    expect(result).toHaveLength(1);
    expect(result[0].raw).toBe('09012345678');
    expect(result[0].normalized).toBe('09012345678');
  });

  it('電話番号が含まれない場合は空配列を返すこと', () => {
    const text = '本日の予定：10時より算数の授業参観。持ち物：上履き、筆記用具。';
    const result = extractPhoneNumbers(text);
    expect(result).toHaveLength(0);
  });
});
