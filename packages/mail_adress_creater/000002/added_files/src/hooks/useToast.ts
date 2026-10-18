/**
 * トースト通知の表示状態を管理するカスタムフック
 */
import { useCallback, useState } from 'react'

export function useToast() {
  const [message, setMessage] = useState('')
  const [visible, setVisible] = useState(false)

  const showToast = useCallback((next: string) => {
    setMessage(next)
    setVisible(true)
  }, [])

  const hideToast = useCallback(() => {
    setVisible(false)
  }, [])

  return { message, visible, showToast, hideToast }
}
