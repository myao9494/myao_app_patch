/**
 * 注記のテキストスタイル設定（文字サイズ・文字色）定義およびユーティリティ
 * 
 * 1. フォントサイズプリセット（small: 12px, medium: 14px, large: 18px, xlarge: 24px）
 * 2. 視認性の高い文字色プリセット（黒、白、赤、緑、青、橙、黄など）
 * 3. CSS値の解決ヘルパー関数（getEffectiveFontSize, getEffectiveTextColor）
 **/

export interface FontSizeOption {
  key: string;
  label: string;
  cssSize: string;
}

export const FONT_SIZE_OPTIONS: FontSizeOption[] = [
  { key: "small", label: "S (小)", cssSize: "12px" },
  { key: "medium", label: "M (中)", cssSize: "14px" },
  { key: "large", label: "L (大)", cssSize: "18px" },
  { key: "xlarge", label: "XL (特大)", cssSize: "24px" },
];

export interface TextColorOption {
  color: string;
  label: string;
}

export const TEXT_COLOR_OPTIONS: TextColorOption[] = [
  { color: "#000000", label: "黒 (Black)" },
  { color: "#ffffff", label: "白 (White)" },
  { color: "#e5484d", label: "赤 (Red)" },
  { color: "#30a46c", label: "緑 (Green)" },
  { color: "#3b82f6", label: "青 (Blue)" },
  { color: "#f76808", label: "橙 (Orange)" },
  { color: "#ffc531", label: "黄 (Yellow)" },
];

/**
 * 設定されたfontSizeから実際のCSSフォントサイズ（例: "14px"）を解決する
 */
export function getEffectiveFontSize(fontSize?: string | number): string {
  if (fontSize === undefined || fontSize === null || fontSize === "") return "14px";
  if (typeof fontSize === "number") return `${fontSize}px`;
  const found = FONT_SIZE_OPTIONS.find((o) => o.key === fontSize);
  if (found) return found.cssSize;
  // 直接 "16px" などのCSS単位が指定されている場合
  return fontSize;
}

/**
 * 設定されたtextColorから有効な文字色を解決する
 */
export function getEffectiveTextColor(textColor?: string): string | undefined {
  if (!textColor || !textColor.trim()) return undefined;
  return textColor.trim();
}
