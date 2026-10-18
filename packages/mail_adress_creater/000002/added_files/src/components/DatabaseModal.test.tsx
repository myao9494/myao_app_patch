/**
 * DatabaseModalコンポーネントのテスト
 * テーブル切替、行の選択、settingsが削除不可であることを確認する
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DatabaseModal } from './DatabaseModal'
import type { DatabaseViewerController } from '../hooks/useDatabaseViewer'
import type { DatabaseSnapshot } from '../utils/api'

const snapshot: DatabaseSnapshot = {
  settings: [{ key: 'keywords', value: '["棚卸"]' }],
  recipients: [
    { name: '山田 太郎', count: 3, updated_at: '2026-05-14' },
    { name: '佐藤 一郎', count: 1, updated_at: '2026-05-13' },
  ],
  favorites: [],
  keyword_matches: [],
  job_runs: [],
}

function viewer(overrides: Partial<DatabaseViewerController> = {}): DatabaseViewerController {
  return {
    open: true,
    snapshot,
    table: 'recipients',
    selectedKeys: [],
    setSelectedKeys: vi.fn(),
    selectTable: vi.fn(),
    load: vi.fn(),
    close: vi.fn(),
    deleteSelected: vi.fn(),
    seedDummy: vi.fn(),
    ...overrides,
  } as DatabaseViewerController
}

describe('DatabaseModal', () => {
  it('閉じているとき、またはスナップショットが無いときは何も表示しない', () => {
    const { container, rerender } = render(<DatabaseModal viewer={viewer({ open: false })} runningAction={null} />)
    expect(container).toBeEmptyDOMElement()

    rerender(<DatabaseModal viewer={viewer({ snapshot: null })} runningAction={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('選択中テーブルの行を表示し、各テーブルの件数をボタンに出す', () => {
    render(<DatabaseModal viewer={viewer()} runningAction={null} />)

    expect(screen.getByText('山田 太郎')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'recipients (2)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'settings (1)' })).toBeInTheDocument()
  })

  it('行のチェックと全選択で、主キー(name)の配列を通知する', () => {
    const setSelectedKeys = vi.fn()
    render(<DatabaseModal viewer={viewer({ setSelectedKeys })} runningAction={null} />)

    fireEvent.click(screen.getByLabelText('山田 太郎を選択'))
    expect(setSelectedKeys).toHaveBeenLastCalledWith(['山田 太郎'])

    fireEvent.click(screen.getByLabelText('全レコードを選択'))
    expect(setSelectedKeys).toHaveBeenLastCalledWith(['山田 太郎', '佐藤 一郎'])
  })

  it('選択削除は、選択があるときだけ押せる', () => {
    const { rerender } = render(<DatabaseModal viewer={viewer()} runningAction={null} />)
    expect(screen.getByRole('button', { name: /選択削除/ })).toBeDisabled()

    rerender(<DatabaseModal viewer={viewer({ selectedKeys: ['山田 太郎'] })} runningAction={null} />)
    expect(screen.getByRole('button', { name: '選択削除 (1)' })).toBeEnabled()
  })

  it('settingsテーブルはチェックボックスを出さず、削除もできない', () => {
    render(<DatabaseModal viewer={viewer({ table: 'settings', selectedKeys: ['keywords'] })} runningAction={null} />)

    expect(screen.queryByLabelText('全レコードを選択')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /選択削除/ })).toBeDisabled()
  })

  it('テーブル切替・更新・閉じるのボタンが対応する操作を呼ぶ', () => {
    const v = viewer()
    render(<DatabaseModal viewer={v} runningAction={null} />)

    fireEvent.click(screen.getByRole('button', { name: 'settings (1)' }))
    fireEvent.click(screen.getByRole('button', { name: '更新' }))
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))

    expect(v.selectTable).toHaveBeenCalledWith('settings')
    expect(v.load).toHaveBeenCalled()
    expect(v.close).toHaveBeenCalled()
  })
})
