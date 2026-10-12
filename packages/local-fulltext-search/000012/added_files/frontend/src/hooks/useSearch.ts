/**
 * 検索画面の状態と操作。
 * - 検索条件（検索語・対象フォルダ・階層・検索方式・絞り込み・並び替え）と検索結果を持つ。
 * - 結果は 1 ページずつ取得し、一覧の末尾が見えたら次のページを読み込む。
 * - 既存インデックスで先に結果を返したときは、裏でのインデックス更新が終わってから同じ条件で自動的に再検索する。
 * - 起動 URL のパラメータで検索条件が渡されたときは、初回に 1 度だけ自動で検索する。
 */
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import {
  deleteFile,
  fetchSearchPage,
  openGanttTaskInput,
  pickFolder,
  recordSearchClick,
} from "../api/client";
import { DEFAULT_SEARCH_FILTER_TEXT } from "../appDefaults";
import type { PendingAutoRefresh, SearchExecutionParams, SearchSource, SearchTarget } from "../appTypes";
import { resolveRelativeDateInputValue, resolveTodayDateInputValue } from "../dateInput";
import { filterSearchResultsByExtensions } from "../extensionFilter";
import { claimAutoSearch, parseLaunchParams, shouldAutoSearch } from "../launchParams";
import { sortSearchResults } from "../searchResultSort";
import type { SearchResult } from "../types";
import type { IndexStatus } from "../types";

type UseSearchDeps = {
  /** 除外キーワードを 1 件追加して保存する。追加したら true、登録済みだったら false。 */
  addExcludeKeyword: (keyword: string) => Promise<boolean>;
  hasUnsavedExcludeKeywords: boolean;
  hasUnsavedSynonymGroups: boolean;
  hasUnsavedWebExcludeKeywords: boolean;
  indexStatus: IndexStatus | null;
  /** 設定メニューを開く（入力の誤りが設定メニュー内にあるときに呼ぶ）。 */
  openMenu: () => void;
  /** 失敗したファイルの一覧を開いていれば、読み込み直す。 */
  refreshFailedFilesIfOpen: () => Promise<void>;
  refreshIndexStatus: () => Promise<IndexStatus>;
  selectedIndexExtensions: string[];
  setErrorMessage: React.Dispatch<React.SetStateAction<string>>;
  setNoticeMessage: React.Dispatch<React.SetStateAction<string>>;
};

