/**
 * 検索機能とチェック状態を管理するカスタムフック
 */
import { useState, useMemo, useCallback } from 'react'
import type { Recipient, CheckableRecipient } from '../types'
import { searchRecipients, splitSearchKeywords } from '../utils/search'

type UseSearchReturn = {
  query: string
  setQuery: (query: string) => void
  results: CheckableRecipient[]
  unmatchedKeywords: string[]
  toggleCheck: (name: string) => void
  getCheckedNames: () => string[]
  executeSearch: () => void
  setQueryAndChecked: (query: string, checkedNames: string[], favoriteName?: string) => void
  appliedFavoriteName: string | null
  setAppliedFavoriteName: (name: string | null) => void
}

/**
 * 検索機能とチェック状態を管理する
 * @param recipients 検索対象のRecipient配列
 * @returns 検索クエリ、結果、チェック操作など
 */
export function useSearch(recipients: Recipient[]): UseSearchReturn {
  const [query, setQuery] = useState('')
  const [searchedQuery, setSearchedQuery] = useState('')
  const [checkedNames, setCheckedNames] = useState<Set<string>>(new Set())
  const [appliedFavoriteName, setAppliedFavoriteName] = useState<string | null>(null)

  // 検索実行（Enterキーで呼ばれる）
  const executeSearch = useCallback(() => {
    setSearchedQuery(query)
    // 検索実行時、既存のチェックされたメンバー（お気に入りなど）は維持したまま、
    // 検索で新しくヒットしたメンバーもチェックONとして追加（マージ）する
    const searchResults = searchRecipients(recipients, query)
    setCheckedNames(prev => {
      const newSet = new Set(prev)
      searchResults.forEach(r => newSet.add(r.name))
      return newSet
    })
  }, [query, recipients])

  // 検索結果（検索実行後のクエリで絞り込み）
  // お気に入り適用中は、検索で見つかった宛先の後ろに、チェック済みのお気に入りメンバーも続けて表示する。
  // 適用直後（検索語が空）は、チェック済みのメンバーだけを表示する。
  const results: CheckableRecipient[] = useMemo(() => {
    const showOnlyChecked = appliedFavoriteName !== null && searchedQuery.trim() === ''
    const visible = showOnlyChecked ? [] : searchRecipients(recipients, searchedQuery)
    const rows: CheckableRecipient[] = visible.map(r => ({ ...r, checked: checkedNames.has(r.name) }))
    if (appliedFavoriteName === null) {
      return rows
    }

    const shownNames = new Set(visible.map(r => r.name))
    const knownNames = new Set(recipients.map(r => r.name))
    const checkedRecipients = recipients
      .filter(r => checkedNames.has(r.name) && !shownNames.has(r.name))
      .map(r => ({ ...r, checked: true }))
    // 送信履歴に無い宛先（アドレス直書きなど）は回数0として表示する
    const checkedOthers = Array.from(checkedNames)
      .filter(name => !knownNames.has(name))
      .map(name => ({ name, count: 0, checked: true }))
    return [...rows, ...checkedRecipients, ...checkedOthers]
  }, [recipients, searchedQuery, checkedNames, appliedFavoriteName])

  // マッチしなかったキーワードを計算
  const unmatchedKeywords: string[] = useMemo(() => {
    const keywords = splitSearchKeywords(searchedQuery)
    if (keywords.length === 0) return []
    const lowerNames = recipients.map(r => r.name.toLowerCase())
    return keywords.filter(keyword => {
      const keywordLower = keyword.toLowerCase()
      return !lowerNames.some(name => name.includes(keywordLower))
    })
  }, [searchedQuery, recipients])

  // チェック状態の切り替え
  const toggleCheck = useCallback((name: string) => {
    setCheckedNames(prev => {
      const newSet = new Set(prev)
      if (newSet.has(name)) {
        newSet.delete(name)
      } else {
        newSet.add(name)
      }
      return newSet
    })
  }, [])

  // チェックされた名前を取得
  const getCheckedNames = useCallback(() => {
    return results.filter(r => r.checked).map(r => r.name)
  }, [results])

  // クエリとチェック状態を同時にセットする
  const setQueryAndChecked = useCallback((newQuery: string, namesToCheck: string[], favoriteName?: string) => {
    setQuery(newQuery)
    setSearchedQuery(newQuery)
    setCheckedNames(new Set(namesToCheck))
    if (favoriteName !== undefined) {
      setAppliedFavoriteName(favoriteName)
    }
  }, [])

  return {
    query,
    setQuery,
    results,
    unmatchedKeywords,
    toggleCheck,
    getCheckedNames,
    executeSearch,
    setQueryAndChecked,
    appliedFavoriteName,
    setAppliedFavoriteName,
  }
}
