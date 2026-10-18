/**
 * バックエンドAPIユーティリティのテスト
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addFavorite, addSchedule, checkKeywords, parseSchedule, refreshAddresses, deleteDatabaseRecords, loadDatabase, loadFavorites, loadSettings, saveFavorites, saveSettings, seedDummyData, loadUnconfirmedMatches, confirmMatches } from './api'

describe('api utilities', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('設定を読み込む', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        keywords: ['棚卸'],
        address_interval_minutes: 43200,
        keyword_interval_minutes: 60,
      }),
    }))

    await expect(loadSettings()).resolves.toEqual({
      keywords: ['棚卸'],
      address_interval_minutes: 43200,
      keyword_interval_minutes: 60,
    })
  })

  it('設定を保存する', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        keywords: ['ユーザID'],
        address_interval_minutes: 10,
        keyword_interval_minutes: 20,
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await saveSettings({
      keywords: ['ユーザID'],
      address_interval_minutes: 10,
      keyword_interval_minutes: 20,
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({
        keywords: ['ユーザID'],
        address_interval_minutes: 10,
        keyword_interval_minutes: 20,
      }),
    }))
  })

  it('APIエラーを例外として返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Outlook連携エラー' }),
    }))

    await expect(checkKeywords()).rejects.toThrow('Outlook連携エラー')
  })

  it('DBスナップショットを読み込む', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        settings: [],
        recipients: [{ name: '山田 太郎', count: 12, updated_at: '2026-05-14T00:00:00+00:00' }],
        favorites: [],
        keyword_matches: [],
        job_runs: [],
      }),
    }))

    await expect(loadDatabase()).resolves.toEqual(expect.objectContaining({
      recipients: [expect.objectContaining({ name: '山田 太郎', count: 12 })],
    }))
  })

  it('ダミーデータ投入APIを呼び出す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        inserted: { recipients: 4, keyword_matches: 3, job_runs: 2 },
        database: { settings: [], recipients: [], favorites: [], keyword_matches: [], job_runs: [] },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await seedDummyData()

    expect(fetchMock).toHaveBeenCalledWith('/api/seed-dummy-data', expect.objectContaining({
      method: 'POST',
    }))
  })

  it('選択したDBレコード削除APIを呼び出す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        result: { table: 'recipients', deleted: 1 },
        database: { settings: [], recipients: [], favorites: [], keyword_matches: [], job_runs: [] },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await deleteDatabaseRecords('recipients', ['山田 太郎'])

    expect(fetchMock).toHaveBeenCalledWith('/api/database/delete', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ table: 'recipients', keys: ['山田 太郎'] }),
    }))
  })

  it('お気に入りを読み込む', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        favorites: [{ name: '開発チーム', addresses: ['山田 太郎'], cc_addresses: ['鈴木 三郎'], updated_at: '2026-05-14T00:00:00+00:00' }],
      }),
    }))

    await expect(loadFavorites()).resolves.toEqual({
      favorites: [expect.objectContaining({ name: '開発チーム', addresses: ['山田 太郎'], cc_addresses: ['鈴木 三郎'] })],
    })
  })

  it('お気に入り保存APIを呼び出す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ favorites: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await saveFavorites([{ name: '開発チーム', addresses: ['山田 太郎'], cc_addresses: ['鈴木 三郎'] }])

    expect(fetchMock).toHaveBeenCalledWith('/api/favorites', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ favorites: [{ name: '開発チーム', addresses: ['山田 太郎'], cc_addresses: ['鈴木 三郎'] }] }),
    }))
  })

  it('お気に入り追加APIを呼び出す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        favorite: { name: '開発チーム', addresses: ['山田 太郎'], cc_addresses: ['鈴木 三郎'] },
        favorites: [{ name: '開発チーム', addresses: ['山田 太郎'], cc_addresses: ['鈴木 三郎'] }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await addFavorite('開発チーム', ['山田 太郎'], ['鈴木 三郎'])

    expect(fetchMock).toHaveBeenCalledWith('/api/favorites/add', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: '開発チーム', addresses: ['山田 太郎'], cc_addresses: ['鈴木 三郎'] }),
    }))
  })

  it('未確認の職アド通知を読み込む', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        matches: [{ received_time: '2026-05-18T10:00:00', subject: '職アドからのお知らせ', line: 'テスト', keyword: '棚卸', is_new: false, id: 1, confirmed: false }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(loadUnconfirmedMatches()).resolves.toEqual({
      matches: [expect.objectContaining({ id: 1, confirmed: false })],
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/keyword-matches?unconfirmed=1', expect.any(Object))
  })

  it('職アド通知を確認済みにする', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ updated: 1 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(confirmMatches([1])).resolves.toEqual({ updated: 1 })
    expect(fetchMock).toHaveBeenCalledWith('/api/keyword-matches/confirm', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ ids: [1] }),
    }))
  })

  it('Content-Typeを保ったまま、メソッドとボディをfetchへ渡す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ updated: 1 }) })
    vi.stubGlobal('fetch', fetchMock)

    await confirmMatches([1])

    expect(fetchMock).toHaveBeenCalledWith('/api/keyword-matches/confirm', {
      method: 'POST',
      body: JSON.stringify({ ids: [1] }),
      headers: { 'Content-Type': 'application/json' },
    })
  })

  it('バックエンドのエラーメッセージを例外として投げる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: '予定内容を入力してください' }),
    }))

    await expect(loadSettings()).rejects.toThrow('予定内容を入力してください')
  })

  it('エラー本文がJSONでなくても既定のメッセージで例外にする', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.reject(new Error('not json')),
    }))

    await expect(loadSettings()).rejects.toThrow('バックエンド処理に失敗しました')
  })

  it.each([
    ['アドレス再取得', () => refreshAddresses(), '/api/refresh-addresses', { limit: 150 }],
    ['予定解析', () => parseSchedule('明日 会議'), '/api/parse-schedule', { text: '明日 会議' }],
  ])('%s は対応するエンドポイントへPOSTする', async (_name, call, path, body) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    vi.stubGlobal('fetch', fetchMock)

    await call()

    expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }))
  })

  it('予定追加は入力文と編集済みの予定を送る', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ saved: true }) })
    vi.stubGlobal('fetch', fetchMock)
    const event = {
      start: '2026-05-20T15:00+09:00', end: '2026-05-20T16:00+09:00', subject: '会議', location: '',
      body: '', all_day: false, duration_minutes: 60, normalized_text: '会議',
    }

    await addSchedule('会議', event)

    expect(fetchMock).toHaveBeenCalledWith('/api/add-schedule', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ text: '会議', event }),
    }))
  })
})
