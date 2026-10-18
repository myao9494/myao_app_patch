/**
 * お気に入り編集モーダル
 * 常に2カラム（左: 名前の一覧、右: 編集）。右は上下に分割し、宛先(To)とCCを個別に改行区切りで編集する
 * Escapeキーまたは背景クリックで閉じる
 */
import { useEffect } from 'react'
import type { FavoritesController } from '../hooks/useFavorites'
import { parseFavoriteAddressText } from '../utils/favorites'

type FavoriteModalProps = {
  favorites: FavoritesController
  onClose: () => void
}

const TEXTAREA_CLASS =
  'flex-1 min-h-[120px] w-full resize-none bg-transparent p-3 font-mono text-sm leading-6 text-gray-100 outline-none placeholder:text-gray-600 overflow-y-auto'
const AREA_TITLE_CLASS =
  'bg-gray-950/40 px-3 py-1 text-[11px] font-semibold text-gray-400 border-b border-gray-800/50 flex justify-between items-center shrink-0'

export function FavoriteModal({ favorites, onClose }: FavoriteModalProps) {
  const { draft, selectedName } = favorites
  const selected = favorites.favorites.find(favorite => favorite.name === selectedName)

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 bg-black/70 p-3 md:p-5" onMouseDown={onClose}>
      <section
        className="mx-auto flex h-full max-w-6xl flex-col border border-gray-700/80 bg-gray-950 text-gray-100 shadow-2xl"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="shrink-0 border-b border-gray-800 bg-gray-950 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 mr-auto">
              <h1 className="text-lg font-semibold text-gray-50">お気に入り</h1>
              <p className="text-xs text-gray-400">左で名前を選択し、右で内容を編集</p>
            </div>
            <button
              type="button"
              onClick={favorites.startNew}
              className="h-9 px-4 rounded border border-gray-700 bg-gray-900 text-xs font-bold text-gray-100 hover:bg-gray-800"
            >
              新規
            </button>
            <button
              type="button"
              onClick={() => void favorites.saveDraft()}
              className="h-9 px-4 rounded bg-cyan-500 text-xs font-bold text-gray-950 hover:bg-cyan-400"
            >
              保存
            </button>
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-3 rounded bg-gray-100 text-xs font-bold text-gray-950 hover:bg-white"
            >
              閉じる
            </button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 gap-3 p-3 grid-cols-[minmax(130px,240px)_minmax(0,1fr)] sm:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="min-h-0 flex flex-col border border-gray-800 bg-gray-900">
            <div className="flex items-center justify-between border-b border-gray-800 px-3 py-3 shrink-0">
              <h2 className="text-sm font-semibold text-gray-100">お気に入り名</h2>
              <span className="rounded bg-gray-800 px-2 py-1 text-xs text-gray-300">{favorites.favorites.length}件</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {favorites.favorites.length === 0 ? (
                <p className="px-3 py-8 text-center text-xs text-gray-500">お気に入りがありません</p>
              ) : favorites.favorites.map(favorite => (
                <button
                  key={favorite.name}
                  type="button"
                  onClick={() => favorites.select(favorite)}
                  className={`block w-full border-b border-gray-800 px-3 py-3 text-left hover:bg-gray-800 ${
                    selectedName === favorite.name ? 'bg-cyan-500/15 text-cyan-100' : 'text-gray-200'
                  }`}
                >
                  <span className="block truncate text-sm font-semibold" title={favorite.name}>{favorite.name}</span>
                  <span className="mt-1 block text-xs text-gray-400">{favorite.addresses.length}宛先</span>
                </button>
              ))}
            </div>
          </aside>

          <section className="min-h-0 flex flex-col border border-gray-800 bg-gray-900">
            <div className="grid gap-3 border-b border-gray-800 p-3 grid-cols-[minmax(0,1fr)_auto]">
              <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-300">
                お気に入り名
                <input
                  type="text"
                  value={draft.name}
                  onChange={event => favorites.updateDraft({ name: event.target.value })}
                  className="h-10 rounded border border-gray-700 bg-gray-950 px-3 text-sm text-gray-100 outline-none focus:border-cyan-400"
                  placeholder="例: 開発チーム"
                />
              </label>
              <div className="flex items-end gap-2">
                <button
                  type="button"
                  onClick={() => void favorites.deleteSelected()}
                  className="h-10 px-3 rounded bg-red-600 text-xs font-semibold text-white hover:bg-red-500"
                >
                  削除
                </button>
              </div>
            </div>
            <div className="border-b border-gray-800 px-3 py-2 text-xs text-gray-400 shrink-0">
              {selected ? `${selected.name} を編集中` : '新しいお気に入りを編集中'} / To {parseFavoriteAddressText(draft.toText).length}宛先 / CC {parseFavoriteAddressText(draft.ccText).length}宛先
            </div>
            <div className="flex-1 flex flex-col min-h-0 divide-y divide-gray-800">
              <div className="flex-1 flex flex-col min-h-0">
                <div className={AREA_TITLE_CLASS}>
                  <span>宛先（To）のリスト（改行区切り）</span>
                </div>
                <textarea
                  value={draft.toText}
                  onChange={event => favorites.updateDraft({ toText: event.target.value })}
                  spellCheck={false}
                  className={TEXTAREA_CLASS}
                  placeholder={'山田 太郎\n佐藤 一郎'}
                />
              </div>
              <div className="flex-1 flex flex-col min-h-0">
                <div className={AREA_TITLE_CLASS}>
                  <span>CC のリスト（改行区切り）</span>
                </div>
                <textarea
                  value={draft.ccText}
                  onChange={event => favorites.updateDraft({ ccText: event.target.value })}
                  spellCheck={false}
                  className={TEXTAREA_CLASS}
                  placeholder={'keiri@example.com\n鈴木 二郎'}
                />
              </div>
            </div>
          </section>
        </div>
      </section>
    </div>
  )
}
