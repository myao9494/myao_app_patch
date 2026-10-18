/**
 * SQLiteの内容閲覧・選択削除・ダミーデータ投入
 */
import { useCallback, useState } from 'react'
import {
  deleteDatabaseRecords,
  loadDatabase,
  seedDummyData,
  type DatabaseSnapshot,
  type Favorite,
} from '../utils/api'
import type { Operations } from './useOperation'

export type DatabaseTableName = keyof DatabaseSnapshot
export type DeletableDatabaseTableName = Exclude<DatabaseTableName, 'settings'>

type Dependencies = {
  /** 宛先一覧（CSV）を再読み込みする */
  reloadRecipients: () => Promise<void>
  /** お気に入りがDB側で変わったときに画面の一覧を同期する */
  onFavoritesChanged: (favorites: Favorite[]) => void
}

export function useDatabaseViewer(
  { run, showToast }: Operations,
  { reloadRecipients, onFavoritesChanged }: Dependencies,
) {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<DatabaseSnapshot | null>(null)
  const [table, setTable] = useState<DatabaseTableName>('keyword_matches')
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])

  const show = useCallback((next: DatabaseSnapshot) => {
    setSnapshot(next)
    setOpen(true)
    setSelectedKeys([])
  }, [])

  const load = useCallback(() => run('database', 'DBの読み込みに失敗しました', async () => {
    show(await loadDatabase())
    showToast('DBを読み込みました')
  }), [run, show, showToast])

  const selectTable = useCallback((next: DatabaseTableName) => {
    setTable(next)
    setSelectedKeys([])
  }, [])

  const close = useCallback(() => setOpen(false), [])

  const deleteSelected = useCallback(async () => {
    if (table === 'settings' || selectedKeys.length === 0) {
      return
    }
    if (!window.confirm(`${table} の選択レコード ${selectedKeys.length}件を削除します。よろしいですか？`)) {
      return
    }
    await run('database', 'DBレコード削除に失敗しました', async () => {
      const result = await deleteDatabaseRecords(table, selectedKeys)
      setSnapshot(result.database)
      if (table === 'favorites') {
        onFavoritesChanged(result.database.favorites)
      }
      setSelectedKeys([])
      await reloadRecipients()
      showToast(`${result.result.deleted}件を削除しました`)
    })
  }, [onFavoritesChanged, reloadRecipients, run, selectedKeys, showToast, table])

  /** 実データを上書きするため、確認ダイアログでOKされた場合のみ実行する */
  const seedDummy = useCallback(async () => {
    const confirmed = window.confirm(
      'ダミーデータを投入します。現在の宛先一覧（DBと送信履歴CSV）はダミーデータで上書きされ、元に戻せません。よろしいですか？',
    )
    if (!confirmed) {
      return
    }
    await run('dummy', 'ダミーデータ投入に失敗しました', async () => {
      const result = await seedDummyData()
      show(result.database)
      await reloadRecipients()
      showToast(`ダミーデータを投入しました（宛先 ${result.inserted.recipients}件）`)
    })
  }, [reloadRecipients, run, show, showToast])

  return { open, snapshot, table, selectedKeys, setSelectedKeys, selectTable, load, close, deleteSelected, seedDummy }
}

export type DatabaseViewerController = ReturnType<typeof useDatabaseViewer>
