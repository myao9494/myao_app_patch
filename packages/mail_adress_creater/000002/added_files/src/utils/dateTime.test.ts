/**
 * 予定の日時変換・編集ロジックのテスト（実行環境のタイムゾーンに依存しない形で検証する）
 */
import { describe, it, expect } from 'vitest'
import {
  adjustIsoMinutes,
  applyScheduleUpdate,
  nextAllDayEnd,
  toDateTimeLocalValue,
  toIsoFromDateTimeLocal,
} from './dateTime'
import type { ParsedScheduleEvent } from './api'

const baseEvent: ParsedScheduleEvent = {
  start: '2026-05-20T06:00:00.000Z',
  end: '2026-05-20T07:30:00.000Z',
  subject: '会議',
  location: '',
  body: '',
  all_day: false,
  duration_minutes: 90,
  normalized_text: '会議',
}

describe('toDateTimeLocalValue / toIsoFromDateTimeLocal', () => {
  it('往復しても同じ時刻になる', () => {
    const local = toDateTimeLocalValue(baseEvent.start)

    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(new Date(toIsoFromDateTimeLocal(local)).getTime()).toBe(new Date(baseEvent.start).getTime())
  })

  it('解釈できない値は、表示用には空文字、ISO変換では入力のまま返す', () => {
    expect(toDateTimeLocalValue('not-a-date')).toBe('')
    expect(toIsoFromDateTimeLocal('not-a-date')).toBe('not-a-date')
  })
})

describe('nextAllDayEnd / adjustIsoMinutes', () => {
  it('終日の終了は開始の翌日', () => {
    const end = new Date(nextAllDayEnd('2026-05-20T00:00:00.000Z'))

    expect(end.getTime() - new Date('2026-05-20T00:00:00.000Z').getTime()).toBeGreaterThanOrEqual(23 * 3600 * 1000)
    expect(nextAllDayEnd('broken')).toBe('broken')
  })

  it('指定した分だけ前後に動かす', () => {
    expect(adjustIsoMinutes('2026-05-20T06:00:00.000Z', 5)).toBe('2026-05-20T06:05:00.000Z')
    expect(adjustIsoMinutes('2026-05-20T06:00:00.000Z', -5)).toBe('2026-05-20T05:55:00.000Z')
    expect(adjustIsoMinutes('broken', 5)).toBe('broken')
  })
})

describe('applyScheduleUpdate', () => {
  it('件名など日時以外の更新では所要時間を変えない', () => {
    const next = applyScheduleUpdate(baseEvent, { subject: '定例' })

    expect(next).toEqual({ ...baseEvent, subject: '定例' })
  })

  it('終了を変えると所要時間を再計算する', () => {
    const next = applyScheduleUpdate(baseEvent, { end: '2026-05-20T08:00:00.000Z' })

    expect(next.duration_minutes).toBe(120)
  })

  it('終了が開始以前になる更新では所要時間を維持する', () => {
    const next = applyScheduleUpdate(baseEvent, { end: '2026-05-20T05:00:00.000Z' })

    expect(next.duration_minutes).toBe(90)
  })

  it('終日にすると当日0:00から翌日0:00、1440分になる', () => {
    const next = applyScheduleUpdate(baseEvent, { all_day: true })

    expect(toDateTimeLocalValue(next.start).endsWith('T00:00')).toBe(true)
    expect(toDateTimeLocalValue(next.end).endsWith('T00:00')).toBe(true)
    expect(next.duration_minutes).toBe(1440)
    expect(next.all_day).toBe(true)
  })

  it('終日のまま開始日を変えると、終了も追従して0:00に揃う', () => {
    const allDay = applyScheduleUpdate(baseEvent, { all_day: true })

    const moved = applyScheduleUpdate(allDay, { start: '2026-05-25T15:00:00.000Z' })

    expect(toDateTimeLocalValue(moved.start).endsWith('T00:00')).toBe(true)
    expect(moved.duration_minutes).toBe(1440)
    expect(new Date(moved.end).getTime()).toBeGreaterThan(new Date(moved.start).getTime())
  })
})
