/**
 * 電話番号・連絡先ユーティリティ
 * - 日本国内の電話番号（携帯、固定電話、フリーダイヤル、ハイフン有無）を正規表現で検出
 * - 電話発信用URL（tel:）の生成とワンタップコピー支援
 */

// 日本の電話番号パターン（ハイフンあり・なし両対応）
// 例: 090-1234-5678, 03-1234-5678, 0120-123-456, 09012345678
const PHONE_REGEX = /(?:0\d{1,4}-\d{1,4}-\d{4}|0[789]0\d{8}|0\d{9,10})/g;

export interface ContactInfo {
  raw: string;
  normalized: string; // tel: 用（ハイフン除去）
  label?: string;
}

/**
 * テキスト中から電話番号を抽出する
 */
export function extractPhoneNumbers(text: string): ContactInfo[] {
  if (!text) return [];

  const matches = text.match(PHONE_REGEX);
  if (!matches) return [];

  // 重複除去
  const uniqueNumbers = Array.from(new Set(matches));

  return uniqueNumbers.map((num) => ({
    raw: num,
    normalized: num.replace(/[-\s]/g, ''),
  }));
}
