/**
 * Outlook宛先作成アプリのメインコンポーネント
 * 2ペイン構成で宛先(To)とCCを独立して管理する。機能ごとの状態は hooks/、表示は components/ に分けている
 *
 * キーボードナビゲーション:
 * - 左右矢印: ペイン間の移動（入力欄・本文エディタにフォーカス中は無効）
 * - 上下矢印: ペイン内のアイテム移動
 */
import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useRecipients } from './hooks/useRecipients'
import { useToast } from './hooks/useToast'
import { useOperation, type Operations } from './hooks/useOperation'
import { useSettings } from './hooks/useSettings'
import { useKeywordMatches } from './hooks/useKeywordMatches'
import { useFavorites } from './hooks/useFavorites'
import { useScheduleDraft } from './hooks/useScheduleDraft'
import { useDatabaseViewer } from './hooks/useDatabaseViewer'
import { RecipientPane, type RecipientPaneRef } from './components/RecipientPane'
import { Toast } from './components/Toast'
import { AppHeader } from './components/AppHeader'
import { SettingsPanel } from './components/SettingsPanel'
import { ScheduleSection } from './components/ScheduleSection'
import { KeywordMatchBanner } from './components/KeywordMatchBanner'
import { DatabaseModal } from './components/DatabaseModal'
import { FavoriteModal } from './components/FavoriteModal'
import { GlobalContextMenu } from './components/GlobalContextMenu'
import { refreshAddresses, type Favorite } from './utils/api'
import { isTextEntryTarget } from './utils/dom'
import { buildSearchableRecipients } from './utils/favorites'

type FocusedPane = 'left' | 'right'

const SCREEN_CLASS = 'bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 text-gray-100'

