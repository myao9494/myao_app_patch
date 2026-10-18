/**
 * 自然文の予定入力、解析結果の編集、Outlook予定表への追加
 */
import { useCallback, useState, type WheelEvent } from 'react'
import { addSchedule, parseSchedule, type ParsedScheduleEvent } from '../utils/api'
import { adjustIsoMinutes, applyScheduleUpdate } from '../utils/dateTime'
import type { Operations } from './useOperation'

/** マウスホイール1ノッチあたりに動かす分数 */
const WHEEL_STEP_MINUTES = 5

export function useScheduleDraft({ run, setError, showToast }: Operations) {
  const [text, setText] = useState('')
  const [event, setEvent] = useState<ParsedScheduleEvent | null>(null)

  /** 入力文が変わったら、古い解析結果は破棄する */
  const changeText = useCallback((next: string) => {
    setText(next)
    setEvent(null)
  }, [])

  const parse = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed) {
      setError('予定入力を入力してください')
      return
    }
    await run('schedule', '予定の解析に失敗しました', async () => {
      try {
        setEvent((await parseSchedule(trimmed)).event)
        showToast('予定を解析しました')
      } catch (err) {
        setEvent(null)
        throw err
      }
    })
  }, [run, setError, showToast, text])

  const update = useCallback((updates: Partial<ParsedScheduleEvent>) => {
    setEvent(prev => (prev ? applyScheduleUpdate(prev, updates) : prev))
  }, [])

  const wheel = useCallback((wheelEvent: WheelEvent<HTMLInputElement>, field: 'start' | 'end') => {
    if (!event || (field === 'end' && event.all_day)) {
      return
    }
    wheelEvent.preventDefault()
    update({ [field]: adjustIsoMinutes(event[field], wheelEvent.deltaY < 0 ? WHEEL_STEP_MINUTES : -WHEEL_STEP_MINUTES) })
  }, [event, update])

  const add = useCallback(async () => {
    if (!event) {
      setError(text.trim() ? '先に予定解析を実行してください' : '予定入力を入力してください')
      return
    }
    if (!event.subject.trim()) {
      setError('件名を入力してください')
      return
    }
    await run('schedule', 'Outlook予定表への追加に失敗しました', async () => {
      const result = await addSchedule(text.trim(), event)
      setEvent(result.event)
      showToast(`${result.event.subject} をOutlook予定表に追加しました`)
    })
  }, [event, run, setError, showToast, text])

  return { text, changeText, event, parse, update, wheel, add }
}

export type ScheduleController = ReturnType<typeof useScheduleDraft>
