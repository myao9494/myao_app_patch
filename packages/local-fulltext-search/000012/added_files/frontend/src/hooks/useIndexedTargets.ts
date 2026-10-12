/**
 * インデックス済みフォルダ一覧・検索対象フォルダ一覧（Web を含む）の状態と操作。
 * - 一覧の絞り込み（含む / 含まない）、選択、削除、再インデックス、検索対象の有効 / 無効の切り替えを扱う。
 * - 「含まない」キーワードは共有設定として保存し、次回も同じ条件で一覧を表示する。
 */
import type * as React from "react";
import { useEffect, useState } from "react";
import {
  addSearchTarget as requestAddSearchTarget,
  deleteIndexedTargets,
  deleteSearchTargets,
  fetchIndexedTargets,
  fetchSearchTargetCoverage,
  fetchSearchTargets,
  openFileLocation,
  reindexSearchTargets,
  setSearchTargetEnabled,
  updateAppSettings,
} from "../api/client";
import type { SearchSource } from "../appTypes";
import { filterIndexedTargets, filterSearchTargets } from "../indexedTargetFilter";
import { normalizeHiddenIndexedTargets } from "../settingsNormalization";
import type { AppSettings, IndexedTarget, SearchTargetFolder } from "../types";
import type { IndexStatus } from "../types";

type UseIndexedTargetsDeps = {
  /** 除外キーワードの下書きへ 1 件追記する。 */
  appendExcludeKeywordDraft: (keyword: string) => void;
  /** Web 用の除外キーワードの下書きへ 1 件追記する。 */
  appendWebExcludeKeywordDraft: (keyword: string) => void;
  /** 検索結果を空にする（インデックスを削除して結果が古くなったとき）。 */
  clearSearchResults: () => void;
  hasLoadedAppSettings: boolean;
  isIndexedWebTargetsPage: boolean;
  /** 設定メニューを開く。 */
  openMenu: () => void;
  refreshIndexStatus: () => Promise<IndexStatus>;
  setErrorMessage: React.Dispatch<React.SetStateAction<string>>;
  setNoticeMessage: React.Dispatch<React.SetStateAction<string>>;
};

