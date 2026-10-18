/**
 * CSVファイルをパースして送信先データを取得するユーティリティ
 */
import type { Recipient } from '../types'

/**
 * CSV文字列をパースしてRecipient配列を返す
 * @param csvText CSV形式の文字列
 * @returns パースされたRecipient配列（回数の降順でソート済み）
 */
export function parseCSV(csvText: string): Recipient[] {
  const rows = parseCsvRows(csvText.replace(/^\uFEFF/, ''))
  // 同じ名前の行（手で編集したCSVなど）は回数を合計する。画面では名前をキーにしているため重複させない
  const countsByName = new Map<string, number>()

  // ヘッダー行をスキップして2行目から処理
  for (let i = 1; i < rows.length; i++) {
    const [nameRaw, countRaw] = rows[i]
    const name = nameRaw?.trim()
    const count = parseCount(countRaw)

    if (name && count !== null) {
      countsByName.set(name, (countsByName.get(name) ?? 0) + count)
    }
  }

  // 回数の降順でソート
  return Array.from(countsByName, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
}

function parseCount(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? ''
  if (!/^\d+$/.test(trimmed)) {
    return null
  }
  return Number.parseInt(trimmed, 10)
}

function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  const pushField = () => {
    row.push(field)
    field = ''
  }

  const pushRow = () => {
    if (row.length > 0 || field.length > 0) {
      pushField()
      rows.push(row)
      row = []
    }
  }

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index]

    if (inQuotes) {
      if (char === '"' && csvText[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') {
        inQuotes = false
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      pushField()
    } else if (char === '\n') {
      pushRow()
    } else if (char !== '\r') {
      field += char
    }
  }

  pushRow()
  return rows
}

/**
 * public/send_mail-ranking_tabulator.csvを読み込む
 * @returns パースされたRecipient配列
 */
export async function loadRecipients(): Promise<Recipient[]> {
  const response = await fetch('/send_mail-ranking_tabulator.csv', { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`CSVの読み込みに失敗しました (${response.status})`)
  }
  const csvText = await response.text()
  return parseCSV(csvText)
}
