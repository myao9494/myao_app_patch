/**
 * バックエンド設定（キーワード、自動実行間隔、プロフィール）の読み込みと保存
 */
import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type BackendSettings } from '../utils/api'
import { formatKeywordText, parseKeywordText } from '../utils/keywords'
import type { Operations } from './useOperation'

export function useSettings({ run, showToast }: Operations) {
  const [settings, setSettings] = useState<BackendSettings>(DEFAULT_SETTINGS)
  const [keywordText, setKeywordText] = useState(formatKeywordText(DEFAULT_SETTINGS.keywords))

  const apply = useCallback((next: BackendSettings) => {
    setSettings(next)
    setKeywordText(formatKeywordText(next.keywords))
  }, [])

  useEffect(() => {
    void run(null, '設定の読み込みに失敗しました', async () => {
      apply(await loadSettings())
    })
  }, [apply, run])

  const updateSetting = useCallback(<K extends keyof BackendSettings>(key: K, value: BackendSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }))
  }, [])

  const save = useCallback(() => run(null, '設定の保存に失敗しました', async () => {
    apply(await saveSettings({ ...settings, keywords: parseKeywordText(keywordText) }))
    showToast('設定を保存しました')
  }), [apply, keywordText, run, settings, showToast])

  return { settings, keywordText, setKeywordText, updateSetting, save }
}
