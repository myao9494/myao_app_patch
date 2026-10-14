/**
 * インデックス済みフォルダ・検索対象フォルダ・インデックス済み Web ページの一覧画面。
 * 3 つの画面で同じ枠組みを使い、表示する一覧と操作（選択して削除 / 有効・無効の切り替え・再インデックス）を切り替える。
 */
import type { UseIndexStatusResult } from "../hooks/useIndexStatus";
import type { UseIndexedTargetsResult } from "../hooks/useIndexedTargets";

type IndexedTargetsPageProps = {
  indexing: UseIndexStatusResult;
  targets: UseIndexedTargetsResult;
  isIndexedWebTargetsPage: boolean;
  isSearchTargetsPage: boolean;
  openLocationLabel: "Explorerで開く" | "Finderで開く";
  onToggleMenu: () => void;
};

export function IndexedTargetsPage({
  indexing,
  targets,
  isIndexedWebTargetsPage,
  isSearchTargetsPage,
  openLocationLabel,
  onToggleMenu,
}: IndexedTargetsPageProps) {
  const { indexStatus, isIndexCancelling } = indexing;
  const {
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
    searchTargetActionPath,
    searchTargets,
    selectedTargetPathSet,
    selectedTargetPaths,
    setFilterKeyword,
    setHideKeyword,
  } = targets;

  return (
    <section className="indexed-targets-panel">
      <div className="indexed-targets-panel-header">
        <div className="section-header">
          <div>
            <h2>{isSearchTargetsPage ? "検索対象フォルダ" : isIndexedWebTargetsPage ? "インデックス済みWebページ" : "インデックス済みフォルダ"}</h2>
            <div className="form-help">
              {isSearchTargetsPage
                ? "検索対象フォルダを有効/無効で管理し、必要なら再インデックスできます。"
                : isIndexedWebTargetsPage
                  ? "インデックス済みWebページをURLごとに確認し、必要なページを選択できます。"
                  : "どのフォルダがインデックスされているか確認し、選択して削除できます。"}
            </div>
          </div>
          <div className="section-header-actions">
            <span>{isSearchTargetsPage ? filteredSearchTargets.length : filteredTargets.length}件</span>
            <button className="menu-button" onClick={onToggleMenu} type="button" aria-label="設定">
              <svg fill="currentColor" viewBox="0 0 24 24" width="24" height="24">
                <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"></path>
              </svg>
            </button>
          </div>
        </div>

        <div className="indexed-targets-toolbar">
          <div className="indexed-targets-left-controls">
            <div className="indexed-targets-search-group">
              <input
                className="search-input indexed-targets-search"
                value={filterKeyword}
                onChange={(event) => setFilterKeyword(event.target.value)}
                placeholder="キーワードで絞り込み"
              />
              <button
                className="secondary-button indexed-targets-inline-button"
                onClick={handleClearFilterKeyword}
                type="button"
                disabled={!filterKeyword.trim()}
                aria-label="絞り込みをクリア"
              >
                クリア
              </button>
              {!isSearchTargetsPage ? (
                <button
                  className="secondary-button indexed-targets-inline-button"
                  onClick={isIndexedWebTargetsPage ? handleAppendFilterKeywordToWebExcludeKeywords : handleAppendFilterKeywordToExcludeKeywords}
                  type="button"
                  disabled={!filterKeyword.trim()}
                >
                  {isIndexedWebTargetsPage ? "Web除外キーワードへ追加" : "除外キーワードへ追加"}
                </button>
              ) : null}
            </div>
            <div className="indexed-targets-action-row">
              {isSearchTargetsPage ? (
                <button
                  className="secondary-button indexed-targets-secondary-action"
                  onClick={() => void handleToggleAllSearchTargets()}
                  type="button"
                  disabled={isUpdatingSearchTargets}
                >
                  {isAllFilteredSearchTargetsSelected ? "選択解除" : "すべて選択"}
                </button>
              ) : (
                <button className="secondary-button indexed-targets-secondary-action" onClick={handleToggleAllIndexedTargets} type="button">
                  {isAllFilteredSelected ? "選択解除" : "すべて選択"}
                </button>
              )}
              <button
                className="secondary-button indexed-targets-secondary-action"
                onClick={() => void (isSearchTargetsPage ? refreshSearchTargets() : refreshIndexedTargets(isIndexedWebTargetsPage ? "web" : "local"))}
                type="button"
                disabled={isLoadingTargets}
              >
                {isLoadingTargets ? "再読込中..." : "再読込"}
              </button>
              {isSearchTargetsPage ? (
                <button
                  className="secondary-button indexed-targets-primary-action"
                  onClick={() => void handleReindexSelectedSearchTargets()}
                  type="button"
                  disabled={filteredEnabledSearchTargets.length === 0 || isReindexingSearchTargets}
                >
                  {isReindexingSearchTargets ? "取得中..." : "インデックス取得"}
                </button>
              ) : (
                <button
                  className="secondary-button danger indexed-targets-primary-action"
                  onClick={() => void handleDeleteIndexedTargets()}
                  type="button"
                  disabled={selectedTargetPaths.length === 0 || isDeletingTargets || Boolean(indexStatus?.is_running)}
                >
                  {isDeletingTargets ? "削除中..." : isIndexedWebTargetsPage ? "選択したWebページのインデックスを削除" : "選択したフォルダのインデックスを削除"}
                </button>
              )}
            </div>
          </div>
        {!isSearchTargetsPage && (isDeletingTargets || indexStatus?.is_running) ? (
          <div className="indexed-targets-operation-status" role="status" aria-live="polite">
            <div>
              <strong>{isDeletingTargets ? "削除処理中" : isIndexCancelling ? "インデックス取得を中止中" : "インデックス取得中"}</strong>
              <span>
                {isDeletingTargets
                  ? "削除完了後、一覧に残っていないことを自動確認します。"
                  : `現在の取得対象: ${indexStatus?.total_files ?? 0}件。完了するまで削除は実行できません。`}
              </span>
            </div>
            <div className="indexed-targets-progress-bar" aria-hidden="true"><span /></div>
          </div>
        ) : null}
          {!isSearchTargetsPage ? (
            <div className="indexed-targets-search-group indexed-targets-hide-group">
              <textarea
                className="indexed-targets-hide-box"
                value={hideKeyword}
                onChange={(event) => setHideKeyword(event.target.value)}
                placeholder="必要フォルダを隠すキーワード"
                rows={4}
              />
              <button
                className="secondary-button indexed-targets-inline-button"
                onClick={handleClearHideKeyword}
                type="button"
                disabled={!hideKeyword.trim()}
                aria-label="非表示をクリア"
              >
                クリア
              </button>
            </div>
          ) : null}
        </div>

        <div className="form-help indexed-targets-selection-status">
          {isSearchTargetsPage
            ? `対象中: ${filteredEnabledSearchTargets.length}件 / 全${filteredSearchTargets.length}件`
            : normalizedFilterKeyword || hiddenKeywordCount > 0
              ? `絞り込み: ${normalizedFilterKeyword || "なし"} / 非表示: ${hiddenKeywordCount}件 / 選択中: ${selectedTargetPaths.length}件`
              : `選択中: ${selectedTargetPaths.length}件`}
        </div>
      </div>

      <div className="indexed-targets-list">
        {isSearchTargetsPage ? (
          filteredSearchTargets.length === 0 ? (
            <div className="empty-panel">
              <div>{searchTargets.length === 0 ? "まだ検索対象フォルダはありません。" : "条件に一致するフォルダはありません。"}</div>
            </div>
          ) : (
            filteredSearchTargets.map((item) => (
              <label className="target-list-item" key={item.full_path}>
                <div className="target-list-main target-list-main-compact">
                  <input
                    checked={item.is_enabled}
                    onChange={(event) => void handleToggleSearchTarget(item.full_path, event.target.checked)}
                    type="checkbox"
                    disabled={isUpdatingSearchTargets}
                  />
                  <div className="target-list-content target-list-content-compact">
                    <div className="target-list-path">{item.full_path}</div>
                    <div className="target-list-meta">
                      <span>状態: {item.is_enabled ? "対象" : "対象外"}</span>
                      <span>ファイル数: {item.indexed_file_count}</span>
                      <span>最終取得: {item.last_indexed_at ? new Date(item.last_indexed_at).toLocaleString() : "-"}</span>
                    </div>
                  </div>
                  <div className="target-list-actions">
                    <button
                      className="secondary-button small-btn"
                      onClick={(event) => {
                        event.preventDefault();
                        void handleDeleteSearchTarget(item.full_path);
                      }}
                      type="button"
                      disabled={Boolean(searchTargetActionPath)}
                    >
                      削除
                    </button>
                    <button
                      className="secondary-button small-btn"
                      onClick={(event) => {
                        event.preventDefault();
                        void handleDeleteSearchTargetIndex(item.full_path);
                      }}
                      type="button"
                      disabled={Boolean(searchTargetActionPath)}
                    >
                      インデックス削除
                    </button>
                    <button
                      className="secondary-button small-btn"
                      onClick={(event) => {
                        event.preventDefault();
                        void handleReindexSearchTarget(item.full_path);
                      }}
                      type="button"
                      disabled={Boolean(searchTargetActionPath)}
                    >
                      インデックス再取得
                    </button>
                  </div>
                </div>
              </label>
            ))
          )
        ) : (
          filteredTargets.length === 0 ? (
                <div className="empty-panel">
              <div>
                {indexedTargets.length === 0
                  ? isIndexedWebTargetsPage
                    ? "まだインデックス済みWebページはありません。"
                    : "まだインデックス済みフォルダはありません。"
                  : isIndexedWebTargetsPage
                    ? "条件に一致するWebページはありません。"
                    : "条件に一致するフォルダはありません。"}
              </div>
            </div>
          ) : (
            filteredTargets.map((item) => (
              <label className="target-list-item" key={item.full_path}>
                <div className="target-list-main">
                  <input
                    checked={selectedTargetPathSet.has(item.full_path)}
                    onChange={() => handleToggleIndexedTarget(item.full_path)}
                    type="checkbox"
                  />
                  <div className="target-list-content">
                    <div className="target-list-path">{item.full_path}</div>
                    <div className="target-list-meta">
                      {isIndexedWebTargetsPage ? <span>URL: {item.full_path}</span> : null}
                      <span>{isIndexedWebTargetsPage ? "ページ数" : "ファイル数"}: {item.indexed_file_count}</span>
                      <span>
                        最終取得: {item.last_indexed_at ? new Date(item.last_indexed_at).toLocaleString() : "-"}
                      </span>
                    </div>
                  </div>
                  <div className="target-list-actions">
                    <button
                      className="secondary-button small-btn"
                      onClick={(event) => {
                        event.preventDefault();
                        void handleOpenIndexedTargetLocation(item.full_path);
                      }}
                      type="button"
                      disabled={openingIndexedTargetPath === item.full_path}
                    >
                      {isIndexedWebTargetsPage
                        ? "Webページを開く"
                        : openingIndexedTargetPath === item.full_path
                          ? "開いています..."
                          : openLocationLabel}
                    </button>
                  </div>
                </div>
              </label>
            ))
          )
        )}
      </div>
    </section>
  );
}
