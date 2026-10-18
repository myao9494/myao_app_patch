/**
 * useFavoritesフックのテスト
 * 保存時の入力検証、新規名の採番、削除、現在の選択状態からの追加を確認する
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useFavorites } from './useFavorites'
import { useTestOperations } from '../test/operations'
import { addFavorite, loadFavorites, saveFavorites, type Favorite } from '../utils/api'

vi.mock('../utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/api')>()),
  loadFavorites: vi.fn(),
  saveFavorites: vi.fn(),
  addFavorite: vi.fn(),
}))

const dev: Favorite = { name: '開発', addresses: ['山田', '佐藤'], cc_addresses: ['鈴木'] }
const sales: Favorite = { name: '営業', addresses: ['高橋'], cc_addresses: [] }

async function setup(initial: Favorite[] = [dev, sales]) {
  vi.mocked(loadFavorites).mockResolvedValue({ favorites: initial })
  const hook = renderHook(() => {
    const ops = useTestOperations()
    return { ...ops, favorites: useFavorites(ops.operations) }
  })
  await waitFor(() => expect(hook.result.current.favorites.favorites).toEqual(initial))
  return hook
}

describe('useFavorites', () => {
  beforeEach(() => {
    vi.mocked(saveFavorites).mockReset()
    vi.mocked(addFavorite).mockReset()
  })
  afterEach(() => vi.restoreAllMocks())

  it('読み込み後は先頭のお気に入りを選択し、下書きに内容を入れる', async () => {
    const { result } = await setup()

    expect(result.current.favorites.selectedName).toBe('開発')
    expect(result.current.favorites.draft).toEqual({ name: '開発', toText: '山田\n佐藤', ccText: '鈴木' })
  })

  it('新規作成では重複しない名前を採番し、空の下書きにする', async () => {
    const { result } = await setup([{ ...dev, name: '新しいお気に入り3' }, sales])

    act(() => result.current.favorites.startNew())

    expect(result.current.favorites.selectedName).toBe('')
    expect(result.current.favorites.draft).toEqual({ name: '新しいお気に入り4', toText: '', ccText: '' })
  })

  it('名前が空の保存はAPIを呼ばずにエラーを表示する', async () => {
    const { result } = await setup()
    act(() => result.current.favorites.updateDraft({ name: '  ' }))

    await act(() => result.current.favorites.saveDraft())

    expect(saveFavorites).not.toHaveBeenCalled()
    expect(result.current.operation.error).toBe('お気に入り名を入力してください')
  })

  it('宛先もCCも空の保存はAPIを呼ばずにエラーを表示する', async () => {
    const { result } = await setup()
    act(() => result.current.favorites.updateDraft({ toText: '', ccText: '' }))

    await act(() => result.current.favorites.saveDraft())

    expect(saveFavorites).not.toHaveBeenCalled()
    expect(result.current.operation.error).toContain('宛先またはCC')
  })

  it('名前を変えて保存すると、元の名前を置き換えた一覧をAPIへ送る', async () => {
    const { result } = await setup()
    const renamed = { name: '開発チーム', addresses: ['山田', '佐藤'], cc_addresses: ['鈴木'] }
    vi.mocked(saveFavorites).mockResolvedValue({ favorites: [sales, renamed] })
    act(() => result.current.favorites.updateDraft({ name: '開発チーム' }))

    await act(() => result.current.favorites.saveDraft())

    expect(saveFavorites).toHaveBeenCalledWith([sales, renamed])
    expect(result.current.favorites.selectedName).toBe('開発チーム')
    expect(result.current.showToast).toHaveBeenCalledWith('お気に入りを保存しました')
  })

  it('削除は確認ダイアログでキャンセルすると何もしない', async () => {
    const { result } = await setup()
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    await act(() => result.current.favorites.deleteSelected())

    expect(saveFavorites).not.toHaveBeenCalled()
  })

  it('削除すると残りの先頭を選択する', async () => {
    const { result } = await setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(saveFavorites).mockResolvedValue({ favorites: [sales] })

    await act(() => result.current.favorites.deleteSelected())

    expect(saveFavorites).toHaveBeenCalledWith([sales])
    expect(result.current.favorites.selectedName).toBe('営業')
  })

  it('現在の選択が空のときはお気に入りに追加せずエラーを表示する', async () => {
    const { result } = await setup()

    await act(() => result.current.favorites.addFromSelection([], []))

    expect(addFavorite).not.toHaveBeenCalled()
    expect(result.current.operation.error).toBe('現在選択されている宛先またはCCがありません')
  })

  it('現在の選択をお気に入りに追加するとき、★付きの名前は取り除く', async () => {
    const { result } = await setup()
    vi.spyOn(window, 'prompt').mockReturnValue(' 新グループ ')
    vi.mocked(addFavorite).mockResolvedValue({
      favorite: { name: '新グループ', addresses: ['山田'], cc_addresses: ['営業'] },
      favorites: [dev, sales],
    })

    await act(() => result.current.favorites.addFromSelection(['山田'], ['★ 営業']))

    expect(addFavorite).toHaveBeenCalledWith('新グループ', ['山田'], ['営業'])
  })

  it('名前入力をキャンセルしたら追加しない', async () => {
    const { result } = await setup()
    vi.spyOn(window, 'prompt').mockReturnValue(null)

    await act(() => result.current.favorites.addFromSelection(['山田'], []))

    expect(addFavorite).not.toHaveBeenCalled()
  })

  it('DB側の削除後の同期では、選択中のお気に入りが残っていれば選択を保つ', async () => {
    const { result } = await setup()
    act(() => result.current.favorites.select(sales))

    act(() => result.current.favorites.syncFavorites([sales]))
    expect(result.current.favorites.selectedName).toBe('営業')

    act(() => result.current.favorites.syncFavorites([dev]))
    expect(result.current.favorites.selectedName).toBe('開発')
  })

  it('一覧の右クリックから追加すると、Toの場合は宛先側、CCの場合はCC側に1件だけ登録する', async () => {
    const { result } = await setup()
    vi.spyOn(window, 'prompt').mockReturnValue('単発')
    vi.mocked(addFavorite).mockResolvedValue({
      favorite: { name: '単発', addresses: ['山田'], cc_addresses: [] },
      favorites: [dev, sales],
    })

    await act(() => result.current.favorites.addFromRecipient('★ 山田', false))
    expect(addFavorite).toHaveBeenLastCalledWith('単発', ['山田'], [])
    expect(result.current.favorites.selectedName).toBe('単発')

    await act(() => result.current.favorites.addFromRecipient('鈴木', true))
    expect(addFavorite).toHaveBeenLastCalledWith('単発', [], ['鈴木'])
  })

  it('一覧の右クリックからの追加は、名前入力をキャンセルしたら何もしない', async () => {
    const { result } = await setup()
    vi.spyOn(window, 'prompt').mockReturnValue('')

    await act(() => result.current.favorites.addFromRecipient('山田', false))

    expect(addFavorite).not.toHaveBeenCalled()
  })

  it('保存に失敗したらエラーを表示し、下書きは保持する', async () => {
    const { result } = await setup()
    vi.mocked(saveFavorites).mockRejectedValue(new Error('保存できません'))
    act(() => result.current.favorites.updateDraft({ toText: '新しい宛先' }))

    await act(() => result.current.favorites.saveDraft())

    expect(result.current.operation.error).toBe('保存できません')
    expect(result.current.favorites.draft.toText).toBe('新しい宛先')
  })

  it('新規の下書きを削除しようとすると、確認なしで下書きを空にする', async () => {
    const { result } = await setup()
    act(() => result.current.favorites.startNew())
    const confirm = vi.spyOn(window, 'confirm')

    await act(() => result.current.favorites.deleteSelected())

    expect(confirm).not.toHaveBeenCalled()
    expect(result.current.favorites.draft).toEqual({ name: '', toText: '', ccText: '' })
  })
})
