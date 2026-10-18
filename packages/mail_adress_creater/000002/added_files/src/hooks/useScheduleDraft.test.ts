/**
 * useScheduleDraftフックのテスト
 * 解析・編集・Outlook追加の流れと、入力不備時のエラー表示を確認する
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { WheelEvent } from 'react'
import { useScheduleDraft } from './useScheduleDraft'
import { useTestOperations } from '../test/operations'
import { addSchedule, parseSchedule, type ParsedScheduleEvent } from '../utils/api'

vi.mock('../utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/api')>()),
  parseSchedule: vi.fn(),
  addSchedule: vi.fn(),
}))

const event: ParsedScheduleEvent = {
  start: '2026-05-20T06:00:00.000Z',
  end: '2026-05-20T07:00:00.000Z',
  subject: '会議',
  location: '',
  body: '',
  all_day: false,
  duration_minutes: 60,
  normalized_text: '会議',
}

function setup() {
  return renderHook(() => {
    const ops = useTestOperations()
    return { ...ops, schedule: useScheduleDraft(ops.operations) }
  })
}

const wheelEvent = (deltaY: number) =>
  ({ deltaY, preventDefault: vi.fn() }) as unknown as WheelEvent<HTMLInputElement>

describe('useScheduleDraft', () => {
  beforeEach(() => {
    vi.mocked(parseSchedule).mockReset()
    vi.mocked(addSchedule).mockReset()
  })

  it('入力が空のまま解析するとAPIを呼ばずにエラーを表示する', async () => {
    const { result } = setup()

    await act(() => result.current.schedule.parse())

    expect(parseSchedule).not.toHaveBeenCalled()
    expect(result.current.operation.error).toBe('予定入力を入力してください')
  })

  it('解析に成功すると結果を保持し、入力文を変えると破棄する', async () => {
    vi.mocked(parseSchedule).mockResolvedValue({ event })
    const { result } = setup()
    act(() => result.current.schedule.changeText(' 明日 15:00 会議 '))

    await act(() => result.current.schedule.parse())
    expect(parseSchedule).toHaveBeenCalledWith('明日 15:00 会議')
    expect(result.current.schedule.event).toEqual(event)

    act(() => result.current.schedule.changeText('明日 16:00 会議'))
    expect(result.current.schedule.event).toBeNull()
  })

  it('解析に失敗すると以前の結果を消してエラーを表示する', async () => {
    vi.mocked(parseSchedule).mockResolvedValueOnce({ event }).mockRejectedValueOnce(new Error('予定名を読み取れませんでした'))
    const { result } = setup()
    act(() => result.current.schedule.changeText('会議'))
    await act(() => result.current.schedule.parse())

    await act(() => result.current.schedule.parse())

    expect(result.current.schedule.event).toBeNull()
    expect(result.current.operation.error).toBe('予定名を読み取れませんでした')
  })

  it('解析前に追加しようとすると案内のエラーを表示する', async () => {
    const { result } = setup()
    act(() => result.current.schedule.changeText('会議'))

    await act(() => result.current.schedule.add())

    expect(addSchedule).not.toHaveBeenCalled()
    expect(result.current.operation.error).toBe('先に予定解析を実行してください')
  })

  it('件名が空のままでは追加できない', async () => {
    vi.mocked(parseSchedule).mockResolvedValue({ event })
    const { result } = setup()
    act(() => result.current.schedule.changeText('会議'))
    await act(() => result.current.schedule.parse())
    act(() => result.current.schedule.update({ subject: '  ' }))

    await act(() => result.current.schedule.add())

    expect(addSchedule).not.toHaveBeenCalled()
    expect(result.current.operation.error).toBe('件名を入力してください')
  })

  it('追加に成功すると結果を反映してトーストを出す', async () => {
    vi.mocked(parseSchedule).mockResolvedValue({ event })
    vi.mocked(addSchedule).mockResolvedValue({ event: { ...event, subject: '会議(登録済)' }, saved: true })
    const { result } = setup()
    act(() => result.current.schedule.changeText('会議'))
    await act(() => result.current.schedule.parse())

    await act(() => result.current.schedule.add())

    expect(addSchedule).toHaveBeenCalledWith('会議', event)
    expect(result.current.showToast).toHaveBeenCalledWith('会議(登録済) をOutlook予定表に追加しました')
  })

  it('ホイールで5分単位で開始時刻を動かし、終日のときは終了時刻を動かさない', async () => {
    vi.mocked(parseSchedule).mockResolvedValue({ event })
    const { result } = setup()
    act(() => result.current.schedule.changeText('会議'))
    await act(() => result.current.schedule.parse())

    const up = wheelEvent(-100)
    act(() => result.current.schedule.wheel(up, 'start'))
    expect(up.preventDefault).toHaveBeenCalled()
    expect(result.current.schedule.event?.start).toBe('2026-05-20T06:05:00.000Z')
    expect(result.current.schedule.event?.duration_minutes).toBe(55)

    act(() => result.current.schedule.update({ all_day: true }))
    const down = wheelEvent(100)
    act(() => result.current.schedule.wheel(down, 'end'))
    expect(down.preventDefault).not.toHaveBeenCalled()
  })
})
