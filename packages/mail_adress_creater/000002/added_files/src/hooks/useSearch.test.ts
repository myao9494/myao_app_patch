/**
 * useSearchフックのテスト
 * 検索実行、チェック状態のマージ、お気に入り適用中の表示ルールを確認する
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSearch } from './useSearch'
import type { Recipient } from '../types'

const recipients: Recipient[] = [
  { name: '山田 太郎', count: 10 },
  { name: '山田 花子', count: 8 },
  { name: '佐藤 一郎', count: 5 },
  { name: '鈴木 恒一', count: 1 },
]

const names = (rows: Array<{ name: string }>) => rows.map(row => row.name)

function setup() {
  return renderHook(() => useSearch(recipients))
}

describe('useSearch 通常時', () => {
  it('検索前は全件が未チェックで並ぶ', () => {
    const { result } = setup()

    expect(names(result.current.results)).toEqual(names(recipients))
    expect(result.current.results.every(row => !row.checked)).toBe(true)
    expect(result.current.getCheckedNames()).toEqual([])
  })

  it('入力しただけでは絞り込まれず、executeSearch で絞り込みとチェックが行われる', () => {
    const { result } = setup()

    act(() => result.current.setQuery('山田'))
    expect(result.current.results).toHaveLength(4)

    act(() => result.current.executeSearch())
    expect(names(result.current.results)).toEqual(['山田 太郎', '山田 花子'])
    expect(result.current.getCheckedNames()).toEqual(['山田 太郎', '山田 花子'])
  })

  it('別のキーワードで再検索しても、以前のチェックは維持されたまま追加される', () => {
    const { result } = setup()
    act(() => result.current.setQuery('山田'))
    act(() => result.current.executeSearch())
    act(() => result.current.setQuery('佐藤'))
    act(() => result.current.executeSearch())

    expect(names(result.current.results)).toEqual(['佐藤 一郎'])
    act(() => result.current.setQuery(''))
    act(() => result.current.executeSearch())
    const checked = result.current.results.filter(row => row.checked).map(row => row.name)
    expect(checked).toEqual(names(recipients))
  })

  it('toggleCheck でチェックを付け外しできる', () => {
    const { result } = setup()

    act(() => result.current.toggleCheck('佐藤 一郎'))
    expect(result.current.getCheckedNames()).toEqual(['佐藤 一郎'])

    act(() => result.current.toggleCheck('佐藤 一郎'))
    expect(result.current.getCheckedNames()).toEqual([])
  })

  it('getCheckedNames は画面に表示中の結果だけを返す', () => {
    const { result } = setup()
    act(() => result.current.toggleCheck('鈴木 恒一'))
    act(() => result.current.setQuery('山田'))
    act(() => result.current.executeSearch())

    expect(result.current.getCheckedNames()).toEqual(['山田 太郎', '山田 花子'])
  })

  it('どの宛先にも一致しなかったキーワードを unmatchedKeywords で返す', () => {
    const { result } = setup()

    act(() => result.current.setQuery('山田, 存在しない 、John'))
    act(() => result.current.executeSearch())

    expect(result.current.unmatchedKeywords).toEqual(['存在しない', 'John'])
  })

  it('検索を実行するまで unmatchedKeywords は空', () => {
    const { result } = setup()

    act(() => result.current.setQuery('存在しない'))

    expect(result.current.unmatchedKeywords).toEqual([])
  })
})

describe('useSearch お気に入り適用中', () => {
  it('検索せずに適用すると、チェック済みの宛先だけが表示される', () => {
    const { result } = setup()

    act(() => result.current.setQueryAndChecked('', ['鈴木 恒一', '山田 太郎'], '開発'))

    expect(result.current.appliedFavoriteName).toBe('開発')
    expect(names(result.current.results)).toEqual(['山田 太郎', '鈴木 恒一'])
    expect(result.current.results.every(row => row.checked)).toBe(true)
  })

  it('履歴に無い宛先（アドレス直書き）も回数0で表示される', () => {
    const { result } = setup()

    act(() => result.current.setQueryAndChecked('', ['山田 太郎', 'new@example.com'], '開発'))

    expect(result.current.results).toEqual([
      { name: '山田 太郎', count: 10, checked: true },
      { name: 'new@example.com', count: 0, checked: true },
    ])
  })

  it('適用後にさらに検索すると、検索結果の後ろにお気に入りのチェック済みメンバーが続く', () => {
    const { result } = setup()
    act(() => result.current.setQueryAndChecked('', ['鈴木 恒一', 'new@example.com'], '開発'))

    act(() => result.current.setQuery('佐藤'))
    act(() => result.current.executeSearch())

    expect(names(result.current.results)).toEqual(['佐藤 一郎', '鈴木 恒一', 'new@example.com'])
    expect(result.current.results.map(row => row.checked)).toEqual([true, true, true])
  })

  it('検索結果に含まれるお気に入りメンバーは重複して表示されない', () => {
    const { result } = setup()
    act(() => result.current.setQueryAndChecked('', ['山田 太郎'], '開発'))

    act(() => result.current.setQuery('山田'))
    act(() => result.current.executeSearch())

    expect(names(result.current.results)).toEqual(['山田 太郎', '山田 花子'])
  })

  it('適用を解除すると通常の全件表示に戻り、チェック状態は残る', () => {
    const { result } = setup()
    act(() => result.current.setQueryAndChecked('', ['山田 太郎'], '開発'))

    act(() => result.current.setAppliedFavoriteName(null))

    expect(names(result.current.results)).toEqual(names(recipients))
    expect(result.current.getCheckedNames()).toEqual(['山田 太郎'])
  })

  it('setQueryAndChecked は以前のチェックを置き換える', () => {
    const { result } = setup()
    act(() => result.current.toggleCheck('佐藤 一郎'))

    act(() => result.current.setQueryAndChecked('', ['山田 花子'], '開発'))

    expect(result.current.getCheckedNames()).toEqual(['山田 花子'])
  })
})
