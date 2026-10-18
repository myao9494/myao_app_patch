/**
 * フックのテスト用: 実際の useOperation と、呼び出しを記録するトーストを組み合わせた Operations を作る
 */
import { useMemo } from 'react'
import { vi } from 'vitest'
import { useOperation, type Operations } from '../hooks/useOperation'

export function useTestOperations() {
  const operation = useOperation()
  const showToast = useMemo(() => vi.fn<(message: string) => void>(), [])
  const { run, setError } = operation
  const operations = useMemo<Operations>(() => ({ run, setError, showToast }), [run, setError, showToast])
  return { operation, operations, showToast }
}
