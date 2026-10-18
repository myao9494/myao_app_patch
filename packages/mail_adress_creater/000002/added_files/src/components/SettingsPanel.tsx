/**
 * 設定メニュー（ハンバーガーメニューの中身）
 * 上段: キーワード・自動実行間隔・保存・ダミーデータ投入 / 下段: プロフィール（かんたんコピー用）
 */
import type { BackendSettings } from '../utils/api'
import type { RunningAction } from '../hooks/useOperation'
import { settingsInputClass } from './styles'

const PROFILE_FIELDS: Array<{
  key: 'my_email' | 'my_phone' | 'my_address' | 'my_dept' | 'my_home_email'
  label: string
  type: 'email' | 'text'
  placeholder: string
}> = [
  { key: 'my_email', label: 'メールアドレス', type: 'email', placeholder: 'your.email@example.com' },
  { key: 'my_phone', label: '電話番号', type: 'text', placeholder: '090-0000-0000' },
  { key: 'my_address', label: '住所', type: 'text', placeholder: '住所を入力してください' },
  { key: 'my_dept', label: '部署', type: 'text', placeholder: '部署を入力してください' },
  { key: 'my_home_email', label: '家アド', type: 'email', placeholder: 'home.email@example.com' },
]

type SettingsPanelProps = {
  settings: BackendSettings
  keywordText: string
  runningAction: RunningAction | null
  onKeywordTextChange: (text: string) => void
  onSettingChange: <K extends keyof BackendSettings>(key: K, value: BackendSettings[K]) => void
  onSave: () => void
  onSeedDummy: () => void
}

export function SettingsPanel({
  settings,
  keywordText,
  runningAction,
  onKeywordTextChange,
  onSettingChange,
  onSave,
  onSeedDummy,
}: SettingsPanelProps) {
  return (
    <div className="mt-2 flex flex-col gap-3 bg-gray-900/80 border border-gray-700/60 rounded p-3 shadow-inner">
      <div className="grid gap-2 md:grid-cols-[1fr_220px_220px_auto_auto]">
        <label className="flex flex-col gap-1 text-[11px] text-gray-300">
          キーワード
          <input
            type="text"
            value={keywordText}
            onChange={e => onKeywordTextChange(e.target.value)}
            placeholder="棚卸,棚おろし,ユーザID"
            className={settingsInputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-gray-300">
          アドレス再取得の頻度（分）
          <input
            type="number"
            min={1}
            value={settings.address_interval_minutes}
            onChange={e => onSettingChange('address_interval_minutes', Number(e.target.value) || 1)}
            className={settingsInputClass}
          />
          <span className="text-[10px] text-gray-500">既定値: 43200分（1ヶ月）</span>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-gray-300">
          キーワードチェックの頻度（分）
          <input
            type="number"
            min={1}
            value={settings.keyword_interval_minutes}
            onChange={e => onSettingChange('keyword_interval_minutes', Number(e.target.value) || 1)}
            className={settingsInputClass}
          />
          <span className="text-[10px] text-gray-500">既定値: 60分（1時間）</span>
        </label>
        <div className="flex items-end">
          <button
            type="button"
            onClick={onSave}
            className="w-full px-3 py-2 rounded bg-gray-100 text-gray-950 text-xs font-semibold hover:bg-white"
          >
            設定保存
          </button>
        </div>
        <div className="flex items-end">
          <button
            type="button"
            onClick={onSeedDummy}
            disabled={runningAction !== null}
            className="w-full px-3 py-2 rounded bg-amber-400 text-gray-950 text-xs font-semibold hover:bg-amber-300 disabled:bg-gray-600 disabled:text-gray-300 disabled:cursor-wait"
          >
            {runningAction === 'dummy' ? '投入中...' : 'ダミーデータ投入'}
          </button>
        </div>
      </div>

      <div className="border-t border-gray-800/80 pt-2 grid gap-2 md:grid-cols-5">
        {PROFILE_FIELDS.map(({ key, label, type, placeholder }) => (
          <label key={key} className="flex flex-col gap-1 text-[11px] text-gray-300">
            {label}
            <input
              type={type}
              value={settings[key] ?? ''}
              onChange={e => onSettingChange(key, e.target.value)}
              placeholder={placeholder}
              className={settingsInputClass}
            />
          </label>
        ))}
      </div>
    </div>
  )
}
