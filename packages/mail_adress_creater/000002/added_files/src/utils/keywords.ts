/**
 * 職アドチェックのキーワード入力テキストの変換
 */

/** 設定画面の入力欄に表示するカンマ区切りテキストへ変換する */
export function formatKeywordText(keywords: string[]): string {
  return keywords.join(',')
}

/** 入力欄のテキストをキーワード配列へ変換する。カンマ・読点・改行区切りを受け付ける */
export function parseKeywordText(text: string): string[] {
  return text.split(/[,\n\r、]+/).map(keyword => keyword.trim()).filter(Boolean)
}
