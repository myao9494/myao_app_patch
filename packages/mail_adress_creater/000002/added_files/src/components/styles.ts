/**
 * 複数のコンポーネントで共有するTailwindクラス
 * （Tailwindは完全なクラス名を静的に検出するため、文字列連結ではなく定数として定義する）
 */

/** 設定メニュー内のテキスト入力 */
export const settingsInputClass =
  'px-2 py-2 rounded bg-gray-950/80 border border-gray-700 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500/70'

/** 予定編集欄の入力 */
export const scheduleInputClass =
  'px-2 py-2 rounded bg-gray-950/80 border border-indigo-300/30 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-400'

/** ヘッダーの処理ボタン（色ごと） */
export const headerButtonClass = {
  blue: 'px-3 py-2 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-wait',
  emerald: 'px-3 py-2 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-500 disabled:bg-gray-600 disabled:cursor-wait',
  slate: 'px-3 py-2 rounded bg-slate-700 text-white text-xs font-medium hover:bg-slate-600 disabled:bg-gray-600 disabled:cursor-wait',
  cyan: 'px-3 py-2 rounded bg-cyan-600 text-white text-xs font-medium hover:bg-cyan-500',
} as const

/** 画面右クリックメニューの項目 */
export const contextMenuItemClass = 'w-full px-4 py-2 text-left hover:bg-gray-800'
