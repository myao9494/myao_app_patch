/**
 * useRecipientsフックのテスト
 * 初回読み込みと再読み込み時の状態遷移を確認する
 **/
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useRecipients } from './useRecipients'
import { loadRecipients } from '../utils/csvParser'

vi.mock('../utils/csvParser', () => ({
  loadRecipients: vi.fn(),
}))

const first = [{ name: '山田 太郎', count: 3 }]
const second = [{ name: '山田 太郎', count: 3 }, { name: '佐藤 一郎', count: 1 }]

describe('useRecipients', () => {
  beforeEach(() => {
    vi.mocked(loadRecipients).mockReset()
  })

  it('初回読み込み中はloadingがtrueで、完了後にデータが入る', async () => {
    vi.mocked(loadRecipients).mockResolvedValue(first)

    const { result } = renderHook(() => useRecipients())
    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.recipients).toEqual(first)
    expect(result.current.error).toBeNull()
  })

  it('初回読み込みに失敗するとerrorにメッセージが入る', async () => {
    vi.mocked(loadRecipients).mockRejectedValue(new Error('CSVの読み込みに失敗しました (404)'))

    const { result } = renderHook(() => useRecipients())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('CSVの読み込みに失敗しました (404)')
  })

  it('再読み込み中もloadingはfalseのままで、既存データを保持し、完了後に更新される', async () => {
    vi.mocked(loadRecipients).mockResolvedValueOnce(first)
    const { result } = renderHook(() => useRecipients())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let resolveReload: (value: typeof second) => void = () => {}
    vi.mocked(loadRecipients).mockReturnValueOnce(new Promise(resolve => { resolveReload = resolve }))

    let reloadPromise: Promise<void> = Promise.resolve()
    act(() => { reloadPromise = result.current.reload() })

    expect(result.current.loading).toBe(false)
    expect(result.current.recipients).toEqual(first)

    await act(async () => {
      resolveReload(second)
      await reloadPromise
    })
    expect(result.current.recipients).toEqual(second)
  })

  it('再読み込みに失敗しても既存データと画面を維持し、呼び出し元へエラーを伝える', async () => {
    vi.mocked(loadRecipients).mockResolvedValueOnce(first)
    const { result } = renderHook(() => useRecipients())
    await waitFor(() => expect(result.current.loading).toBe(false))

    vi.mocked(loadRecipients).mockRejectedValueOnce(new Error('network'))
    await act(async () => {
      await expect(result.current.reload()).rejects.toThrow('network')
    })

    expect(result.current.recipients).toEqual(first)
    expect(result.current.error).toBeNull()
  })

  it('reloadの関数参照は再レンダリングで変わらない', async () => {
    vi.mocked(loadRecipients).mockResolvedValue(first)
    const { result, rerender } = renderHook(() => useRecipients())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const reload = result.current.reload

    rerender()

    expect(result.current.reload).toBe(reload)
  })
})
