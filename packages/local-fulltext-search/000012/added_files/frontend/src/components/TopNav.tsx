/**
 * 画面上部のナビゲーション。
 * ページの切り替えタブと、検索画面で使う補助操作（検索対象への追加、インデックス状態、設定メニューの開閉）を表示する。
 */
import { SearchBar } from "./SearchBar";
import type { PageView } from "../appTypes";
import type { UseSearchTargetCoverageResult } from "../hooks/useSearchTargetCoverage";
import type { UseIndexStatusResult } from "../hooks/useIndexStatus";
import type { UseSearchResult } from "../hooks/useSearch";

type TopNavProps = {
  coverage: UseSearchTargetCoverageResult;
  indexing: UseIndexStatusResult;
  search: UseSearchResult;
  onChangePage: (nextView: PageView) => Promise<void>;
  pageView: PageView;
  onToggleMenu: () => void;
};

export function TopNav({ coverage, indexing, search, onChangePage, pageView, onToggleMenu }: TopNavProps) {
  const { handleAddCurrentPathToSearchTarget, isAddingLaunchPath, isLaunchPathAddable } = coverage;
  const {
    handleCancelIndexing,
    indexStatus,
    indexStatusLabel,
    indexStatusTone,
    isCancellingIndex,
    isIndexCancelling,
  } = indexing;
  const {
    createdFrom,
    createdTo,
    dateField,
    fullPath,
    handleApplyDateShortcut,
    handleClearCreatedDateFilter,
    handleFullPathChange,
    handleIncludeGanttTasksChange,
    handlePickFolder,
    handleSearch,
    handleSearchSourceChange,
    handleSearchTargetChange,
    handleToggleSearchAll,
    includeGanttTasks,
    indexDepth,
    isRegexEnabled,
    isSearchAllEnabled,
    isSearching,
    query,
    searchFilterText,
    searchSource,
    searchTarget,
    searchType,
    setCreatedFrom,
    setCreatedTo,
    setDateField,
    setIndexDepth,
    setIsRegexEnabled,
    setQuery,
    setSearchFilterText,
    setSearchType,
    setSortBy,
    setSortOrder,
    sortBy,
    sortOrder,
  } = search;

  return (
    <header className="top-nav">
      <div className="view-switcher" role="tablist" aria-label="ページ切替">
        <button
          className={`secondary-button page-tab ${pageView === "search" ? "active" : ""}`}
          onClick={() => void onChangePage("search")}
          type="button"
        >
          検索
        </button>
        <button
          className={`secondary-button page-tab ${pageView === "indexed-targets" ? "active" : ""}`}
          onClick={() => void onChangePage("indexed-targets")}
          type="button"
        >
          インデックス済みフォルダ
        </button>
        <button
          className={`secondary-button page-tab ${pageView === "indexed-web-targets" ? "active" : ""}`}
          onClick={() => void onChangePage("indexed-web-targets")}
          type="button"
        >
          インデックス済みWebページ
        </button>
        <button
          className={`secondary-button page-tab ${pageView === "search-targets" ? "active" : ""}`}
          onClick={() => void onChangePage("search-targets")}
          type="button"
        >
          検索対象フォルダ
        </button>
        <button
          className={`secondary-button page-tab ${pageView === "rule-management" ? "active" : ""}`}
          onClick={() => void onChangePage("rule-management")}
          type="button"
        >
          検索ルール管理
        </button>
        <button
          className={`secondary-button page-tab ${pageView === "vector-management" ? "active" : ""}`}
          onClick={() => void onChangePage("vector-management")}
          type="button"
        >
          ベクトル管理
        </button>
        <button
          className={`secondary-button page-tab ${pageView === "ai-input" ? "active" : ""}`}
          onClick={() => void onChangePage("ai-input")}
          type="button"
        >
          AIインプット
        </button>
        <button
          className={`secondary-button page-tab ${pageView === "launcher" ? "active" : ""}`}
          onClick={() => void onChangePage("launcher")}
          type="button"
        >
          ランチャー
        </button>
      </div>

      {pageView === "search" ? (
        <SearchBar
          query={query}
          fullPath={fullPath}
          indexDepth={indexDepth}
          searchFilterText={searchFilterText}
          searchSource={searchSource}
          searchType={searchType}
          includeGanttTasks={includeGanttTasks}
          searchTarget={searchTarget}
          dateField={dateField}
          sortBy={sortBy}
          sortOrder={sortOrder}
          createdFrom={createdFrom}
          createdTo={createdTo}
          isSearching={isSearching}
          isRegexEnabled={isRegexEnabled}
          isSearchAllEnabled={isSearchAllEnabled}
          indexStatusLabel={indexStatusLabel}
          indexStatusTone={indexStatusTone}
          isCancelDisabled={!indexStatus?.is_running || isCancellingIndex}
          isCancellingIndex={isCancellingIndex || isIndexCancelling}
          onQueryChange={setQuery}
          onFullPathChange={handleFullPathChange}
          onIndexDepthChange={setIndexDepth}
          onSearchFilterTextChange={setSearchFilterText}
          onSearchSourceChange={handleSearchSourceChange}
          onSearchTypeChange={(value) => {
            setSearchType(value);
            localStorage.setItem("search_type", value);
          }}
          onIncludeGanttTasksChange={handleIncludeGanttTasksChange}
          onSearchTargetChange={handleSearchTargetChange}
          onDateFieldChange={setDateField}
          onSortByChange={setSortBy}
          onSortOrderChange={setSortOrder}
          onCreatedFromChange={setCreatedFrom}
          onCreatedToChange={setCreatedTo}
          onApplyDateShortcut={handleApplyDateShortcut}
          onClearCreatedDateFilter={handleClearCreatedDateFilter}
          onCancelIndexing={() => void handleCancelIndexing()}
          onRegexToggle={() => setIsRegexEnabled((value) => !value)}
          onSearchAllToggle={handleToggleSearchAll}
          onPickFolder={() => void handlePickFolder()}
          showSearchTargetHint={isLaunchPathAddable}
          isAddingSearchTarget={isAddingLaunchPath}
          onAddSearchTarget={() => void handleAddCurrentPathToSearchTarget()}
          onSubmit={() => void handleSearch()}
          onToggleMenu={onToggleMenu}
        />
      ) : null}
    </header>
  );
}
