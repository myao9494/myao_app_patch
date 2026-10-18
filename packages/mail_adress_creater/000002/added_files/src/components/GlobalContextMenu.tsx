/**
 * 画面全体の右クリックメニュー
 * 現在の宛先・CCの選択状態をお気に入りへ追加する／お気に入りを宛先・CCへ一括適用する
 * クリックまたはキー操作で閉じる
 */
import { useEffect } from 'react'
import type { Favorite } from '../utils/api'
import { contextMenuItemClass } from './styles'

type GlobalContextMenuProps = {
  position: { x: number; y: number }
  favorites: Favorite[]
  onSaveCurrent: () => void
  onApply: (favorite: Favorite) => void
  onClose: () => void
}

export function GlobalContextMenu({ position, favorites, onSaveCurrent, onApply, onClose }: GlobalContextMenuProps) {
  useEffect(() => {
    window.addEventListener('click', onClose)
    window.addEventListener('keydown', onClose)
    return () => {
      window.removeEventListener('click', onClose)
      window.removeEventListener('keydown', onClose)
    }
  }, [onClose])

  return (
    <div
      className="fixed z-50 min-w-48 rounded-lg border border-gray-700/80 bg-gray-950/95 py-1 text-xs text-gray-100 shadow-2xl backdrop-blur-md"
      style={{ left: position.x, top: position.y }}
      onClick={e => e.stopPropagation()}
    >
      <button
        type="button"
        className={`${contextMenuItemClass} flex items-center gap-1.5`}
        onClick={() => {
          onSaveCurrent()
          onClose()
        }}
      >
        <span>📁</span> 現在の宛先・CCをお気に入りに追加
      </button>
      <div className="border-t border-gray-800 my-1" />
      <div className="px-4 py-1 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">お気に入りを適用...</div>
      {favorites.length === 0 ? (
        <div className="px-4 py-2 text-gray-500 italic">お気に入りがありません</div>
      ) : (
        <div className="max-h-48 overflow-y-auto">
          {favorites.map(favorite => (
            <button
              key={favorite.name}
              type="button"
              className={`${contextMenuItemClass} pl-6 flex items-center justify-between`}
              onClick={() => {
                onApply(favorite)
                onClose()
              }}
            >
              <span className="truncate">{favorite.name}</span>
              <span className="text-[10px] text-gray-500 ml-2">
                To:{favorite.addresses.length} CC:{(favorite.cc_addresses ?? []).length}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
