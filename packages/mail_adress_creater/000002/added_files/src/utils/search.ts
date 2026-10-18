/**
 * 送信先データを検索するユーティリティ
 */
import type { Recipient } from '../types'

/**
 * 検索クエリをキーワード配列へ分割する
 * 半角/全角スペース、カンマ（,）、読点（、、､）で区切り、空要素は除く
 */
export function splitSearchKeywords(query: string): string[] {
  return query.trim().split(/[\s\u3000,、､]+/).filter(keyword => keyword.length > 0)
}

/**
 * 検索クエリに基づいてRecipient配列をフィルタリングする
 * - 半角/全角スペース、カンマ（,）、読点（、、､）で区切ってOR検索
 * - 部分一致
 * - 大文字・小文字を区別しない
 * - 空クエリの場合は全件返却
 *
 * @param recipients 検索対象のRecipient配列
 * @param query 検索クエリ（スペース、カンマ、読点区切りでOR検索）
 * @returns フィルタリングされたRecipient配列
 */
export function searchRecipients(recipients: Recipient[], query: string): Recipient[] {
  const trimmedQuery = query.trim()

  // 空クエリの場合は全件返却
  if (!trimmedQuery) {
    return recipients
  }

  const keywords = splitSearchKeywords(trimmedQuery)

  // 各キーワードで部分一致（OR検索）
  return recipients.filter(recipient => {
    const nameLower = recipient.name.toLowerCase()
    return keywords.some(keyword => nameLower.includes(keyword.toLowerCase()))
  })
}
