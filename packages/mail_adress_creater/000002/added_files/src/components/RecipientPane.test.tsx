/**
 * RecipientPaneコンポーネントの結合テスト
 * 検索、チェック、コピー機能の動作確認
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRef } from 'react'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { RecipientPane, type RecipientPaneRef } from './RecipientPane'
import type { Recipient } from '../types'

const mockRecipients: Recipient[] = [
  { name: '山田 太郎', count: 120 },
  { name: '山田 花子', count: 85 },
  { name: '佐藤 一郎', count: 200 },
  { name: '鈴木 恒一', count: 150 },
]

// デフォルトのプロパティ
const defaultProps = {
  title: '宛先（To）',
  buttonLabel: '宛先作成',
  recipients: mockRecipients,
  onCopySuccess: () => {},
  onNameCopy: () => {},
  onAddFavorite: () => {},
  isFocused: false,
  onFocus: () => {},
}

describe('RecipientPane', () => {
  beforeEach(() => {
    // クリップボードAPIをモック
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  it('初期状態で検索案内が表示される', () => {
    render(<RecipientPane {...defaultProps} />)

    expect(screen.getByText('検索キーワードを入力してEnter')).toBeInTheDocument()
  })

  it('タイトルとボタンラベルが表示される', () => {
    render(<RecipientPane {...defaultProps} title="CC" buttonLabel="CC作成" />)

    expect(screen.getByText('CC')).toBeInTheDocument()
    expect(screen.getByText('CC作成')).toBeInTheDocument()
  })

  it('検索実行で結果が表示される', () => {
    render(<RecipientPane {...defaultProps} />)

    const input = screen.getByPlaceholderText('検索キーワードを入力（Enterで実行）')
    fireEvent.change(input, { target: { value: '山田' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByText('山田 太郎')).toBeInTheDocument()
    expect(screen.getByText('山田 花子')).toBeInTheDocument()
    expect(screen.queryByText('佐藤 一郎')).not.toBeInTheDocument()
  })

  it('検索結果のチェックボックスは初期状態で全てON', () => {
    render(<RecipientPane {...defaultProps} />)

    const input = screen.getByPlaceholderText('検索キーワードを入力（Enterで実行）')
    fireEvent.change(input, { target: { value: '山田' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const checkboxes = screen.getAllByRole('checkbox')
    checkboxes.forEach(checkbox => {
      expect(checkbox).toBeChecked()
    })
  })

  it('チェックボックスクリックでチェックOFF', () => {
    render(<RecipientPane {...defaultProps} />)

    const input = screen.getByPlaceholderText('検索キーワードを入力（Enterで実行）')
    fireEvent.change(input, { target: { value: '山田' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // チェックボックスをクリック
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])

    expect(checkboxes[0]).not.toBeChecked()
    expect(checkboxes[1]).toBeChecked()
  })

  it('コピーボタンクリックでクリップボードにコピー', async () => {
    const onCopySuccess = vi.fn()

    render(<RecipientPane {...defaultProps} onCopySuccess={onCopySuccess} />)

    const input = screen.getByPlaceholderText('検索キーワードを入力（Enterで実行）')
    fireEvent.change(input, { target: { value: '山田' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const button = screen.getByText('宛先作成')
    await fireEvent.click(button)

    // 非同期処理を待つ
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(navigator.clipboard.writeText).toHaveBeenCalled()
    expect(onCopySuccess).toHaveBeenCalled()
  })

  it('該当なしの場合はメッセージ表示', () => {
    render(<RecipientPane {...defaultProps} />)

    const input = screen.getByPlaceholderText('検索キーワードを入力（Enterで実行）')
    fireEvent.change(input, { target: { value: '存在しない名前' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByText('該当する名前が見つかりませんでした')).toBeInTheDocument()
  })

  it('初期状態ではボタンが無効', () => {
    render(<RecipientPane {...defaultProps} />)

    const button = screen.getByText('宛先作成')
    expect(button).toBeDisabled()
  })

  it('名前クリックでクリップボードにコピー', async () => {
    const onNameCopy = vi.fn()

    render(<RecipientPane {...defaultProps} onNameCopy={onNameCopy} />)

    const input = screen.getByPlaceholderText('検索キーワードを入力（Enterで実行）')
    fireEvent.change(input, { target: { value: '山田' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // 名前をクリック
    const nameSpan = screen.getByText('山田 太郎')
    fireEvent.click(nameSpan)

    // 非同期処理を待つ
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('山田 太郎')
    expect(onNameCopy).toHaveBeenCalledWith('山田 太郎')
  })

  it('お気に入り名のクリックでは展開済みの中身をコピーする', async () => {
    render(
      <RecipientPane
        {...defaultProps}
        recipients={[
          { name: '★ 全員', count: 2, copyNames: ['山田 太郎', '佐藤 一郎'], favorite: true },
        ]}
      />,
    )

    const input = screen.getByPlaceholderText('検索キーワードを入力（Enterで実行）')
    fireEvent.change(input, { target: { value: '全員' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    fireEvent.click(screen.getByText('★ 全員'))

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('山田 太郎;佐藤 一郎')
  })

  it('右クリックメニューからお気に入りに追加できる', () => {
    const onAddFavorite = vi.fn()

    render(<RecipientPane {...defaultProps} onAddFavorite={onAddFavorite} />)

    const input = screen.getByPlaceholderText('検索キーワードを入力（Enterで実行）')
    fireEvent.change(input, { target: { value: '山田' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    fireEvent.contextMenu(screen.getByText('山田 太郎'))
    fireEvent.click(screen.getByText('お気に入りに追加'))

    expect(onAddFavorite).toHaveBeenCalledWith('山田 太郎', false)
  })

  it('CCペインの右クリックメニューからは、CC側のお気に入りとして追加される', () => {
    const onAddFavorite = vi.fn()

    render(<RecipientPane {...defaultProps} title="CC" isCc onAddFavorite={onAddFavorite} />)

    const input = screen.getByPlaceholderText('検索キーワードを入力（Enterで実行）')
    fireEvent.change(input, { target: { value: '山田' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    fireEvent.contextMenu(screen.getByText('山田 太郎'))
    fireEvent.click(screen.getByText('お気に入りに追加'))

    expect(onAddFavorite).toHaveBeenCalledWith('山田 太郎', true)
  })
})

describe('RecipientPane キーボード操作・表示', () => {
  const searchBox = () => screen.getByPlaceholderText('検索キーワードを入力（Enterで実行）')

  const search = (query: string) => {
    fireEvent.change(searchBox(), { target: { value: query } })
    fireEvent.keyDown(searchBox(), { key: 'Enter' })
  }

  const listContainer = () => screen.getByRole('heading', { name: '宛先（To）' }).closest('[tabindex="0"]') as HTMLElement

  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  it('一致しなかったキーワードを「未検出」として表示する', () => {
    render(<RecipientPane {...defaultProps} />)

    search('山田 存在しない')

    expect(screen.getByText('未検出:')).toBeInTheDocument()
    expect(screen.getByText('存在しない')).toBeInTheDocument()
  })

  it('フォントサイズは8〜20pxの範囲に収まる', () => {
    render(<RecipientPane {...defaultProps} />)
    const sizeInput = screen.getByRole('spinbutton')

    fireEvent.change(sizeInput, { target: { value: '99' } })
    expect(sizeInput).toHaveValue(20)

    fireEvent.change(sizeInput, { target: { value: '3' } })
    expect(sizeInput).toHaveValue(8)

    fireEvent.change(sizeInput, { target: { value: '' } })
    expect(sizeInput).toHaveValue(11)
  })

  it('検索ボックスでShift+Enterを押すと、検索して結果リストの先頭へ移動する', async () => {
    render(<RecipientPane {...defaultProps} isFocused />)
    fireEvent.change(searchBox(), { target: { value: '山田' } })

    fireEvent.keyDown(searchBox(), { key: 'Enter', shiftKey: true })

    await waitFor(() => expect(listContainer()).toHaveFocus())
    expect(screen.getByText('山田 太郎')).toBeInTheDocument()
  })

  it('検索ボックス ↓ でボタン、ボタン ↑ で検索ボックス、ボタン ↓ でリストへ移動する', () => {
    render(<RecipientPane {...defaultProps} isFocused />)
    search('山田')
    const button = screen.getByRole('button', { name: '宛先作成' })

    fireEvent.keyDown(searchBox(), { key: 'ArrowDown' })
    expect(button).toHaveFocus()

    fireEvent.keyDown(button, { key: 'ArrowUp' })
    expect(searchBox()).toHaveFocus()

    fireEvent.keyDown(searchBox(), { key: 'ArrowDown' })
    fireEvent.keyDown(button, { key: 'ArrowDown' })
    expect(listContainer()).toHaveFocus()
  })

  it('リストでは上下矢印で移動し、Spaceとモディファイア付きEnterでチェックを切り替え、Enterでコピーする', async () => {
    render(<RecipientPane {...defaultProps} isFocused />)
    search('山田')
    const container = listContainer()
    const rowBoxes = () => Array.from(container.querySelectorAll<HTMLInputElement>('li input[type="checkbox"]'))
    expect(rowBoxes().map(box => box.checked)).toEqual([true, true])

    fireEvent.keyDown(container, { key: ' ' })
    expect(rowBoxes().map(box => box.checked)).toEqual([false, true])

    fireEvent.keyDown(container, { key: 'ArrowDown' })
    fireEvent.keyDown(container, { key: 'Enter', ctrlKey: true })
    expect(rowBoxes().map(box => box.checked)).toEqual([false, false])

    fireEvent.keyDown(container, { key: 'ArrowUp' })
    fireEvent.keyDown(container, { key: 'Enter' })
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('山田 太郎'))
  })

  it('リスト先頭で↑を押すとボタンへ戻る', () => {
    render(<RecipientPane {...defaultProps} isFocused />)
    search('山田')

    fireEvent.keyDown(listContainer(), { key: 'ArrowUp' })

    expect(screen.getByRole('button', { name: '宛先作成' })).toHaveFocus()
  })

  it('お気に入り適用中はバッジを表示し、解除すると通常の一覧に戻る。チェック済みの名前は親から取得できる', () => {
    const ref = createRef<RecipientPaneRef>()
    render(<RecipientPane {...defaultProps} ref={ref} />)

    act(() => ref.current!.setQueryAndChecked('', ['山田 太郎', 'new@example.com'], '開発'))

    expect(screen.getByText(/お気に入り「開発」適用中/)).toBeInTheDocument()
    expect(ref.current!.getCheckedNames()).toEqual(['山田 太郎', 'new@example.com'])
    expect(screen.queryByText('佐藤 一郎')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /解除/ }))

    expect(screen.queryByText(/適用中/)).not.toBeInTheDocument()
    expect(screen.getByText('佐藤 一郎')).toBeInTheDocument()
  })
})