function App() {
  const { recipients, loading, error, reload } = useRecipients()
  const toast = useToast()
  const operation = useOperation()
  const { run, setError, runningAction } = operation
  const { showToast } = toast
  const operations = useMemo<Operations>(() => ({ run, setError, showToast }), [run, setError, showToast])

  const settings = useSettings(operations)
  const keywordMatches = useKeywordMatches(operations)
  const favorites = useFavorites(operations)
  const schedule = useScheduleDraft(operations)
  const database = useDatabaseViewer(operations, {
    reloadRecipients: reload,
    onFavoritesChanged: favorites.syncFavorites,
  })

  const [focusedPane, setFocusedPane] = useState<FocusedPane>('left')
  const [menuOpen, setMenuOpen] = useState(false)
  const [favoriteModalOpen, setFavoriteModalOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  const toPaneRef = useRef<RecipientPaneRef>(null)
  const ccPaneRef = useRef<RecipientPaneRef>(null)

  const toRecipients = useMemo(
    () => buildSearchableRecipients(favorites.favorites, recipients, 'addresses'),
    [favorites.favorites, recipients],
  )
  const ccRecipients = useMemo(
    () => buildSearchableRecipients(favorites.favorites, recipients, 'cc_addresses'),
    [favorites.favorites, recipients],
  )

  const handleRefreshAddresses = useCallback(() => run('addresses', 'アドレス再取得に失敗しました', async () => {
    const result = await refreshAddresses()
    await reload()
    showToast(`アドレスを再取得しました（保存 ${result.saved_count}件 / 0回 ${result.zero_count}件）`)
  }), [reload, run, showToast])

  const handleCopyProfile = useCallback((value: string | undefined, label: string) => {
    const cleanValue = (value ?? '').trim()
    if (!cleanValue) {
      showToast(`${label}が未設定です。設定メニューから登録してください`)
      return
    }
    navigator.clipboard.writeText(cleanValue)
      .then(() => showToast(`${label}をコピーしました`))
      .catch(() => showToast(`${label}のコピーに失敗しました`))
  }, [showToast])

  const handleSaveCurrentToFavorite = useCallback(() => {
    void favorites.addFromSelection(
      toPaneRef.current?.getCheckedNames() ?? [],
      ccPaneRef.current?.getCheckedNames() ?? [],
    )
  }, [favorites])

  const handleApplyFavorite = useCallback((favorite: Favorite) => {
    toPaneRef.current?.setQueryAndChecked('', favorite.addresses, favorite.name)
    ccPaneRef.current?.setQueryAndChecked('', favorite.cc_addresses ?? [], favorite.name)
    showToast(`お気に入り「${favorite.name}」を適用しました`)
  }, [showToast])

  const closeContextMenu = useCallback(() => setContextMenu(null), [])
  const closeFavoriteModal = useCallback(() => setFavoriteModalOpen(false), [])

  // グローバルキーボードイベント（左右矢印でペイン切替）
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (isTextEntryTarget(e.target)) {
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setFocusedPane('left')
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setFocusedPane('right')
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [])

  if (loading) {
    return (
      <div className={`min-h-screen ${SCREEN_CLASS} flex items-center justify-center`}>
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <div className="w-4 h-4 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
          読み込み中...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={`min-h-screen ${SCREEN_CLASS} flex items-center justify-center`}>
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-red-400 text-sm">
          エラー: {error}
        </div>
      </div>
    )
  }

  return (
    <div
      onContextMenu={(e) => {
        if (isTextEntryTarget(e.target)) {
          return
        }
        e.preventDefault()
        setContextMenu({ x: e.clientX, y: e.clientY })
      }}
      className={`h-screen ${SCREEN_CLASS} p-2 flex flex-col gap-2`}
    >
      <AppHeader
        menuOpen={menuOpen}
        runningAction={runningAction}
        settings={settings.settings}
        onToggleMenu={() => setMenuOpen(prev => !prev)}
        onRefreshAddresses={() => void handleRefreshAddresses()}
        onCheckKeywords={() => void keywordMatches.check()}
        onLoadDatabase={() => void database.load()}
        onOpenFavorites={() => setFavoriteModalOpen(true)}
        onCopyProfile={handleCopyProfile}
      >
        <SettingsPanel
          settings={settings.settings}
          keywordText={settings.keywordText}
          runningAction={runningAction}
          onKeywordTextChange={settings.setKeywordText}
          onSettingChange={settings.updateSetting}
          onSave={() => void settings.save()}
          onSeedDummy={() => void database.seedDummy()}
        />
      </AppHeader>

      <ScheduleSection schedule={schedule} runningAction={runningAction} />

      {operation.error && (
        <div className="shrink-0 bg-red-500/15 border border-red-400/40 rounded-lg px-3 py-2 text-sm text-red-100">
          エラー: {operation.error}
        </div>
      )}

      <KeywordMatchBanner matches={keywordMatches.matches} onConfirm={() => void keywordMatches.confirm()} />

      <DatabaseModal viewer={database} runningAction={runningAction} />

      {/* 2ペイン */}
      <div className="flex gap-2 min-h-0 flex-1">
        <div className="flex-1 min-w-0">
          <RecipientPane
            ref={toPaneRef}
            title="宛先（To）"
            buttonLabel="宛先作成"
            recipients={toRecipients}
            onAddFavorite={favorites.addFromRecipient}
            onCopySuccess={() => showToast('宛先をコピーしました')}
            onNameCopy={(name) => showToast(`${name} をコピーしました`)}
            isFocused={focusedPane === 'left'}
            onFocus={() => setFocusedPane('left')}
          />
        </div>
        <div className="flex-1 min-w-0">
          <RecipientPane
            ref={ccPaneRef}
            title="CC"
            isCc
            buttonLabel="CC作成"
            recipients={ccRecipients}
            onAddFavorite={favorites.addFromRecipient}
            onCopySuccess={() => showToast('CCをコピーしました')}
            onNameCopy={(name) => showToast(`${name} をコピーしました`)}
            isFocused={focusedPane === 'right'}
            onFocus={() => setFocusedPane('right')}
          />
        </div>
      </div>

      {favoriteModalOpen && <FavoriteModal favorites={favorites} onClose={closeFavoriteModal} />}

      {contextMenu && (
        <GlobalContextMenu
          position={contextMenu}
          favorites={favorites.favorites}
          onSaveCurrent={handleSaveCurrentToFavorite}
          onApply={handleApplyFavorite}
          onClose={closeContextMenu}
        />
      )}

      <Toast message={toast.message} visible={toast.visible} onHide={toast.hideToast} />
    </div>
  )
}

export default App
