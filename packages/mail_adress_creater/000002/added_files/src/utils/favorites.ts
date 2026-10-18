/**
 * お気に入り（宛先グループ）に関するユーティリティ
 */
import type { Favorite } from './api'
import type { Recipient } from '../types'

/** 検索結果でお気に入りを示す接頭辞 */
export const FAVORITE_PREFIX = '★ '

/** 表示名の「★ 」接頭辞を取り除く */
export function stripFavoritePrefix(name: string): string {
  return name.replace(/^★\s*/, '')
}

/** 編集用テキスト（1行1宛先）へ変換する */
export function formatFavoriteAddressText(addresses: string[]): string {
  return addresses.join('\n')
}

/** 編集用テキストを宛先配列へ変換する。改行・セミコロン・読点・カンマ区切りを受け付ける */
export function parseFavoriteAddressText(text: string): string[] {
  return text.split(/[\n\r;、,]+/).map(address => address.trim()).filter(Boolean)
}

/**
 * お気に入り名をコピー対象の宛先名へ展開する
 * 宛先に別のお気に入り名が含まれていれば再帰的に展開し、循環参照は展開せず名前のまま残す
 */
export function expandFavoriteAddresses(
  name: string,
  favoriteMap: Map<string, string[]>,
  expandingNames: ReadonlySet<string> = new Set(),
): string[] {
  const normalizedName = stripFavoritePrefix(name).trim()
  const addresses = favoriteMap.get(normalizedName)
  if (!addresses) {
    return [name]
  }
  if (expandingNames.has(normalizedName)) {
    return [normalizedName]
  }

  const nextExpandingNames = new Set(expandingNames).add(normalizedName)
  return addresses.flatMap(address => expandFavoriteAddresses(address, favoriteMap, nextExpandingNames))
}

/**
 * 検索対象の一覧（お気に入りを先頭に、その後に通常の宛先）を作る
 * @param field 宛先ペインなら 'addresses'、CCペインなら 'cc_addresses'
 */
export function buildSearchableRecipients(
  favorites: Favorite[],
  recipients: Recipient[],
  field: 'addresses' | 'cc_addresses',
): Recipient[] {
  const listOf = (favorite: Favorite) => favorite[field] ?? []
  const favoriteMap = new Map(favorites.map(favorite => [favorite.name, listOf(favorite)]))
  return [
    ...favorites.map(favorite => ({
      name: `${FAVORITE_PREFIX}${favorite.name}`,
      count: listOf(favorite).length,
      copyNames: expandFavoriteAddresses(favorite.name, favoriteMap),
      favorite: true,
    })),
    ...recipients,
  ]
}
