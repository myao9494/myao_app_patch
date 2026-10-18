/**
 * 検索機能のテスト
 * 期待動作:
 * - 半角スペース区切りでOR検索
 * - 部分一致
 * - 大文字・小文字を区別しない
 * - 空クエリの場合は全件返却
 */
import { describe, it, expect } from 'vitest'
import { searchRecipients, splitSearchKeywords } from './search'
import type { Recipient } from '../types'

const testRecipients: Recipient[] = [
  { name: '山田 太郎', count: 120 },
  { name: '山田 花子', count: 85 },
  { name: '佐藤 一郎', count: 200 },
  { name: '佐藤 次郎', count: 60 },
  { name: '鈴木 恒一', count: 150 },
  { name: '鈴木 恒一（開発）', count: 40 },
  { name: '高橋 真紀', count: 95 },
  { name: 'John Smith', count: 30 },
]

describe('searchRecipients', () => {
  it('空クエリの場合は全件返却', () => {
    const result = searchRecipients(testRecipients, '')

    expect(result).toHaveLength(testRecipients.length)
  })

  it('スペースのみのクエリも全件返却', () => {
    const result = searchRecipients(testRecipients, '   ')

    expect(result).toHaveLength(testRecipients.length)
  })

  it('単一キーワードで部分一致検索', () => {
    const result = searchRecipients(testRecipients, '山田')

    expect(result).toHaveLength(2)
    expect(result.every(r => r.name.includes('山田'))).toBe(true)
  })

  it('半角スペース区切りでOR検索', () => {
    const result = searchRecipients(testRecipients, '山田 鈴木')

    expect(result).toHaveLength(4) // 山田2人 + 鈴木2人
  })

  it('大文字・小文字を区別しない', () => {
    const result = searchRecipients(testRecipients, 'john')

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('John Smith')
  })

  it('全角・半角を含む検索', () => {
    const result = searchRecipients(testRecipients, '開発')

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('鈴木 恒一（開発）')
  })

  it('マッチしない場合は空配列', () => {
    const result = searchRecipients(testRecipients, '存在しない名前')

    expect(result).toHaveLength(0)
  })

  it('複数キーワードで一部のみマッチ', () => {
    const result = searchRecipients(testRecipients, '高橋 存在しない')

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('高橋 真紀')
  })

  it('半角カンマ、全角読点、半角読点区切りでOR検索', () => {
    const resultComma = searchRecipients(testRecipients, '山田,佐藤')
    expect(resultComma).toHaveLength(4) // 山田2人 + 佐藤2人

    const resultTouten = searchRecipients(testRecipients, '山田、鈴木')
    expect(resultTouten).toHaveLength(4) // 山田2人 + 鈴木2人

    const resultHalfTouten = searchRecipients(testRecipients, '高橋､佐藤')
    expect(resultHalfTouten).toHaveLength(3) // 高橋1人 + 佐藤2人
  })
})

describe('splitSearchKeywords', () => {
  it('スペース・全角スペース・カンマ・読点で分割し、空要素を除く', () => {
    expect(splitSearchKeywords('山田 佐藤\u3000鈴木,高橋、John､Smith')).toEqual(['山田', '佐藤', '鈴木', '高橋', 'John', 'Smith'])
  })

  it('空や区切りだけの入力は空配列', () => {
    expect(splitSearchKeywords('')).toEqual([])
    expect(splitSearchKeywords(' ,、 ')).toEqual([])
  })
})
