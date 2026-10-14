/**
 * アプリ全体の組み立て。
 *
 * 画面ごとの状態と操作は hooks/ のカスタムフックが持ち、表示は pages/ と components/ のコンポーネントが行う。
 * ここでは、表示中のページ・エラー / 通知メッセージ・設定ドロワーの開閉といった画面共通の状態を持ち、
 * フックどうしをつないで各画面へ渡す。
 * フックは App で 1 度だけ呼ぶ。ページを切り替えても、入力途中の内容や検索結果は失われない。
 */
import { useEffect, useState } from "react";

import { fetchAppSettings, resetDatabase } from "./api/client";
import type { PageView } from "./appTypes";
import { AiInputPage } from "./components/AiInputPage";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { TopNav } from "./components/TopNav";
import { VectorManagementPage } from "./components/VectorManagementPage";
import { useFailedFiles } from "./hooks/useFailedFiles";
import { useGeneralSettings } from "./hooks/useGeneralSettings";
import { useIndexStatus } from "./hooks/useIndexStatus";
import { useIndexedTargets } from "./hooks/useIndexedTargets";
import { useLauncher } from "./hooks/useLauncher";
import { useRuleManagement } from "./hooks/useRuleManagement";
import { useScheduler } from "./hooks/useScheduler";
import { useSearch } from "./hooks/useSearch";
import { useSearchTargetCoverage } from "./hooks/useSearchTargetCoverage";
import { IndexedTargetsPage } from "./pages/IndexedTargetsPage";
import { LauncherPage } from "./pages/LauncherPage";
import { RuleManagementPage } from "./pages/RuleManagementPage";
import { SchedulerPage } from "./pages/SchedulerPage";
import { SearchResultsPage } from "./pages/SearchResultsPage";