export function useIndexedTargets({
  appendExcludeKeywordDraft,
  appendWebExcludeKeywordDraft,
  clearSearchResults,
  hasLoadedAppSettings,
  isIndexedWebTargetsPage,
  openMenu,
  refreshIndexStatus,
  setErrorMessage,
  setNoticeMessage,
}: UseIndexedTargetsDeps) {
  const [savedHiddenIndexedTargets, setSavedHiddenIndexedTargets] = useState("");
  const [indexedTargets, setIndexedTargets] = useState<IndexedTarget[]>([]);
  const [searchTargets, setSearchTargets] = useState<SearchTargetFolder[]>([]);
  const [selectedTargetPaths, setSelectedTargetPaths] = useState<string[]>([]);
  const [filterKeyword, setFilterKeyword] = useState("");
  const [hideKeyword, setHideKeyword] = useState("");
  const [isLoadingTargets, setIsLoadingTargets] = useState(false);
  const [isDeletingTargets, setIsDeletingTargets] = useState(false);
  const [isUpdatingSearchTargets, setIsUpdatingSearchTargets] = useState(false);
  const [isReindexingSearchTargets, setIsReindexingSearchTargets] = useState(false);
  const [searchTargetActionPath, setSearchTargetActionPath] = useState<string | null>(null);
  const [openingIndexedTargetPath, setOpeningIndexedTargetPath] = useState<string | null>(null);

  const normalizedFilterKeyword = filterKeyword.trim();
  const hiddenKeywordCount = normalizeHiddenIndexedTargets(hideKeyword).split(/\r?\n/).filter(Boolean).length;
  const filteredTargets = filterIndexedTargets(indexedTargets, filterKeyword, hideKeyword);
  const filteredTargetPaths = filteredTargets.map((item) => item.full_path);
  const filteredSearchTargets = filterSearchTargets(searchTargets, filterKeyword);
  const filteredEnabledSearchTargets = filteredSearchTargets.filter((item) => item.is_enabled);
  const filteredSearchTargetPaths = filteredSearchTargets.map((item) => item.full_path);
  const selectedTargetPathSet = new Set(selectedTargetPaths);
  const selectedFilteredCount = filteredTargetPaths.filter((path) => selectedTargetPathSet.has(path)).length;
  const isAllFilteredSelected = filteredTargetPaths.length > 0 && selectedFilteredCount === filteredTargetPaths.length;
  const isAllFilteredSearchTargetsSelected =
    filteredSearchTargets.length > 0 && filteredSearchTargets.every((item) => item.is_enabled);

  /**
   * インデックス済みフォルダ一覧を取得し、消えた選択状態は自動で外す。
   */
  async function refreshIndexedTargets(sourceType: SearchSource = "local"): Promise<IndexedTarget[]> {
    setIsLoadingTargets(true);
    try {
      const response = await fetchIndexedTargets(sourceType);
      setIndexedTargets(response.items);
      setSelectedTargetPaths((current) => current.filter((path) => response.items.some((item) => item.full_path === path)));
      return response.items;
    } finally {
      setIsLoadingTargets(false);
    }
  }

  /**
   * 検索対象フォルダ一覧を取得し、消えた選択状態を外す。
   */
  async function refreshSearchTargets(): Promise<void> {
    setIsLoadingTargets(true);
    try {
      const response = await fetchSearchTargets();
      setSearchTargets(response.items);
    } finally {
      setIsLoadingTargets(false);
    }
  }

  useEffect(() => {
    if (!hasLoadedAppSettings) {
      return;
    }
    const normalized = normalizeHiddenIndexedTargets(hideKeyword);
    if (normalized === savedHiddenIndexedTargets) {
      return;
    }

    const timerId = window.setTimeout(() => {
      void (async () => {
        try {
          const savedSettings = await updateAppSettings({ hidden_indexed_targets: normalized });
          const savedValue = normalizeHiddenIndexedTargets(savedSettings.hidden_indexed_targets);
          setSavedHiddenIndexedTargets(savedValue);
          setHideKeyword(savedValue);
        } catch (error) {
          setNoticeMessage("");
          setErrorMessage(error instanceof Error ? error.message : "非表示キーワードの保存に失敗しました。");
        }
      })();
    }, 400);

    return () => window.clearTimeout(timerId);
  }, [hasLoadedAppSettings, hideKeyword, savedHiddenIndexedTargets]);

  /**
   * キーワードで絞り込んだ範囲だけを全選択し、既存の選択は維持する。
   */
  function handleToggleAllIndexedTargets(): void {
    if (filteredTargetPaths.length === 0) {
      return;
    }
    setSelectedTargetPaths((current) => {
      const currentSet = new Set(current);
      if (filteredTargetPaths.every((path) => currentSet.has(path))) {
        return current.filter((path) => !filteredTargetPaths.includes(path));
      }
      const merged = new Set([...current, ...filteredTargetPaths]);
      return [...merged];
    });
  }

  function handleToggleIndexedTarget(folderPath: string): void {
    setSelectedTargetPaths((current) =>
      current.includes(folderPath) ? current.filter((item) => item !== folderPath) : [...current, folderPath],
    );
  }

  /**
   * インデックス済みフォルダ一覧から、そのフォルダ位置を OS のファイルマネージャーで開く。
   */
  async function handleOpenIndexedTargetLocation(folderPath: string): Promise<void> {
    if (isIndexedWebTargetsPage) {
      window.open(folderPath, "_blank", "noopener,noreferrer");
      return;
    }
    setOpeningIndexedTargetPath(folderPath);
    try {
      await openFileLocation(folderPath);
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "フォルダを開けませんでした。");
    } finally {
      setOpeningIndexedTargetPath((currentPath) => (currentPath === folderPath ? null : currentPath));
    }
  }

  /**
   * 画面内の確認用キーワードだけを消し、除外キーワードの設定値は保持する。
   */
  function handleClearFilterKeyword(): void {
    setFilterKeyword("");
  }

  /**
   * 必要フォルダを隠すキーワードだけを消し、不要候補抽出の絞り込みは維持する。
   */
  function handleClearHideKeyword(): void {
    setHideKeyword("");
  }

  /**
   * 不要候補抽出に使った絞り込みキーワードを除外キーワードへ追記し、入力欄だけ空に戻す。
   */
  function handleAppendFilterKeywordToExcludeKeywords(): void {
    const nextKeyword = filterKeyword.trim();
    if (!nextKeyword) {
      return;
    }
    appendExcludeKeywordDraft(nextKeyword);
    setFilterKeyword("");
    setErrorMessage("");
    setNoticeMessage(`「${nextKeyword}」を除外キーワードへ追加しました。保存すると次回検索から反映されます。`);
    openMenu();
  }

  /**
   * インデックス済み Web ページの絞り込みキーワードを Web 専用の除外キーワードへ追記する。
   */
  function handleAppendFilterKeywordToWebExcludeKeywords(): void {
    const nextKeyword = filterKeyword.trim();
    if (!nextKeyword) {
      return;
    }
    appendWebExcludeKeywordDraft(nextKeyword);
    setFilterKeyword("");
    setErrorMessage("");
    setNoticeMessage(`「${nextKeyword}」をWeb除外キーワードへ追加しました。保存すると次回Web検索から反映されます。`);
    openMenu();
  }

  async function handleToggleAllSearchTargets(): Promise<void> {
    if (isUpdatingSearchTargets || filteredSearchTargetPaths.length === 0) {
      return;
    }
    const nextEnabled = !isAllFilteredSearchTargetsSelected;
    try {
      setIsUpdatingSearchTargets(true);
      setErrorMessage("");
      setNoticeMessage("");
      for (const folderPath of filteredSearchTargetPaths) {
        const response = await setSearchTargetEnabled({ folder_path: folderPath, is_enabled: nextEnabled });
        setSearchTargets(response.items);
      }
      setNoticeMessage(
        nextEnabled
          ? `${filteredSearchTargetPaths.length}件を検索対象として有効化しました。`
          : `${filteredSearchTargetPaths.length}件を検索対象から除外しました。`,
      );
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "検索対象フォルダの更新に失敗しました。");
    } finally {
      setIsUpdatingSearchTargets(false);
    }
  }

  async function handleToggleSearchTarget(folderPath: string, isEnabled: boolean): Promise<void> {
    if (isUpdatingSearchTargets) {
      return;
    }
    try {
      setIsUpdatingSearchTargets(true);
      setErrorMessage("");
      setNoticeMessage("");
      const response = await setSearchTargetEnabled({ folder_path: folderPath, is_enabled: isEnabled });
      setSearchTargets(response.items);
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "検索対象フォルダの更新に失敗しました。");
    } finally {
      setIsUpdatingSearchTargets(false);
    }
  }

  async function handleReindexSelectedSearchTargets(): Promise<void> {
    if (isReindexingSearchTargets || filteredEnabledSearchTargets.length === 0) {
      return;
    }
    try {
      setIsReindexingSearchTargets(true);
      setErrorMessage("");
      setNoticeMessage("");
      const response = await reindexSearchTargets(filteredEnabledSearchTargets.map((item) => item.full_path));
      await refreshIndexedTargets();
      await refreshSearchTargets();
      await refreshIndexStatus().catch(() => undefined);
      setNoticeMessage(`${response.reindexed_count}件の検索対象フォルダをインデックス取得しました。`);
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "検索対象フォルダのインデックス取得に失敗しました。");
    } finally {
      setIsReindexingSearchTargets(false);
    }
  }

  async function handleDeleteSearchTarget(folderPath: string): Promise<void> {
    if (searchTargetActionPath) {
      return;
    }
    const confirmed = window.confirm(`検索対象フォルダから削除しますか？\n\n${folderPath}`);
    if (!confirmed) {
      return;
    }
    try {
      setSearchTargetActionPath(folderPath);
      setErrorMessage("");
      setNoticeMessage("");
      const response = await deleteSearchTargets([folderPath]);
      await refreshSearchTargets();
      const coverage = await fetchSearchTargetCoverage(folderPath).catch(() => null);
      if (coverage?.is_covered && coverage.covering_path) {
        setNoticeMessage(
          `${response.deleted_count}件の個別設定を削除しました。このフォルダは親フォルダ（${coverage.covering_path}）で引き続き検索対象です。`,
        );
      } else {
        setNoticeMessage(`${response.deleted_count}件の検索対象フォルダを削除しました。`);
      }
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "検索対象フォルダの削除に失敗しました。");
    } finally {
      setSearchTargetActionPath(null);
    }
  }

  async function handleDeleteSearchTargetIndex(folderPath: string): Promise<void> {
    if (searchTargetActionPath) {
      return;
    }
    const confirmed = window.confirm(`このフォルダ配下のインデックスを削除しますか？\n\n${folderPath}`);
    if (!confirmed) {
      return;
    }
    try {
      setSearchTargetActionPath(folderPath);
      setErrorMessage("");
      setNoticeMessage("");
      const response = await deleteIndexedTargets([folderPath]);
      await refreshIndexedTargets();
      await refreshSearchTargets();
      await refreshIndexStatus().catch(() => undefined);
      setNoticeMessage(`${response.deleted_count}件のインデックスを削除しました。`);
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "インデックス削除に失敗しました。");
    } finally {
      setSearchTargetActionPath(null);
    }
  }

  async function handleReindexSearchTarget(folderPath: string): Promise<void> {
    if (searchTargetActionPath) {
      return;
    }
    try {
      setSearchTargetActionPath(folderPath);
      setErrorMessage("");
      setNoticeMessage("");
      const response = await reindexSearchTargets([folderPath]);
      await refreshIndexedTargets();
      await refreshSearchTargets();
      await refreshIndexStatus().catch(() => undefined);
      setNoticeMessage(`${response.reindexed_count}件のインデックスを再取得しました。`);
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "インデックス再取得に失敗しました。");
    } finally {
      setSearchTargetActionPath(null);
    }
  }

  /**
   * 選択したフォルダのインデックスを削除し、一覧・検索結果・通知を更新する。
   */
  async function handleDeleteIndexedTargets(): Promise<void> {
    if (isDeletingTargets || selectedTargetPaths.length === 0) {
      return;
    }

    const currentStatus = await refreshIndexStatus().catch(() => null);
    if (currentStatus?.is_running) {
      setErrorMessage("");
      setNoticeMessage("インデックス取得中のため、削除は完了後に実行できます。ページ上部の進行表示で完了を確認してください。");
      return;
    }

    const confirmed = window.confirm(
      isIndexedWebTargetsPage
        ? "選択したWebページのインデックスを削除します。\n対象URLの検索インデックスと失敗履歴が消えます。続行しますか？"
        : "選択したフォルダのインデックスを削除します。\n対象フォルダ配下の検索インデックスと失敗履歴が消えます。続行しますか？",
    );
    if (!confirmed) {
      return;
    }

    try {
      const pathsToDelete = [...selectedTargetPaths];
      setIsDeletingTargets(true);
      setErrorMessage("");
      setNoticeMessage(`${pathsToDelete.length}件のインデックスを削除しています。完了後に一覧へ反映されたか確認します。`);
      const response = await deleteIndexedTargets(pathsToDelete);
      const refreshedTargets = await refreshIndexedTargets(isIndexedWebTargetsPage ? "web" : "local");
      await refreshIndexStatus().catch(() => undefined);
      const remainingPaths = pathsToDelete.filter((path) => refreshedTargets.some((item) => item.full_path === path));
      if (remainingPaths.length > 0) {
        throw new Error(`削除後の一覧確認で${remainingPaths.length}件が残っています。再読込して確認してください。`);
      }
      clearSearchResults();
      setSelectedTargetPaths([]);
      setNoticeMessage(`${response.deleted_count}件のインデックス済み${isIndexedWebTargetsPage ? "Webページ" : "フォルダ"}を削除し、一覧への反映を確認しました。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "インデックス済みフォルダの削除に失敗しました。";
      if (message.includes("Indexing is already running.")) {
        setErrorMessage("");
        setNoticeMessage("インデックス取得中のため、削除は完了後に実行できます。ページ上部の進行表示で完了を確認してください。");
      } else {
        setNoticeMessage("");
        setErrorMessage(message);
      }
    } finally {
      setIsDeletingTargets(false);
    }
  }

  /**
   * フォルダ（または Web ページの URL）を検索対象へ追加し、一覧を更新する。
   * indexDepth が null のときは階層を無制限として登録する。失敗したら例外を投げる。
   */
  async function addSearchTarget(folderPath: string, indexDepth: number | null): Promise<void> {
    const response = await requestAddSearchTarget(folderPath, indexDepth);
    setSearchTargets(response.items);
  }

  /** 一覧と選択を空にする（データベースを初期化したあとに呼ぶ）。 */
  function resetTargets(): void {
    setIndexedTargets([]);
    setSearchTargets([]);
    setSelectedTargetPaths([]);
  }

  /** 読み込んだ共有設定の「含まない」キーワードを、一覧の絞り込みへ反映する。 */
  function applyLoadedSettings(appSettings: AppSettings): void {
    const loadedHiddenIndexedTargets = normalizeHiddenIndexedTargets(appSettings.hidden_indexed_targets);
    setSavedHiddenIndexedTargets(loadedHiddenIndexedTargets);
    setHideKeyword(loadedHiddenIndexedTargets);
  }

  return {
    addSearchTarget,
    applyLoadedSettings,
    filterKeyword,
    filteredEnabledSearchTargets,
    filteredSearchTargets,
    filteredTargets,
    handleAppendFilterKeywordToExcludeKeywords,
    handleAppendFilterKeywordToWebExcludeKeywords,
    handleClearFilterKeyword,
    handleClearHideKeyword,
    handleDeleteIndexedTargets,
    handleDeleteSearchTarget,
    handleDeleteSearchTargetIndex,
    handleOpenIndexedTargetLocation,
    handleReindexSearchTarget,
    handleReindexSelectedSearchTargets,
    handleToggleAllIndexedTargets,
    handleToggleAllSearchTargets,
    handleToggleIndexedTarget,
    handleToggleSearchTarget,
    hiddenKeywordCount,
    hideKeyword,
    indexedTargets,
    isAllFilteredSearchTargetsSelected,
    isAllFilteredSelected,
    isDeletingTargets,
    isLoadingTargets,
    isReindexingSearchTargets,
    isUpdatingSearchTargets,
    normalizedFilterKeyword,
    openingIndexedTargetPath,
    refreshIndexedTargets,
    refreshSearchTargets,
    resetTargets,
    searchTargetActionPath,
    searchTargets,
    selectedTargetPathSet,
    selectedTargetPaths,
    setFilterKeyword,
    setHideKeyword,
  } as const;
}

export type UseIndexedTargetsResult = ReturnType<typeof useIndexedTargets>;
