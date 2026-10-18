/**
 * CSVデータを読み込むカスタムフック
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import type { Recipient } from '../types'
import { loadRecipients } from '../utils/csvParser'

type UseRecipientsReturn = {
  recipients: Recipient[]
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

/**
 * CSVファイルから送信先データを読み込む
 *
 * 初回読み込み中のみloadingがtrueになる。再読み込み（reload）では既存データと画面を維持し、
 * 失敗時はerrorを立てずに呼び出し元へ例外を伝える（検索結果やチェック状態を失わないため）。
 * @returns recipients: 送信先データ, loading: 初回読み込み中フラグ, error: 初回読み込みのエラーメッセージ
 */
export function useRecipients(): UseRecipientsReturn {
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const loadedRef = useRef(false)

  const reload = useCallback(async () => {
    try {
      const data = await loadRecipients()
      setRecipients(data)
      setError(null)
      loadedRef.current = true
    } catch (err) {
      if (loadedRef.current) {
        throw err
      }
      setError(err instanceof Error ? err.message : 'データの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { recipients, loading, error, reload }
}