function App() {
  const [pageView, setPageView] = useState<PageView>("search");
  const [errorMessage, setErrorMessage] = useState("");
  const [noticeMessage, setNoticeMessage] = useState("");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [hasLoadedAppSettings, setHasLoadedAppSettings] = useState(false);
  const toggleMenu = (): void => setIsMenuOpen((isOpen) => !isOpen);
  const openMenu = (): void => setIsMenuOpen(true);
  const failedFilesPanel = useFailedFiles({
    setErrorMessage,
    setNoticeMessage,
  });
  const indexing = useIndexStatus({
    setErrorMessage,
    setNoticeMessage,
  });
  const generalSettings = useGeneralSettings({
    setErrorMessage,
    setNoticeMessage,
  });
  const rules = useRuleManagement({
    confirmIndexDeletion: generalSettings.confirmIndexDeletion,
    isRuleManagementPage: pageView === "rule-management",
    setErrorMessage,
    setNoticeMessage,
  });
  // フックどうしは、相手の状態を直接書き換えず、相手が公開する操作（「除外キーワードを追加する」など）を呼ぶ
  const search = useSearch({
    addExcludeKeyword: rules.addExcludeKeyword,
    hasUnsavedExcludeKeywords: rules.hasUnsavedExcludeKeywords,
    hasUnsavedSynonymGroups: rules.hasUnsavedSynonymGroups,
    hasUnsavedWebExcludeKeywords: generalSettings.hasUnsavedWebExcludeKeywords,
    indexStatus: indexing.indexStatus,
    openMenu,
    refreshFailedFilesIfOpen: failedFilesPanel.refreshFailedFilesIfOpen,
    refreshIndexStatus: indexing.refreshIndexStatus,
    selectedIndexExtensions: rules.selectedIndexExtensions,
    setErrorMessage,
    setNoticeMessage,
  });
  const targets = useIndexedTargets({
    appendExcludeKeywordDraft: rules.appendExcludeKeywordDraft,
    appendWebExcludeKeywordDraft: generalSettings.appendWebExcludeKeywordDraft,
    clearSearchResults: search.clearResults,
    hasLoadedAppSettings,
    isIndexedWebTargetsPage: pageView === "indexed-web-targets",
    openMenu,
    refreshIndexStatus: indexing.refreshIndexStatus,
    setErrorMessage,
    setNoticeMessage,
  });
  const coverage = useSearchTargetCoverage({
    addSearchTarget: targets.addSearchTarget,
    disableSearchAll: search.disableSearchAll,
    fullPath: search.fullPath,
    indexDepth: search.indexDepth,
    searchSource: search.searchSource,
    searchTargets: targets.searchTargets,
    setErrorMessage,
    setNoticeMessage,
  });
  const scheduler = useScheduler({
    pageView,
    setErrorMessage,
    setNoticeMessage,
  });
  const launcher = useLauncher({
    pageView,
    setErrorMessage,
    setNoticeMessage,
  });
  const [uiZoom, setUiZoom] = useState(() => {
    const saved = Number(localStorage.getItem("ui_zoom") ?? "100");
    return Number.isFinite(saved) ? Math.min(125, Math.max(75, saved)) : 100;
  });
  const [isResettingDatabase, setIsResettingDatabase] = useState(false);
  const openLocationLabel =
    typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("windows")
      ? "Explorerで開く"
      : "Finderで開く";

  async function loadInitialData(): Promise<void> {
    try {
      const appSettings = await fetchAppSettings();
      rules.applyLoadedSettings(appSettings);
      generalSettings.applyLoadedSettings(appSettings);
      targets.applyLoadedSettings(appSettings);
      launcher.applyLoadedSettings(appSettings);
      setHasLoadedAppSettings(true);
      await indexing.refreshIndexStatus();
      await scheduler.refreshSchedulerState();
      await launcher.refreshLauncherState();
      await targets.refreshSearchTargets();
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "初期データ取得に失敗しました。");
    }
  }

  useEffect(() => {
    void loadInitialData();
  }, []);

  function handleOpenSchedulerPage(): void {
    setPageView("scheduler");
    setIsMenuOpen(false);
    setErrorMessage("");
    setNoticeMessage("");
    void scheduler.refreshSchedulerState().catch(() => undefined);
  }

  /**
   * 管理ページを開くときに最新一覧を読み込み、検索ページへもすぐ戻れるようにする。
   */
  async function handleChangePage(nextView: PageView): Promise<void> {
    setPageView(nextView);
    setErrorMessage("");
    setNoticeMessage("");
    if (nextView === "indexed-targets" || nextView === "indexed-web-targets") {
      try {
        await targets.refreshIndexedTargets(nextView === "indexed-web-targets" ? "web" : "local");
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "インデックス済み対象の取得に失敗しました。");
      }
    }
    if (nextView === "search-targets") {
      try {
        await targets.refreshSearchTargets();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "検索対象フォルダの取得に失敗しました。");
      }
    }
    if (nextView === "scheduler") {
      try {
        await scheduler.refreshSchedulerState();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "スケジューラー設定の取得に失敗しました。");
      }
    }
    if (nextView === "launcher") {
      try {
        await launcher.refreshLauncherState();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "ランチャー状態の取得に失敗しました。");
      }
    }
  }

  /**
   * 利用者の確認後にインデックス DB を空へ戻し、画面の一覧とステータスも初期状態へそろえる。
   */
  async function handleResetDatabase(): Promise<void> {
    if (isResettingDatabase) {
      return;
    }

    const confirmed = window.confirm(
      "データベースを初期化します。\n検索インデックス、対象キャッシュ、失敗履歴がすべて消えます。続行しますか？",
    );
    if (!confirmed) {
      return;
    }

    try {
      setIsResettingDatabase(true);
      setErrorMessage("");
      setNoticeMessage("");
      const response = await resetDatabase();
      search.clearResults();
      failedFilesPanel.resetFailedFiles();
      targets.resetTargets();
      indexing.applyIndexStatus(response.status);
      setNoticeMessage("データベースを初期化しました。必要なら再検索すると再インデックスされます。");
    } catch (error) {
      setNoticeMessage("");
      setErrorMessage(error instanceof Error ? error.message : "データベースの初期化に失敗しました。");
    } finally {
      setIsResettingDatabase(false);
    }
  }

  /** アプリ内の表示倍率をブラウザー倍率とは別に保存・反映する。 */
  useEffect(() => {
    document.body.style.zoom = String(uiZoom / 100);
    localStorage.setItem("ui_zoom", String(uiZoom));
  }, [uiZoom]);

  return (
    <div className="page-shell">
      <TopNav
        coverage={coverage}
        indexing={indexing}
        search={search}
        onChangePage={handleChangePage}
        pageView={pageView}
        onToggleMenu={toggleMenu}
      />

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}
      {noticeMessage ? <div className="notice-banner">{noticeMessage}</div> : null}

      <main className="content-grid">
        {pageView === "search" ? (
          <SearchResultsPage search={search} />
        ) : pageView === "indexed-targets" || pageView === "search-targets" || pageView === "indexed-web-targets" ? (
          <IndexedTargetsPage
            indexing={indexing}
            targets={targets}
            isIndexedWebTargetsPage={pageView === "indexed-web-targets"}
            isSearchTargetsPage={pageView === "search-targets"}
            openLocationLabel={openLocationLabel}
            onToggleMenu={toggleMenu}
          />
        ) : pageView === "scheduler" ? (
          <SchedulerPage scheduler={scheduler} onToggleMenu={toggleMenu} />
        ) : pageView === "rule-management" ? (
          <RuleManagementPage rules={rules} onChangePage={handleChangePage} onToggleMenu={toggleMenu} />
        ) : pageView === "launcher" ? (
          <LauncherPage launcher={launcher} onToggleMenu={toggleMenu} />
        ) : pageView === "vector-management" ? (
          <VectorManagementPage confirmIndexDeletion={generalSettings.confirmIndexDeletion} />
        ) : pageView === "ai-input" ? (
          <AiInputPage
            results={search.results}
            excludeKeywords={rules.savedExcludeKeywords}
            initialExtensionFilter={search.searchFilterText?.trim() || "md"}
          />
        ) : null}

        <SettingsDrawer
          failedFilesPanel={failedFilesPanel}
          generalSettings={generalSettings}
          indexing={indexing}
          search={search}
          onChangePage={handleChangePage}
          onOpenSchedulerPage={handleOpenSchedulerPage}
          onResetDatabase={handleResetDatabase}
          isMenuOpen={isMenuOpen}
          isResettingDatabase={isResettingDatabase}
          onCloseMenu={() => setIsMenuOpen(false)}
          setUiZoom={setUiZoom}
          uiZoom={uiZoom}
        />
      </main>
    </div>
  );
}

export default App;
