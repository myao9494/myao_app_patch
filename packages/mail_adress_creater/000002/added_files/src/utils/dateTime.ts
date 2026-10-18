/**
 * 予定の日時変換・編集ロジック
 * バックエンドはISO 8601文字列で日時をやり取りし、画面の datetime-local 入力はローカル時刻文字列を使う
 */
import type { ParsedScheduleEvent } from './api'

const MINUTE_MS = 60 * 1000
const ALL_DAY_MINUTES = 24 * 60

/** ISO文字列を datetime-local 入力の値（ローカル時刻 YYYY-MM-DDTHH:mm）へ変換する。解釈できなければ空文字 */
export function toDateTimeLocalValue(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return new Date(date.getTime() - date.getTimezoneOffset() * MINUTE_MS).toISOString().slice(0, 16)
}

/** datetime-local 入力の値をISO文字列（UTC）へ変換する。解釈できなければ入力をそのまま返す */
export function toIsoFromDateTimeLocal(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

/** 終日予定の終了日時（開始の翌日） */
export function nextAllDayEnd(start: string): string {
  const date = new Date(start)
  if (Number.isNaN(date.getTime())) {
    return start
  }
  date.setDate(date.getDate() + 1)
  return date.toISOString()
}

/** ISO文字列を指定した分だけ進める（負の値で戻す） */
export function adjustIsoMinutes(value: string, deltaMinutes: number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  date.setMinutes(date.getMinutes() + deltaMinutes)
  return date.toISOString()
}

function startOfLocalDay(iso: string): string {
  return toIsoFromDateTimeLocal(`${toDateTimeLocalValue(iso).slice(0, 10)}T00:00`)
}

/**
 * 解析済み予定に編集内容を反映し、終日・開始/終了・所要時間の整合を取る
 * - 終日にする、または終日のまま開始日を変えると、開始は当日0:00、終了は翌日0:00、所要時間は1440分
 * - 開始/終了を変えると、終了が開始より後のときだけ所要時間を再計算する
 */
export function applyScheduleUpdate(
  prev: ParsedScheduleEvent,
  updates: Partial<ParsedScheduleEvent>,
): ParsedScheduleEvent {
  const next = { ...prev, ...updates }
  if (updates.all_day === true || (next.all_day && updates.start)) {
    next.start = startOfLocalDay(next.start)
    next.end = nextAllDayEnd(next.start)
    next.duration_minutes = ALL_DAY_MINUTES
  } else if (updates.start || updates.end) {
    const startTime = new Date(next.start).getTime()
    const endTime = new Date(next.end).getTime()
    if (!Number.isNaN(startTime) && !Number.isNaN(endTime) && endTime > startTime) {
      next.duration_minutes = Math.max(1, Math.round((endTime - startTime) / MINUTE_MS))
    }
  }
  return next
}
