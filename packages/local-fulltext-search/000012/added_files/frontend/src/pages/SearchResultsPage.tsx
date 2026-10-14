/**
 * 検索結果画面。
 * 結果の件数と一覧を表示する。一覧の末尾が見えると次のページを自動で読み込み、ボタンでも読み込める。
 */
import { ResultsList } from "../components/ResultsList";
import type { UseSearchResult } from "../hooks/useSearch";

type SearchResultsPageProps = {
  search: UseSearchResult;
};

export function SearchResultsPage({ search }: SearchResultsPageProps) {
  const {
    currentSearchParams,
    dateField,
    handleGanttTaskOpen,
    handleResultDelete,
    handleResultIgnore,
    handleResultOpen,
    hasMoreResults,
    isIgnoringResultPath,
    isLoadingMoreResults,
    loadMoreResults,
    loadMoreTriggerRef,
    searchFilterText,
    searchTotal,
    sortedResults,
    visibleResults,
  } = search;

  return (
    <section>
      <div className="section-header">
        <h2>Search Results</h2>
        <span>
          {searchFilterText.trim()
            ? `${visibleResults.length} / ${sortedResults.length}件表示`
            : `${visibleResults.length} / ${searchTotal}件`}
        </span>
      </div>
      <ResultsList
        items={visibleResults}
        dateField={dateField}
        onResultOpen={handleResultOpen}
        onGanttTaskOpen={handleGanttTaskOpen}
        onResultDelete={handleResultDelete}
        onResultIgnore={handleResultIgnore}
        ignoringResultPath={isIgnoringResultPath}
      />
      {hasMoreResults ? (
        <div className="search-results-footer">
          <div ref={loadMoreTriggerRef} className="search-results-trigger" />
          <button
            type="button"
            className="menu-button"
            onClick={() => currentSearchParams ? void loadMoreResults(currentSearchParams) : undefined}
            disabled={isLoadingMoreResults}
          >
            {isLoadingMoreResults ? "続きを読み込み中..." : "次の50件を表示"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
