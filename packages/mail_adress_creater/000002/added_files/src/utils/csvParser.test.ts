/**
 * CSVパーサーのテスト
 * 期待動作:
 * - CSV文字列をパースしてRecipient配列を返す
 * - 回数の降順でソートされる
 * - ヘッダー行はスキップされる
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { loadRecipients, parseCSV } from './csvParser'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseCSV', () => {
  it('CSV文字列をパースしてRecipient配列を返す', () => {
    const csvText = `名前,回数
山田 太郎,120
佐藤 一郎,200`

    const result = parseCSV(csvText)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ name: '佐藤 一郎', count: 200 })
    expect(result[1]).toEqual({ name: '山田 太郎', count: 120 })
  })

  it('回数の降順でソートされる', () => {
    const csvText = `名前,回数
伊藤 健,30
佐藤 一郎,200
山田 太郎,120`

    const result = parseCSV(csvText)

    expect(result[0].count).toBe(200)
    expect(result[1].count).toBe(120)
    expect(result[2].count).toBe(30)
  })

  it('空のCSVは空配列を返す', () => {
    const csvText = `名前,回数`

    const result = parseCSV(csvText)

    expect(result).toHaveLength(0)
  })

  it('括弧付きの名前も正しくパースする', () => {
    const csvText = `名前,回数
鈴木 恒一（開発）,40`

    const result = parseCSV(csvText)

    expect(result[0].name).toBe('鈴木 恒一（開発）')
  })

  it('空行は無視される', () => {
    const csvText = `名前,回数
山田 太郎,120

佐藤 一郎,200
`

    const result = parseCSV(csvText)

    expect(result).toHaveLength(2)
  })

  it('カンマを含む引用済みの名前を正しくパースする', () => {
    const csvText = `名前,回数
"Smith, John",3
山田 太郎,120`

    const result = parseCSV(csvText)

    expect(result).toContainEqual({ name: 'Smith, John', count: 3 })
    expect(result).toContainEqual({ name: '山田 太郎', count: 120 })
  })

  it('回数が数値ではない行は除外する', () => {
    const csvText = `名前,回数
山田 太郎,12abc
佐藤 一郎,200`

    const result = parseCSV(csvText)

    expect(result).toEqual([{ name: '佐藤 一郎', count: 200 }])
  })

  it('CSV取得が失敗した場合は例外を返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('not found'),
    }))

    await expect(loadRecipients()).rejects.toThrow('CSVの読み込みに失敗しました (404)')
  })

  it('同じ名前の行が複数ある場合は、回数を合計して1件にまとめる', () => {
    const csv = '名前,回数\n山田 太郎,3\n佐藤 一郎,1\n山田 太郎,2\n'

    const result = parseCSV(csv)

    expect(result).toEqual([
      { name: '山田 太郎', count: 5 },
      { name: '佐藤 一郎', count: 1 },
    ])
  })
})
