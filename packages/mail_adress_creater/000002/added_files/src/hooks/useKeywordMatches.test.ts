/**
 * useKeywordMatchesフックのテスト
 * 起動時の未確認通知の復元、チェック実行、確認ボタンの動作を確認する
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useKeywordMatches } from './useKeywordMatches'
import { useTestOperations } from '../test/operations'
import { checkKeywords, confirmMatches, loadUnconfirmedMatches, type KeywordMatch } from '../utils/api'

vi.mock('../utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/api')>()),
  checkKeywords: vi.fn(),
  confirmMatches: vi.fn(),
  loadUnconfirmedMatches: vi.fn(),
}))

const match = (id: number | undefined, line = '棚卸の通知'): KeywordMatch => ({
  id,
  received_time: '2026-05-18T10:00:00',
  subject: '職アドからのお知らせ',
  line,
  keyword: '棚卸',
  is_new: true,
})

function setup() {
  return renderHook(() => {
    const ops = useTestOperations()
    return { ...ops, keywords: useKeywordMatches(ops.operations) }
  })
}

describe('useKeywordMatches', () => {
  beforeEach(() => {
    vi.mocked(checkKeywords).mockReset()
    vi.mocked(confirmMatches).mockReset()
    vi.mocked(loadUnconfirmedMatches).mockReset().mockResolvedValue({ matches: [] })
  })

  it('起動時に未確認の通知を復元する', async () => {
    vi.mocked(loadUnconfirmedMatches).mockResolvedValue({ matches: [match(1)] })

    const { result } = setup()

    await waitFor(() => expect(result.current.keywords.matches).toHaveLength(1))
  })

  it('起動時の読み込みに失敗しても、エラーは表示しない', async () => {
    vi.mocked(loadUnconfirmedMatches).mockRejectedValue(new Error('backend down'))

    const { result } = setup()
    await act(async () => {})

    expect(result.current.keywords.matches).toEqual([])
    expect(result.current.operation.error).toBeNull()
  })

  it('チェックで新規一致があれば件数付きで通知し、一覧を差し替える', async () => {
    vi.mocked(checkKeywords).mockResolvedValue({ matches: [], new_matches: [match(2), match(3)], keywords: ['棚卸'] })
    const { result } = setup()

    await act(() => result.current.keywords.check())

    expect(result.current.keywords.matches).toHaveLength(2)
    expect(result.current.showToast).toHaveBeenCalledWith('新しい職アド通知が 2件あります')
  })

  it('新規一致が無ければ、その旨を通知する', async () => {
    vi.mocked(checkKeywords).mockResolvedValue({ matches: [], new_matches: [], keywords: ['棚卸'] })
    const { result } = setup()

    await act(() => result.current.keywords.check())

    expect(result.current.showToast).toHaveBeenCalledWith('新しい職アド通知はありません')
  })

  it('チェックに失敗するとエラーを表示し、実行中の状態を戻す', async () => {
    vi.mocked(checkKeywords).mockRejectedValue(new Error('Outlookに接続できません'))
    const { result } = setup()

    await act(() => result.current.keywords.check())

    expect(result.current.operation.error).toBe('Outlookに接続できません')
    expect(result.current.operation.runningAction).toBeNull()
  })

  it('確認ボタンはIDのある通知だけを確認済みにして、一覧を空にする', async () => {
    vi.mocked(loadUnconfirmedMatches).mockResolvedValue({ matches: [match(1), match(undefined), match(3)] })
    vi.mocked(confirmMatches).mockResolvedValue({ updated: 2 })
    const { result } = setup()
    await waitFor(() => expect(result.current.keywords.matches).toHaveLength(3))

    await act(() => result.current.keywords.confirm())

    expect(confirmMatches).toHaveBeenCalledWith([1, 3])
    expect(result.current.keywords.matches).toEqual([])
  })

  it('IDが1つも無い通知は、APIを呼ばずに一覧だけ空にする', async () => {
    vi.mocked(loadUnconfirmedMatches).mockResolvedValue({ matches: [match(undefined)] })
    const { result } = setup()
    await waitFor(() => expect(result.current.keywords.matches).toHaveLength(1))

    await act(() => result.current.keywords.confirm())

    expect(confirmMatches).not.toHaveBeenCalled()
    expect(result.current.keywords.matches).toEqual([])
  })

  it('確認に失敗した場合は通知を残し、エラーを表示する', async () => {
    vi.mocked(loadUnconfirmedMatches).mockResolvedValue({ matches: [match(1)] })
    vi.mocked(confirmMatches).mockRejectedValue(new Error('保存できません'))
    const { result } = setup()
    await waitFor(() => expect(result.current.keywords.matches).toHaveLength(1))

    await act(() => result.current.keywords.confirm())

    expect(result.current.keywords.matches).toHaveLength(1)
    expect(result.current.operation.error).toBe('保存できません')
  })
})
