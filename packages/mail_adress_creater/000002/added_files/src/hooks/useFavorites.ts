/**
 * お気に入り（宛先とCCのセット）の一覧と、編集モーダルの下書き状態
 */
import { useCallback, useEffect, useState } from 'react'
import { addFavorite, loadFavorites, saveFavorites, type Favorite } from '../utils/api'
import { formatFavoriteAddressText, parseFavoriteAddressText, stripFavoritePrefix } from '../utils/favorites'
import type { Operations } from './useOperation'

type Draft = { name: string; toText: string; ccText: string }

const EMPTY_DRAFT: Draft = { name: '', toText: '', ccText: '' }

const draftOf = (favorite: Favorite | undefined): Draft =>
  favorite
    ? {
        name: favorite.name,
        toText: formatFavoriteAddressText(favorite.addresses),
        ccText: formatFavoriteAddressText(favorite.cc_addresses ?? []),
      }
    : EMPTY_DRAFT

export function useFavorites({ run, setError, showToast }: Operations) {
  const [favorites, setFavorites] = useState<Favorite[]>([])
  const [selectedName, setSelectedName] = useState('')
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)

  /** 指定したお気に入りを選択して下書きに読み込む（未指定なら空の下書き） */
  const select = useCallback((favorite: Favorite | undefined) => {
    setSelectedName(favorite?.name ?? '')
    setDraft(draftOf(favorite))
  }, [])

  useEffect(() => {
    void run(null, 'お気に入りの読み込みに失敗しました', async () => {
      const result = await loadFavorites()
      setFavorites(result.favorites)
      select(result.favorites[0])
    })
  }, [run, select])

  /** DB削除など外部要因で一覧が変わったときに、選択中のお気に入りを保ったまま同期する */
  const syncFavorites = useCallback((next: Favorite[]) => {
    setFavorites(next)
    select(next.find(favorite => favorite.name === selectedName) ?? next[0])
  }, [select, selectedName])

  const updateDraft = useCallback((updates: Partial<Draft>) => {
    setDraft(prev => ({ ...prev, ...updates }))
  }, [])

  const startNew = useCallback(() => {
    let index = favorites.length + 1
    while (favorites.some(favorite => favorite.name === `新しいお気に入り${index}`)) {
      index += 1
    }
    setSelectedName('')
    setDraft({ ...EMPTY_DRAFT, name: `新しいお気に入り${index}` })
  }, [favorites])

  const saveDraft = useCallback(async () => {
    const name = draft.name.trim()
    const addresses = parseFavoriteAddressText(draft.toText)
    const cc_addresses = parseFavoriteAddressText(draft.ccText)
    if (!name) {
      setError('お気に入り名を入力してください')
      return
    }
    if (addresses.length === 0 && cc_addresses.length === 0) {
      setError('お気に入りの内容（宛先またはCC）を入力してください')
      return
    }
    await run(null, 'お気に入りの保存に失敗しました', async () => {
      const result = await saveFavorites([
        ...favorites.filter(favorite => favorite.name !== selectedName && favorite.name !== name),
        { name, addresses, cc_addresses },
      ])
      setFavorites(result.favorites)
      select(result.favorites.find(favorite => favorite.name === name) ?? { name, addresses, cc_addresses })
      showToast('お気に入りを保存しました')
    })
  }, [draft, favorites, run, select, selectedName, setError, showToast])

  const deleteSelected = useCallback(async () => {
    if (!selectedName) {
      setDraft(EMPTY_DRAFT)
      return
    }
    if (!window.confirm(`${selectedName} を削除します。よろしいですか？`)) {
      return
    }
    await run(null, 'お気に入りの削除に失敗しました', async () => {
      const result = await saveFavorites(favorites.filter(favorite => favorite.name !== selectedName))
      setFavorites(result.favorites)
      select(result.favorites[0])
      showToast('お気に入りを削除しました')
    })
  }, [favorites, run, select, selectedName, showToast])

  /** 一覧の右クリックから、1件をお気に入りに追加する */
  const addFromRecipient = useCallback(async (recipientName: string, isCc: boolean) => {
    const cleanName = stripFavoritePrefix(recipientName)
    const favoriteName = window.prompt('お気に入り名', cleanName)
    if (!favoriteName) {
      return
    }
    await run(null, 'お気に入り追加に失敗しました', async () => {
      const result = await addFavorite(favoriteName, isCc ? [] : [cleanName], isCc ? [cleanName] : [])
      setFavorites(result.favorites)
      select(result.favorite)
      showToast(`${result.favorite.name} をお気に入りに追加しました`)
    })
  }, [run, select, showToast])

  /** 現在の宛先・CCの選択状態を、名前を付けてお気に入りに追加する */
  const addFromSelection = useCallback(async (toNames: string[], ccNames: string[]) => {
    if (toNames.length === 0 && ccNames.length === 0) {
      setError('現在選択されている宛先またはCCがありません')
      return
    }
    const name = window.prompt('新しいお気に入りグループ名を入力してください')?.trim()
    if (!name) {
      return
    }
    await run(null, 'お気に入り追加に失敗しました', async () => {
      const result = await addFavorite(name, toNames.map(stripFavoritePrefix), ccNames.map(stripFavoritePrefix))
      setFavorites(result.favorites)
      showToast(`現在の宛先とCCを「${result.favorite.name}」として登録しました`)
    })
  }, [run, setError, showToast])

  return {
    favorites,
    selectedName,
    draft,
    select,
    syncFavorites,
    updateDraft,
    startNew,
    saveDraft,
    deleteSelected,
    addFromRecipient,
    addFromSelection,
  }
}

export type FavoritesController = ReturnType<typeof useFavorites>
