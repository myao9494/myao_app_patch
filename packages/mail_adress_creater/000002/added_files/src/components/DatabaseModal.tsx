/**
 * DB閲覧モーダル
 * SQLiteの主要テーブルを閲覧し、settings以外は選択削除できる（最新データを上に表示）
 */
import type { DatabaseSnapshot } from '../utils/api'
import type { DatabaseTableName, DatabaseViewerController } from '../hooks/useDatabaseViewer'
import type { RunningAction } from '../hooks/useOperation'
import { getDatabaseRowKey } from '../utils/databaseRows'

const TABLES: DatabaseTableName[] = ['keyword_matches', 'recipients', 'favorites', 'job_runs', 'settings']

type DatabaseModalProps = {
  viewer: DatabaseViewerController
  runningAction: RunningAction | null
}

export function DatabaseModal({ viewer, runningAction }: DatabaseModalProps) {
  const { snapshot, table } = viewer
  if (!viewer.open || !snapshot) {
    return null
  }
  const busy = runningAction !== null
  return (
    <div className="fixed inset-0 z-40 bg-black/70 p-3 md:p-5">
      <section className="h-full min-h-0 flex flex-col bg-gray-950 border border-gray-700/80 rounded-lg shadow-2xl">
        <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-gray-800 px-3 py-3">
          <div className="mr-auto">
            <h2 className="text-base font-semibold text-gray-100">DB閲覧</h2>
            <p className="text-[11px] text-gray-400">最新データを上に表示しています</p>
          </div>
          {TABLES.map(name => (
            <button
              key={name}
              type="button"
              onClick={() => viewer.selectTable(name)}
              className={`px-3 py-2 rounded border text-xs ${
                table === name
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-gray-900 border-gray-700 text-gray-300 hover:bg-gray-800'
              }`}
            >
              {name} ({snapshot[name].length})
            </button>
          ))}
          <button
            type="button"
            onClick={() => void viewer.load()}
            disabled={busy}
            className="px-3 py-2 rounded bg-gray-800 text-xs text-gray-100 hover:bg-gray-700 disabled:cursor-wait"
          >
            更新
          </button>
          <button
            type="button"
            onClick={() => void viewer.deleteSelected()}
            disabled={table === 'settings' || viewer.selectedKeys.length === 0 || busy}
            className="px-3 py-2 rounded bg-red-600 text-xs font-semibold text-white hover:bg-red-500 disabled:bg-gray-700 disabled:text-gray-400 disabled:cursor-not-allowed"
          >
            選択削除 ({viewer.selectedKeys.length})
          </button>
          <button
            type="button"
            onClick={viewer.close}
            className="px-3 py-2 rounded bg-gray-100 text-xs font-semibold text-gray-950 hover:bg-white"
          >
            閉じる
          </button>
        </div>
        <DatabaseTable
          snapshot={snapshot}
          table={table}
          selectedKeys={viewer.selectedKeys}
          onSelectedKeysChange={viewer.setSelectedKeys}
        />
      </section>
    </div>
  )
}

type DatabaseTableProps = {
  snapshot: DatabaseSnapshot
  table: DatabaseTableName
  selectedKeys: string[]
  onSelectedKeysChange: (keys: string[]) => void
}

function DatabaseTable({ snapshot, table, selectedKeys, onSelectedKeysChange }: DatabaseTableProps) {
  const rows: Array<Record<string, unknown>> = snapshot[table]
  const columns = rows.length > 0 ? Object.keys(rows[0]) : []
  const canDelete = table !== 'settings'
  const rowKeys = rows.map(row => getDatabaseRowKey(table, row))
  const selectedKeySet = new Set(selectedKeys)
  const allSelected = canDelete && rowKeys.length > 0 && rowKeys.every(key => selectedKeySet.has(key))

  const toggleRow = (key: string, checked: boolean) => {
    onSelectedKeysChange(checked ? [...selectedKeys, key] : selectedKeys.filter(selectedKey => selectedKey !== key))
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain bg-gray-950">
      {rows.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-gray-400">データがありません</div>
      ) : (
        <table className="w-full min-w-max text-left text-xs">
          <thead className="sticky top-0 bg-gray-900 text-gray-300">
            <tr>
              <th className="w-10 px-3 py-2 border-b border-gray-800">
                {canDelete && (
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={event => onSelectedKeysChange(event.target.checked ? rowKeys : [])}
                    className="h-4 w-4 accent-red-500"
                    aria-label="全レコードを選択"
                  />
                )}
              </th>
              {columns.map(column => (
                <th key={column} className="px-3 py-2 font-semibold whitespace-nowrap border-b border-gray-800">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800 text-gray-200">
            {rows.map((row, rowIndex) => (
              <tr key={rowKeys[rowIndex]} className="hover:bg-gray-900/80">
                <td className="px-3 py-2 align-top">
                  {canDelete && (
                    <input
                      type="checkbox"
                      checked={selectedKeySet.has(rowKeys[rowIndex])}
                      onChange={event => toggleRow(rowKeys[rowIndex], event.target.checked)}
                      className="h-4 w-4 accent-red-500"
                      aria-label={`${rowKeys[rowIndex]}を選択`}
                    />
                  )}
                </td>
                {columns.map(column => (
                  <td key={column} className="px-3 py-2 align-top max-w-[720px]">
                    <span className="block whitespace-pre-wrap break-words" title={String(row[column])}>
                      {String(row[column])}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
