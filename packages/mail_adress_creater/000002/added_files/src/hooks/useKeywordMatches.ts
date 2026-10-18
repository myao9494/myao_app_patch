/**
 * 職アドキーワード通知の取得・確認
 * 起動時に未確認の通知を復元し、「確認」を押すまで表示し続ける
 */
import { useCallback, useEffect, useState } from 'react'
import { checkKeywords, confirmMatches, loadUnconfirmedMatches, type KeywordMatch } from '../utils/api'
import type { Operations } from './useOperation'

export function useKeywordMatches({ run, showToast }: Operations) {
  const [matches, setMatches] = useState<KeywordMatch[]>([])

  useEffect(() => {
    loadUnconfirmedMatches()
      .then(result => {
        if (result.matches.length > 0) {
          setMatches(result.matches)
        }
      })
      .catch(() => {
        // バックエンド未起動などで読み込めなくても、画面の他の機能は使えるようにする
      })
  }, [])

  const check = useCallback(() => run('keywords', '職アドキーワードチェックに失敗しました', async () => {
    const result = await checkKeywords()
    setMatches(result.new_matches)
    showToast(
      result.new_matches.length > 0
        ? `新しい職アド通知が ${result.new_matches.length}件あります`
        : '新しい職アド通知はありません',
    )
  }), [run, showToast])

  const confirm = useCallback(() => run(null, '職アド通知の確認に失敗しました', async () => {
    const ids = matches.map(match => match.id).filter((id): id is number => id !== undefined)
    if (ids.length > 0) {
      await confirmMatches(ids)
      showToast('職アド通知を確認済みにしました')
    }
    setMatches([])
  }), [matches, run, showToast])

  return { matches, check, confirm }
}
