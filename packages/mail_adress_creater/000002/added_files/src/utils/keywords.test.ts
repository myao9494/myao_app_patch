/**
 * キーワード入力テキスト変換のテスト
 */
import { describe, it, expect } from 'vitest'
import { formatKeywordText, parseKeywordText } from './keywords'

describe('キーワード入力テキスト', () => {
  it('カンマ・読点・改行で分割し、前後の空白と空要素を取り除く', () => {
    expect(parseKeywordText(' 棚卸 ,棚おろし、ユーザID\n-除外,, ')).toEqual(['棚卸', '棚おろし', 'ユーザID', '-除外'])
  })

  it('整形して解析すると元に戻る', () => {
    const keywords = ['棚卸', '-除外']

    expect(parseKeywordText(formatKeywordText(keywords))).toEqual(keywords)
  })

  it('空文字は空配列', () => {
    expect(parseKeywordText('')).toEqual([])
  })
})
