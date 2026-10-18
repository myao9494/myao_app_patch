/**
 * useDatabaseViewerフックのテスト
 * 閲覧・選択削除・ダミーデータ投入の確認ダイアログと、削除後の同期を確認する
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDatabaseViewer } from './useDatabaseViewer'
import { useTestOperations } from '../test/operations'
import { deleteDatabaseRecords, loadDatabase, seedDummyData, type DatabaseSnapshot } from '../utils/api'

vi.mock('../utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/api')>()),
  loadDatabase: vi.fn(),
  deleteDatabaseRecords: vi.fn(),
  seedDummyData: vi.fn(),
}))

const snapshot = (favorites: DatabaseSnapshot['favorites'] = []): DatabaseSnapshot => ({
  settings: [],
  recipients: [],
  favorites,
  keyword_matches: [],
  job_runs: [],
})

function setup() {
  const reloadRecipients = vi.fn().mockResolvedValue(undefined)
  const onFavoritesChanged = vi.fn()
  const hook = renderHook(() => {
    const ops = useTestOperations()
    return { ...ops, viewer: useDatabaseViewer(ops.operations, { reloadRecipients, onFavoritesChanged }) }
  })
  return { ...hook, reloadRecipients, onFavoritesChanged }
}

describe('useDatabaseViewer', () => {
  beforeEach(() => {
    vi.mocked(loadDatabase).mockReset()
    vi.mocked(deleteDatabaseRecords).mockReset()
    vi.mocked(seedDummyData).mockReset()
  })
  afterEach(() => vi.restoreAllMocks())

  it('読み込むと開き、テーブルを切り替えると選択をクリアする', async () => {
    vi.mocked(loadDatabase).mockResolvedValue(snapshot())
    const { result } = setup()

    await act(() => result.current.viewer.load())
    act(() => result.current.viewer.setSelectedKeys(['1']))
    act(() => result.current.viewer.selectTable('recipients'))

    expect(result.current.viewer.open).toBe(true)
    expect(result.current.viewer.table).toBe('recipients')
    expect(result.current.viewer.selectedKeys).toEqual([])
  })

  it('選択が無い、またはsettingsテーブルのときは削除しない', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { result } = setup()

    await act(() => result.current.viewer.deleteSelected())
    act(() => result.current.viewer.selectTable('settings'))
    act(() => result.current.viewer.setSelectedKeys(['keywords']))
    await act(() => result.current.viewer.deleteSelected())

    expect(confirm).not.toHaveBeenCalled()
    expect(deleteDatabaseRecords).not.toHaveBeenCalled()
  })

  it('削除の確認でキャンセルしたら何もしない', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { result } = setup()
    act(() => result.current.viewer.selectTable('recipients'))
    act(() => result.current.viewer.setSelectedKeys(['山田']))

    await act(() => result.current.viewer.deleteSelected())

    expect(deleteDatabaseRecords).not.toHaveBeenCalled()
  })

  it('宛先を削除すると結果を反映し、宛先一覧を再読み込みする', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(deleteDatabaseRecords).mockResolvedValue({ result: { table: 'recipients', deleted: 1 }, database: snapshot() })
    const { result, reloadRecipients, onFavoritesChanged } = setup()
    act(() => result.current.viewer.selectTable('recipients'))
    act(() => result.current.viewer.setSelectedKeys(['山田']))

    await act(() => result.current.viewer.deleteSelected())

    expect(deleteDatabaseRecords).toHaveBeenCalledWith('recipients', ['山田'])
    expect(reloadRecipients).toHaveBeenCalled()
    expect(onFavoritesChanged).not.toHaveBeenCalled()
    expect(result.current.showToast).toHaveBeenCalledWith('1件を削除しました')
  })

  it('お気に入りを削除すると、画面のお気に入り一覧へ同期する', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const remaining = [{ name: '営業', addresses: ['高橋'], cc_addresses: [], updated_at: '' }]
    vi.mocked(deleteDatabaseRecords).mockResolvedValue({ result: { table: 'favorites', deleted: 1 }, database: snapshot(remaining) })
    const { result, onFavoritesChanged } = setup()
    act(() => result.current.viewer.selectTable('favorites'))
    act(() => result.current.viewer.setSelectedKeys(['開発']))

    await act(() => result.current.viewer.deleteSelected())

    expect(onFavoritesChanged).toHaveBeenCalledWith(remaining)
  })

  it('ダミーデータ投入は確認でキャンセルされたら実行しない', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { result } = setup()

    await act(() => result.current.viewer.seedDummy())

    expect(seedDummyData).not.toHaveBeenCalled()
  })

  it('ダミーデータ投入は確認OKなら実行し、宛先を再読み込みする', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(seedDummyData).mockResolvedValue({ inserted: { recipients: 4 }, database: snapshot() })
    const { result, reloadRecipients } = setup()

    await act(() => result.current.viewer.seedDummy())

    expect(reloadRecipients).toHaveBeenCalled()
    expect(result.current.viewer.open).toBe(true)
    expect(result.current.showToast).toHaveBeenCalledWith('ダミーデータを投入しました（宛先 4件）')
  })

  it('失敗したらエラーメッセージを表示する', async () => {
    vi.mocked(loadDatabase).mockRejectedValue(new Error('backend down'))
    const { result } = setup()

    await act(() => result.current.viewer.load())

    expect(result.current.operation.error).toBe('backend down')
    expect(result.current.viewer.open).toBe(false)
  })
})
