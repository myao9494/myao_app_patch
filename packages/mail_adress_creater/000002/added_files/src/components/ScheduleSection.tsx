/**
 * 予定入力セクション
 * 自然文を解析して件名・日時・場所・本文を編集し、Outlook予定表へ追加する
 */
import type { ScheduleController } from '../hooks/useScheduleDraft'
import type { RunningAction } from '../hooks/useOperation'
import { toDateTimeLocalValue, toIsoFromDateTimeLocal } from '../utils/dateTime'
import { HtmlEditor } from './HtmlEditor'
import { scheduleInputClass } from './styles'

type ScheduleSectionProps = {
  schedule: ScheduleController
  runningAction: RunningAction | null
}

export function ScheduleSection({ schedule, runningAction }: ScheduleSectionProps) {
  const { event } = schedule
  const busy = runningAction !== null
  return (
    <section className="shrink-0 grid gap-2 bg-gray-950/55 border border-gray-700/60 rounded-lg p-2 md:grid-cols-[1fr_auto]">
      <label className="flex flex-col gap-1 text-[11px] text-gray-300">
        予定を自然文で入力
        <input
          type="text"
          value={schedule.text}
          onChange={e => schedule.changeText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void schedule.parse()
            }
          }}
          placeholder="例: 今週の水曜日 15:00から16:30 調整会議"
          className="px-3 py-2 rounded bg-gray-950/80 border border-gray-700 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500/70"
        />
      </label>
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={() => void schedule.parse()}
          disabled={busy}
          className="px-3 py-2 rounded bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-500 disabled:bg-gray-600 disabled:cursor-wait"
        >
          {runningAction === 'schedule' ? '処理中...' : '予定解析'}
        </button>
        <button
          type="button"
          onClick={() => void schedule.add()}
          disabled={busy}
          className="px-3 py-2 rounded bg-rose-600 text-white text-xs font-medium hover:bg-rose-500 disabled:bg-gray-600 disabled:cursor-wait"
        >
          Outlook追加
        </button>
      </div>
      {event && (
        <div className="md:col-span-2 grid gap-2 rounded border border-indigo-400/30 bg-indigo-400/10 px-3 py-3 text-xs text-indigo-50 md:grid-cols-[1.2fr_180px_180px_1fr_1fr_80px]">
          <label className="flex min-w-0 flex-col gap-1 text-indigo-200">
            件名
            <input
              type="text"
              value={event.subject}
              onChange={e => schedule.update({ subject: e.target.value })}
              className={scheduleInputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-indigo-200">
            開始
            <input
              type="datetime-local"
              value={toDateTimeLocalValue(event.start)}
              step={300}
              onChange={e => schedule.update({ start: toIsoFromDateTimeLocal(e.target.value) })}
              onWheel={e => schedule.wheel(e, 'start')}
              className={scheduleInputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-indigo-200">
            終了
            <input
              type="datetime-local"
              value={toDateTimeLocalValue(event.end)}
              step={300}
              onChange={e => schedule.update({ end: toIsoFromDateTimeLocal(e.target.value) })}
              onWheel={e => schedule.wheel(e, 'end')}
              disabled={event.all_day}
              className={`${scheduleInputClass} disabled:opacity-50`}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-indigo-200">
            場所
            <input
              type="text"
              value={event.location}
              onChange={e => schedule.update({ location: e.target.value })}
              className={scheduleInputClass}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-indigo-200">
            本文
            <HtmlEditor
              value={event.body}
              onChange={body => schedule.update({ body })}
              className="min-h-[38px] max-h-[120px] overflow-auto px-2 py-2 rounded bg-gray-950/80 border border-indigo-300/30 text-sm text-gray-100 focus:ring-1 focus:ring-indigo-400"
            />
          </label>
          <label className="flex items-end gap-2 pb-2 text-indigo-100">
            <input
              type="checkbox"
              checked={event.all_day}
              onChange={e => schedule.update({ all_day: e.target.checked })}
              className="h-4 w-4 accent-indigo-500"
            />
            終日
          </label>
        </div>
      )}
    </section>
  )
}
