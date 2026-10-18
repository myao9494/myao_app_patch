/**
 * 画面操作の実行状態とエラー表示を管理するカスタムフック
 * 「実行中フラグを立てる → エラーを消す → 実行 → 失敗ならメッセージ表示 → 実行中フラグを戻す」を共通化する
 */
import { useCallback, useState } from 'react'

export type RunningAction = 'addresses' | 'keywords' | 'database' | 'dummy' | 'schedule'

export type RunOperation = (
  action: RunningAction | null,
  fallbackMessage: string,
  task: () => Promise<void>,
) => Promise<void>

export function useOperation() {
  const [error, setError] = useState<string | null>(null)
  const [runningAction, setRunningAction] = useState<RunningAction | null>(null)

  /**
   * @param action 実行中として扱う操作名。ボタン無効化が不要な操作は null
   * @param fallbackMessage Errorインスタンス以外が投げられたときに表示するメッセージ
   */
  const run = useCallback<RunOperation>(async (action, fallbackMessage, task) => {
    if (action) {
      setRunningAction(action)
    }
    setError(null)
    try {
      await task()
    } catch (err) {
      setError(err instanceof Error ? err.message : fallbackMessage)
    } finally {
      if (action) {
        setRunningAction(null)
      }
    }
  }, [])

  return { error, setError, runningAction, run }
}

/** 各機能フックが共通で受け取る操作用の依存 */
export type Operations = {
  run: RunOperation
  setError: (message: string | null) => void
  showToast: (message: string) => void
}
