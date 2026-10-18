/**
 * 画面上部のヘッダー
 * 設定メニューの開閉、アドレス再取得、職アドチェック、DB表示、お気に入り、プロフィールコピーの入口
 */
import type { ReactNode } from 'react'
import type { BackendSettings } from '../utils/api'
import type { RunningAction } from '../hooks/useOperation'
import { ProfileCopyButtons } from './ProfileCopyButtons'
import { headerButtonClass } from './styles'

type AppHeaderProps = {
  menuOpen: boolean
  runningAction: RunningAction | null
  settings: BackendSettings
  onToggleMenu: () => void
  onRefreshAddresses: () => void
  onCheckKeywords: () => void
  onLoadDatabase: () => void
  onOpenFavorites: () => void
  onCopyProfile: (value: string | undefined, label: string) => void
  /** メニューが開いているときにヘッダー下部へ表示する設定パネル */
  children?: ReactNode
}

export function AppHeader({
  menuOpen,
  runningAction,
  settings,
  onToggleMenu,
  onRefreshAddresses,
  onCheckKeywords,
  onLoadDatabase,
  onOpenFavorites,
  onCopyProfile,
  children,
}: AppHeaderProps) {
  const busy = runningAction !== null
  return (
    <header className="shrink-0 bg-gray-950/70 border border-gray-700/60 rounded-lg px-2 py-2 shadow-lg">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleMenu}
          className="w-9 h-9 grid place-items-center rounded border border-gray-600/70 bg-gray-900/80 text-gray-200 hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
          aria-label="設定メニュー"
          aria-expanded={menuOpen}
        >
          <span className="flex flex-col gap-1" aria-hidden="true">
            <span className="block w-4 h-0.5 bg-current rounded" />
            <span className="block w-4 h-0.5 bg-current rounded" />
            <span className="block w-4 h-0.5 bg-current rounded" />
          </span>
        </button>
        <div className="min-w-0 mr-auto">
          <h1 className="text-sm font-semibold text-gray-100">Outlook宛先作成</h1>
          <p className="text-[10px] text-gray-400">送信履歴と職アド通知を管理</p>
        </div>
        <button type="button" onClick={onRefreshAddresses} disabled={busy} className={headerButtonClass.blue}>
          {runningAction === 'addresses' ? '取得中...' : 'アドレス再取得'}
        </button>
        <button type="button" onClick={onCheckKeywords} disabled={busy} className={headerButtonClass.emerald}>
          {runningAction === 'keywords' ? '確認中...' : '職アドキーワードチェック'}
        </button>
        <button type="button" onClick={onLoadDatabase} disabled={busy} className={headerButtonClass.slate}>
          {runningAction === 'database' ? '読込中...' : 'DB表示'}
        </button>
        <button type="button" onClick={onOpenFavorites} className={headerButtonClass.cyan}>
          お気に入り
        </button>
        <ProfileCopyButtons settings={settings} onCopy={onCopyProfile} />
      </div>
      {menuOpen && children}
    </header>
  )
}
