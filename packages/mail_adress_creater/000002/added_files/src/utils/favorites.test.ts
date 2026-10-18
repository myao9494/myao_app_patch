/**
 * お気に入りユーティリティのテスト
 */
import { describe, it, expect } from 'vitest'
import {
  buildSearchableRecipients,
  expandFavoriteAddresses,
  formatFavoriteAddressText,
  parseFavoriteAddressText,
  stripFavoritePrefix,
} from './favorites'
import type { Favorite } from './api'

describe('stripFavoritePrefix', () => {
  it('先頭の「★ 」だけを取り除く', () => {
    expect(stripFavoritePrefix('★ 開発チーム')).toBe('開発チーム')
    expect(stripFavoritePrefix('★開発チーム')).toBe('開発チーム')
    expect(stripFavoritePrefix('山田 ★ 太郎')).toBe('山田 ★ 太郎')
  })
})

describe('お気に入り編集テキスト', () => {
  it('改行・セミコロン・読点・カンマで分割し、空要素を捨てる', () => {
    expect(parseFavoriteAddressText('山田 太郎\n佐藤 一郎;鈴木、高橋,  \n\n')).toEqual(['山田 太郎', '佐藤 一郎', '鈴木', '高橋'])
  })

  it('整形して解析すると元の配列に戻る', () => {
    const addresses = ['a@example.com', '山田 太郎']

    expect(parseFavoriteAddressText(formatFavoriteAddressText(addresses))).toEqual(addresses)
  })
})

describe('expandFavoriteAddresses', () => {
  it('お気に入りでない名前はそのまま返す', () => {
    expect(expandFavoriteAddresses('山田 太郎', new Map())).toEqual(['山田 太郎'])
  })

  it('入れ子のお気に入りを再帰的に展開する', () => {
    const map = new Map([
      ['全体', ['営業', '鈴木']],
      ['営業', ['山田', '佐藤']],
    ])

    expect(expandFavoriteAddresses('全体', map)).toEqual(['山田', '佐藤', '鈴木'])
  })

  it('循環参照は無限ループせず名前のまま残す', () => {
    const map = new Map([
      ['A', ['B', '山田']],
      ['B', ['A']],
    ])

    expect(expandFavoriteAddresses('A', map)).toEqual(['A', '山田'])
  })

  it('★付きの名前も展開できる', () => {
    expect(expandFavoriteAddresses('★ A', new Map([['A', ['x']]]))).toEqual(['x'])
  })
})

describe('buildSearchableRecipients', () => {
  const favorites: Favorite[] = [
    { name: '開発', addresses: ['山田', '佐藤'], cc_addresses: ['鈴木'] },
    { name: '旧データ', addresses: ['高橋'] },
  ]
  const recipients = [{ name: '山田', count: 5 }]

  it('宛先ペイン用はTo側の宛先でお気に入りを先頭に並べる', () => {
    const result = buildSearchableRecipients(favorites, recipients, 'addresses')

    expect(result.map(r => r.name)).toEqual(['★ 開発', '★ 旧データ', '山田'])
    expect(result[0]).toMatchObject({ count: 2, copyNames: ['山田', '佐藤'], favorite: true })
  })

  it('CCペイン用はCC側の宛先を使い、cc_addresses が無い旧データは空として扱う', () => {
    const result = buildSearchableRecipients(favorites, recipients, 'cc_addresses')

    expect(result[0]).toMatchObject({ count: 1, copyNames: ['鈴木'] })
    expect(result[1]).toMatchObject({ count: 0, copyNames: [] })
  })
})
