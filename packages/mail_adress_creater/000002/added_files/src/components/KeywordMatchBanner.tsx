/**
 * 職アド通知バナー
 * 未確認のキーワード一致を強調表示し、「確認」を押すまで消えない
 */
import type { KeywordMatch } from '../utils/api'

type KeywordMatchBannerProps = {
  matches: KeywordMatch[]
  onConfirm: () => void
}

export function KeywordMatchBanner({ matches, onConfirm }: KeywordMatchBannerProps) {
  if (matches.length === 0) {
    return null
  }
  return (
    <section className="shrink-0 bg-amber-300 text-gray-950 border-2 border-amber-100 rounded-lg p-3 shadow-xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold">新しい職アド通知があります</h2>
          <p className="text-xs text-gray-800">{matches.length}件のキーワード一致を検出しました</p>
        </div>
        <button
          type="button"
          onClick={onConfirm}
          className="px-2 py-1 rounded bg-gray-950 text-white text-xs hover:bg-gray-800"
        >
          確認
        </button>
      </div>
      <ul className="mt-2 max-h-28 overflow-y-auto text-xs divide-y divide-amber-500/40">
        {matches.map((match, index) => (
          <li key={`${match.received_time}-${match.keyword}-${index}`} className="py-1">
            <span className="font-semibold">[{match.keyword}]</span> {match.line}
            <span className="block text-[10px] text-gray-700">{match.received_time} / {match.subject}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