export function useSearch({
  addExcludeKeyword,
  hasUnsavedExcludeKeywords,
  hasUnsavedSynonymGroups,
  hasUnsavedWebExcludeKeywords,
  indexStatus,
  openMenu,
  refreshFailedFilesIfOpen,
  refreshIndexStatus,
  selectedIndexExtensions,
  setErrorMessage,
  setNoticeMessage,
}: UseSearchDeps) {
  const [launchParams] = useState(() => parseLaunchParams(window.location.search));
  const [searchType, setSearchType] = useState<"hybrid" | "vector" | "keyword">(() => (localStorage.getItem("search_type") as "hybrid" | "vector" | "keyword") || "hybrid");
  const [query, setQuery] = useState(() => launchParams.q);
  const [fullPath, setFullPath] = useState(() => launchParams.fullPath);
  const [indexDepth, setIndexDepth] = useState(() => launchParams.indexDepth);
  const [isSearchAllEnabled, setIsSearchAllEnabled] = useState(() => launchParams.searchAll);
  const [searchSource, setSearchSource] = useState<SearchSource>("local");
  const [includeGanttTasks, setIncludeGanttTasks] = useState(false);
  const [isRegexEnabled, setIsRegexEnabled] = useState(() => localStorage.getItem("regex_enabled") === "true");
  const [refreshWindowMinutes, setRefreshWindowMinutes] = useState(() => localStorage.getItem("refresh_window_minutes") ?? "0");
  const [searchFilterText, setSearchFilterText] = useState(() => {
    const stored = localStorage.getItem("search_filter_extensions");
    if (!stored) {
      return DEFAULT_SEARCH_FILTER_TEXT;
    }
    return stored;
  });
  const [searchTarget, setSearchTarget] = useState<SearchTarget>("all");
  const [dateField, setDateField] = useState<"created" | "modified">("modified");
  const [sortBy, setSortBy] = useState<"default" | "hybrid_score" | "vector_score" | "keyword_score" | "created" | "modified" | "click_count">("default");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdTo, setCreatedTo] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchNextOffset, setSearchNextOffset] = useState<number | null>(null);
  const [hasMoreResults, setHasMoreResults] = useState(false);
  const [currentSearchParams, setCurrentSearchParams] = useState<SearchExecutionParams | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMoreResults, setIsLoadingMoreResults] = useState(false);
  const [pendingAutoRefresh, setPendingAutoRefresh] = useState<PendingAutoRefresh | null>(null);
  const [isIgnoringResultPath, setIsIgnoringResultPath] = useState<string | null>(null);
  const sortedResults = sortSearchResults(results, { sortBy, sortOrder });
  const visibleResults = filterSearchResultsByExtensions(sortedResults, searchFilterText);
  const loadMoreTriggerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    localStorage.setItem("regex_enabled", String(isRegexEnabled));
  }, [isRegexEnabled]);

  /**
   * 検索中やインデックス実行中はステータスを定期取得し、中止ボタンの表示状態を追従させる。
   */
  useEffect(() => {
    if (!isSearching && !indexStatus?.is_running && !pendingAutoRefresh) {
      return;
    }

    const timerId = window.setInterval(() => {
      void refreshIndexStatus();
    }, 1000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [isSearching, indexStatus?.is_running, pendingAutoRefresh]);

  useEffect(() => {
    if (!pendingAutoRefresh || !indexStatus) {
      return;
    }

    if (pendingAutoRefresh.searchKey !== buildSearchKeyFromState()) {
      setPendingAutoRefresh(null);
      return;
    }

    if (!pendingAutoRefresh.hasObservedRunning) {
      if (indexStatus.is_running) {
        setPendingAutoRefresh((current) =>
          current ? { ...current, hasObservedRunning: true } : current,
        );
        return;
      }
      if (indexStatus.last_finished_at && indexStatus.last_finished_at !== pendingAutoRefresh.baselineLastFinishedAt) {
        const params = pendingAutoRefresh.params;
        setPendingAutoRefresh(null);
        void executeSearch(params, { isAutoRefresh: true });
      }
      return;
    }

    if (!indexStatus.is_running) {
      const params = pendingAutoRefresh.params;
      setPendingAutoRefresh(null);
      void executeSearch(params, { isAutoRefresh: true });
    }
  }, [
    pendingAutoRefresh,
    indexStatus,
    query,
    fullPath,
    isSearchAllEnabled,
    indexDepth,
    refreshWindowMinutes,
    isRegexEnabled,
    selectedIndexExtensions,
    dateField,
    sortBy,
    sortOrder,
    createdFrom,
    createdTo,
    searchTarget,
    searchSource,
    includeGanttTasks,
  ]);

  useEffect(() => {
    if (!shouldAutoSearch(launchParams)) {
      return;
    }

    const autoSearchKey = `${launchParams.q}\n${launchParams.fullPath}\n${launchParams.indexDepth}\n${launchParams.searchAll}`;
    if (!claimAutoSearch(autoSearchKey)) {
      return;
    }
    void handleSearch();
  }, [launchParams]);

  useEffect(() => {
    if (!loadMoreTriggerRef.current || !currentSearchParams || !hasMoreResults) {
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      const firstEntry = entries[0];
      if (!firstEntry?.isIntersecting) {
        return;
      }
      void loadMoreResults(currentSearchParams);
    }, { rootMargin: "320px 0px" });

    observer.observe(loadMoreTriggerRef.current);
    return () => observer.disconnect();
  }, [currentSearchParams, hasMoreResults, isLoadingMoreResults, isSearching, searchNextOffset]);

  function buildSearchKeyFromState(): string {
    return [
      query,
      fullPath.trim(),
      searchSource,
      String(includeGanttTasks),
      String(isSearchAllEnabled),
      indexDepth,
      refreshWindowMinutes,
      String(isRegexEnabled),
      searchTarget,
      selectedIndexExtensions.join(" "),
      dateField,
      sortBy,
      sortOrder,
      createdFrom,
      createdTo,
    ].join("\n");
  }

  async function executeSearch(params: SearchExecutionParams, options?: { isAutoRefresh?: boolean }): Promise<void> {
    try {
      setIsSearching(true);
      setIsLoadingMoreResults(false);
      setErrorMessage("");
      if (!options?.isAutoRefresh) {
        setNoticeMessage("");
      }
      setCurrentSearchParams(params);
      const response = await fetchSearchPage({
        ...params,
        limit: 50,
        offset: 0,
        include_snippets: true,
      });
      setResults(response.items);
      setSearchTotal(response.total);
      setHasMoreResults(response.has_more);
      setSearchNextOffset(response.next_offset);
      const latestStatus = await refreshIndexStatus();
      await refreshFailedFilesIfOpen();
      localStorage.setItem("refresh_window_minutes", String(params.refresh_window_minutes));
      localStorage.setItem("search_filter_extensions", searchFilterText);
      if (options?.isAutoRefresh) {
        setNoticeMessage("バックグラウンド再インデックスが完了したため、検索結果を自動更新しました。");
      } else if (searchSource === "local" && hasUnsavedExcludeKeywords) {
        setNoticeMessage("未保存の除外キーワードは今回の検索に反映していません。保存後に再検索してください。");
      } else if (searchSource === "web" && hasUnsavedWebExcludeKeywords) {
        setNoticeMessage("未保存のWeb除外キーワードは今回の検索に反映していません。保存後に再検索してください。");
      } else if (hasUnsavedSynonymGroups) {
        setNoticeMessage("未保存の同義語リストは今回の検索に反映していません。保存後に再検索してください。");
      } else if (response.background_refresh_scheduled) {
        setPendingAutoRefresh({
          params: { ...params, skip_refresh: true },
          searchKey: buildSearchKeyFromState(),
          baselineLastFinishedAt: latestStatus.last_finished_at,
          hasObservedRunning: latestStatus.is_running,
        });
        setNoticeMessage("既存インデックスで先に結果を表示しつつ、フォルダの再インデックスをバックグラウンドで更新しています。");
      } else if (response.used_existing_index) {
        setNoticeMessage("既存インデックスを使って検索結果を表示しました。");
      } else {
        setPendingAutoRefresh(null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "検索に失敗しました。";
      if (message === "Indexing was cancelled.") {
        setNoticeMessage("インデックス作成を中止しました。必要になったら再検索で再開できます。");
        setErrorMessage("");
      } else {
        setErrorMessage(message);
      }
    } finally {
      await refreshIndexStatus().catch(() => undefined);
      setIsSearching(false);
    }
  }

  async function loadMoreResults(params: SearchExecutionParams): Promise<void> {
    if (isSearching || isLoadingMoreResults || !hasMoreResults || searchNextOffset === null) {
      return;
    }

    try {
      setIsLoadingMoreResults(true);
      const response = await fetchSearchPage({
        ...params,
        limit: 50,
        offset: searchNextOffset,
        include_snippets: true,
      });
      setResults((current) => [...current, ...response.items]);
      setSearchTotal(response.total);
      setHasMoreResults(response.has_more);
      setSearchNextOffset(response.next_offset);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "検索結果の追加取得に失敗しました。");
    } finally {
      setIsLoadingMoreResults(false);
    }
  }

  async function handleSearch(): Promise<void> {
    if (isSearching) {
      return;
    }
    const normalizedInputPath = fullPath.trim();
    const resolvedSearchPath = normalizedInputPath;
    if (!query.trim()) {
      setErrorMessage("検索語を入力してください。");
      return;
    }
    const parsedWindow = Number(refreshWindowMinutes);
    let parsedDepth: number | undefined = undefined;
    if (indexDepth.trim()) {
      parsedDepth = Number(indexDepth);
      if (Number.isNaN(parsedDepth) || parsedDepth < 0) {
        setErrorMessage("階層数は 0 以上で入力してください。");
        return;
      }
    }
    if (Number.isNaN(parsedWindow) || parsedWindow < 0) {
      setErrorMessage("更新間隔は 0 以上の分で入力してください。");
      openMenu();
      return;
    }
    if (createdFrom && createdTo && createdFrom > createdTo) {
      setErrorMessage("作成日の終了日は開始日以降で入力してください。");
      return;
    }
    if (selectedIndexExtensions.length === 0) {
      setErrorMessage("インデックス対象の拡張子を 1 つ以上選択してください。");
      openMenu();
      return;
    }

    await executeSearch({
      q: query,
      full_path: resolvedSearchPath,
      search_all_enabled: isSearchAllEnabled,
      source_type: searchSource,
      search_type: searchType,
      include_gantt_tasks: includeGanttTasks,
      index_depth: parsedDepth,
      refresh_window_minutes: parsedWindow,
      regex_enabled: isRegexEnabled,
      search_target: searchTarget,
      index_types: selectedIndexExtensions.join(" "),
      types: searchFilterText.trim() || undefined,
      date_field: dateField,
      sort_by: sortBy,
      sort_order: sortOrder,
      created_from: createdFrom || undefined,
      created_to: createdTo || undefined,
    });
  }

  async function handlePickFolder(): Promise<void> {
    try {
      const payload = await pickFolder();
      setFullPath(payload.full_path ?? "");
      setErrorMessage("");
      setNoticeMessage("");
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "フォルダ選択に失敗しました。");
    }
  }

  /**
   * 全 DB 検索の切り替えでは入力済みパスを保持し、後でフォルダ検索へ戻りやすくする。
   */
  function handleToggleSearchAll(): void {
    setIsSearchAllEnabled((current) => !current);
    setErrorMessage("");
    setNoticeMessage("");
  }

  /**
   * フォルダ入力は全 DB 検索中でも保持し、次回のフォルダ限定検索へそのまま使えるようにする。
   */
  function handleFullPathChange(value: string): void {
    setFullPath(value);
  }

  function handleSearchTargetChange(value: SearchTarget): void {
    setSearchTarget(value);
  }

  function handleSearchSourceChange(value: SearchSource): void {
    setSearchSource(value);
    setErrorMessage("");
    setNoticeMessage("");
  }

  function handleIncludeGanttTasksChange(value: boolean): void {
    setIncludeGanttTasks(value);
    setErrorMessage("");
    setNoticeMessage("");
  }

  /**
   * 作成日フィルタは 2 項目まとめて解除し、未指定検索へ戻す。
   */
  function handleClearCreatedDateFilter(): void {
    setCreatedFrom("");
    setCreatedTo("");
    setErrorMessage("");
  }

  /**
   * よく使う相対日付のボタンから開始日と終了日を一度に入力する。
   */
  function handleApplyDateShortcut(days: number): void {
    setCreatedFrom(resolveRelativeDateInputValue(days));
    setCreatedTo(resolveTodayDateInputValue());
    setErrorMessage("");
    setNoticeMessage("");
  }

  /**
   * 検索結果を開いた回数を記録し、次回以降のアクセス数順ソートへ反映する。
   */
  function handleResultOpen(fileId: number): void {
    void recordSearchClick(fileId, query)
      .then((response) => {
        setResults((current) =>
          current.map((item) =>
            item.file_id === response.file_id ? { ...item, click_count: response.click_count } : item,
          ),
        );
      })
      .catch(() => undefined);
  }

  function handleGanttTaskOpen(taskId: number): void {
    void openGanttTaskInput(taskId).catch((error) => {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "gantt タスクを開けませんでした。");
    });
  }

  async function handleResultDelete(fileId: number, fullPath: string): Promise<void> {
    if (!window.confirm(`このファイルを完全に削除しますか？\n（物理ファイルが削除され元に戻せません）\n\n${fullPath}`)) {
      return;
    }
    
    try {
      await deleteFile(fileId, fullPath);
      setResults((current) => current.filter((item) => item.file_id !== fileId));
      setNoticeMessage("ファイルを削除しました。");
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "ファイルの削除に失敗しました。");
      setNoticeMessage("");
    }
  }

  /**
   * 検索結果のフルパスを除外キーワードへ追記し、以後の検索結果へ出さないようにする。
   */
  async function handleResultIgnore(_fileId: number, fullPath: string): Promise<void> {
    try {
      setIsIgnoringResultPath(fullPath);
      const wasAdded = await addExcludeKeyword(fullPath);
      setResults((current) => current.filter((item) => item.full_path !== fullPath));
      setSearchTotal((current) => Math.max(0, current - 1));
      setErrorMessage("");
      setNoticeMessage(
        wasAdded
          ? "無視リストへ追加しました。次回以降の検索結果から除外されます。"
          : "対象ファイルは既に無視リストへ追加済みです。",
      );
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "無視リストへの追加に失敗しました。");
    } finally {
      setIsIgnoringResultPath((currentPath) => (currentPath === fullPath ? null : currentPath));
    }
  }

  /** 検索結果を空にする（データベースの初期化やインデックスの削除で、結果が古くなったときに呼ぶ）。 */
  function clearResults(): void {
    setResults([]);
  }

  /** 全データベース検索を解除する（入力中のフォルダを検索対象へ追加し、そのフォルダを対象にするときに呼ぶ）。 */
  function disableSearchAll(): void {
    setIsSearchAllEnabled(false);
  }

  return {
    clearResults,
    createdFrom,
    createdTo,
    currentSearchParams,
    disableSearchAll,
    dateField,
    fullPath,
    handleApplyDateShortcut,
    handleClearCreatedDateFilter,
    handleFullPathChange,
    handleGanttTaskOpen,
    handleIncludeGanttTasksChange,
    handlePickFolder,
    handleResultDelete,
    handleResultIgnore,
    handleResultOpen,
    handleSearch,
    handleSearchSourceChange,
    handleSearchTargetChange,
    handleToggleSearchAll,
    hasMoreResults,
    includeGanttTasks,
    indexDepth,
    isIgnoringResultPath,
    isLoadingMoreResults,
    isRegexEnabled,
    isSearchAllEnabled,
    isSearching,
    loadMoreResults,
    loadMoreTriggerRef,
    query,
    refreshWindowMinutes,
    results,
    searchFilterText,
    searchSource,
    searchTarget,
    searchTotal,
    searchType,
    setCreatedFrom,
    setCreatedTo,
    setDateField,
    setIndexDepth,
    setIsRegexEnabled,
    setQuery,
    setRefreshWindowMinutes,
    setSearchFilterText,
    setSearchType,
    setSortBy,
    setSortOrder,
    sortBy,
    sortOrder,
    sortedResults,
    visibleResults,
  } as const;
}

export type UseSearchResult = ReturnType<typeof useSearch>;
