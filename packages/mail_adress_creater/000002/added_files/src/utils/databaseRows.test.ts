/**
 * DB行キーのテスト
 */
import { describe, it, expect } from 'vitest'
import { getDatabaseRowKey } from './databaseRows'

describe('getDatabaseRowKey', () => {
  it('テーブルごとの主キーを文字列で返す', () => {
    expect(getDatabaseRowKey('keyword_matches', { id: 42, line: 'x' })).toBe('42')
    expect(getDatabaseRowKey('recipients', { name: '山田 太郎', count: 1 })).toBe('山田 太郎')
    expect(getDatabaseRowKey('favorites', { name: '開発' })).toBe('開発')
    expect(getDatabaseRowKey('job_runs', { job_name: 'refresh_addresses' })).toBe('refresh_addresses')
    expect(getDatabaseRowKey('settings', { key: 'keywords', value: '[]' })).toBe('keywords')
  })
})
