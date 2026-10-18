/**
 * DB閲覧画面の行キー
 */
import type { DatabaseSnapshot } from './api'

/** 選択・削除APIに渡す行のキー（テーブルごとの主キー）。settingsは項目名 */
export function getDatabaseRowKey(table: keyof DatabaseSnapshot, row: Record<string, unknown>): string {
  switch (table) {
    case 'keyword_matches':
      return String(row.id)
    case 'recipients':
    case 'favorites':
      return String(row.name)
    case 'job_runs':
      return String(row.job_name)
    case 'settings':
      return String(row.key)
  }
}
