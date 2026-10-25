/**
 * メインアプリケーションコンポーネント
 * ガントチャート（`/`）、グリッド編集（`/grid`）、APIガイド（`/api-guide`）をルーティングで切り替える。
 * ルーティングにより、複数のブラウザタブで各画面を別々に開いて並べて表示可能。
 * データの取得・保存は hooks/ 配下のフックに分けてあり、ここでは画面の組み立てを行う。
 **/
import { lazy, Suspense, useState, useEffect, useCallback, useMemo, useDeferredValue } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { Header } from './components/Header/Header';
import { CsvSyncSummaryModal } from './components/Header/CsvSyncSummaryModal';
import { GanttChart } from './components/GanttChart/GanttChart';
import type { TimeScale } from './components/GanttChart/ganttSetup';
import { GridDiffPanel } from './components/GridDiffPanel/GridDiffPanel';
import { useLocalStorage } from './hooks/useLocalStorage';
import { useGanttData } from './hooks/useGanttData';
import { useOpenInputRequests } from './hooks/useOpenInputRequests';
import { useGridStaging } from './hooks/useGridStaging';
import { useCalendarSettings, useObsidianCsvSync, useSynonyms } from './hooks/useAppSettings';
import * as api from './services/api';
import { DEFAULT_TASK_FILTER } from './constants/gantt';
import { buildTaskFilterIndexes, computeVisibleTreeTasks } from './utils/filterUtils';
import { planAutoMove } from './utils/autoMoveTasks';
import type { TaskFilter } from './types/gantt';
import './styles/variables.css';
import './App.css';

// 初回表示を軽くするため、使うときまで読み込まない画面（Univer は特に大きい）
const UniverSheet = lazy(() =>
  import('./components/UniverSheet/UniverSheet').then((module) => ({ default: module.UniverSheet }))
);
const DiffViewer = lazy(() =>
  import('./components/DiffViewer/DiffViewer').then((module) => ({ default: module.DiffViewer }))
);
const ApiGuide = lazy(() =>
  import('./components/ApiGuide/ApiGuide').then((module) => ({ default: module.ApiGuide }))
);

const lazyFallback = <div className="loading">読み込み中...</div>;

const defaultObsidianHome = '';
// 以前の版で既定値として保存されていたMac用のVaultパス。Windowsでは無効なので未設定に戻す
const legacyObsidianHome = '/Users/mine/000_work/obsidian-dagnetz';

/** ダウンロードファイル名用のタイムスタンプ（ローカル時刻の YYYYMMDDHHmmss） */
function formatFileTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function AppContent() {
  const location = useLocation();
  const viewMode = location.pathname === '/grid' ? 'grid' : 'gantt';

  const {
    tasks,
    links,
    loading,
    error,
    fetchData,
    updateTask,
    createTask,
    deleteTask,
    cloneTask,
    createLink,
    updateLink,
    deleteLink,
  } = useGanttData();
  const openInput = useOpenInputRequests();
  const calendar = useCalendarSettings();
  const synonyms = useSynonyms();

  // --- 表示設定（localStorage に保存） ---
  const [filter, setFilter] = useLocalStorage<TaskFilter>('gantt_filter', DEFAULT_TASK_FILTER);
  const [timeScale, setTimeScale] = useLocalStorage<TimeScale>('gantt_timeScale', 'month');
  const [taskListCollapsed, setTaskListCollapsed] = useLocalStorage('gantt_taskListCollapsed', false);
  const [displaySize, setDisplaySize] = useLocalStorage('gantt_displaySize', 100);
  const [gridWidth, setGridWidth] = useLocalStorage('gantt_gridWidth', 380);
  const [obsidianHome, setObsidianHome] = useLocalStorage('gantt_obsidianHome', defaultObsidianHome);
  const [diffPanelCollapsed, setDiffPanelCollapsed] = useLocalStorage('gantt_diffPanelCollapsed', false);

  // 検索文字列は入力のたびに変わるので、重いフィルタ計算には遅延させた値を使う
  const deferredSearchText = useDeferredValue(filter.searchText || '');
  const deferredSearchProject = useDeferredValue(filter.searchProject || '');
  const activeFilter = useMemo(
    () => ({
      ...filter,
      searchText: deferredSearchText,
      searchProject: deferredSearchProject,
    }),
    [filter, deferredSearchText, deferredSearchProject]
  );

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const platform = navigator.platform.toLowerCase();
    if (platform.includes('win') && obsidianHome === legacyObsidianHome) {
      setObsidianHome(defaultObsidianHome);
    }
  }, [obsidianHome, setObsidianHome]);

  // --- 画面の状態 ---
  // 全展開/全折りたたみ: カウンタを増やして GanttChart 側に実行させる
  const [expandAllTrigger, setExpandAllTrigger] = useState(0);
  const [collapseAllTrigger, setCollapseAllTrigger] = useState(0);
  const [isPrintMode, setIsPrintMode] = useState(false);
  const [showDiffViewer, setShowDiffViewer] = useState(false);
  const [showCsvSyncSummary, setShowCsvSyncSummary] = useState(false);

  const csvSync = useObsidianCsvSync(obsidianHome);
  const refetchData = useCallback(() => fetchData(false), [fetchData]);
  const grid = useGridStaging({ active: viewMode === 'grid', onCommitted: refetchData });

  // --- ハンバーガーメニューの操作 ---

  const handleExportCSV = async () => {
    const blob = await api.exportCSV();
    if (!blob) {
      alert('CSVのエクスポートに失敗しました');
      return;
    }

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `gantt_data_${formatFileTimestamp(new Date())}.zip`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleImportCSV = async (file: File) => {
    const result = await api.importCSV(file);
    if (result.success) {
      await fetchData();
    } else {
      alert(result.error || 'インポートに失敗しました');
    }
  };

  // タスク自動移動: 未完了タスクの開始日を今日に、プロジェクトの開始日を直近の月曜日に移動する
  const handleAutoMoveTasks = async () => {
    const moves = planAutoMove(tasks);
    if (moves.length === 0) {
      alert('移動対象のタスクがありません。');
      return;
    }

    let movedCount = 0;
    for (const move of moves) {
      const result = await api.updateTask(move.id, { start_date: move.start_date, end_date: move.end_date });
      if (result.success) movedCount += 1;
    }
    const failedCount = moves.length - movedCount;
    alert(
      failedCount === 0
        ? `${movedCount}件のタスクを移動しました。`
        : `${movedCount}件のタスクを移動しました。${failedCount}件は保存に失敗しました。`
    );
    await fetchData();
  };

  const handleShowCsvSyncSummary = async () => {
    const reloaded = await csvSync.reloadSummary();
    if (!reloaded) {
      alert('先にObsidianホームを設定してください。');
      return;
    }
    setShowCsvSyncSummary(true);
  };

  // Ctrl+B: タスクリスト（左側グリッド）の表示/非表示
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault();
        setTaskListCollapsed((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setTaskListCollapsed]);

  // グリッド表示用のタスク（Ganttと同じフィルタ判定を共有し、ツリー順に並べる）
  const taskFilterIndexes = useMemo(() => buildTaskFilterIndexes(tasks, synonyms), [tasks, synonyms]);
  const gridFilteredTasks = useMemo(() => {
    return computeVisibleTreeTasks(tasks, activeFilter, taskFilterIndexes, synonyms);
  }, [tasks, activeFilter, taskFilterIndexes, synonyms]);

  if (location.pathname === '/api-guide') {
    return <Suspense fallback={lazyFallback}><ApiGuide /></Suspense>;
  }

  const appClassName = `app ${isPrintMode ? 'print-mode' : ''}`;
  const header = (
    <Header
      filter={filter}
      onFilterChange={setFilter}
      onExpandAll={() => setExpandAllTrigger((prev) => prev + 1)}
      onCollapseAll={() => setCollapseAllTrigger((prev) => prev + 1)}
      onExportCSV={handleExportCSV}
      onImportCSV={handleImportCSV}
      onAutoMoveTasks={handleAutoMoveTasks}
      onDiffCompare={() => setShowDiffViewer(true)}
      timeScale={timeScale}
      onTimeScaleChange={setTimeScale}
      displaySize={displaySize}
      onDisplaySizeChange={setDisplaySize}
      isPrintMode={isPrintMode}
      onPrintModeToggle={() => setIsPrintMode((prev) => !prev)}
      gridWidth={gridWidth}
      onGridWidthChange={setGridWidth}
      obsidianHome={obsidianHome}
      onObsidianHomeChange={setObsidianHome}
      onShowCsvSyncSummary={handleShowCsvSyncSummary}
      holidaySettings={calendar.holidaySettings}
      onHolidaySettingsChange={calendar.setHolidaySettings}
      businessTripSettings={calendar.businessTripSettings}
      onBusinessTripSettingsChange={calendar.setBusinessTripSettings}
    />
  );

  if (loading) {
    return (
      <div className={appClassName}>
        {header}
        <main className="main">
          <div className="loading">読み込み中...</div>
        </main>
      </div>
    );
  }

  return (
    <div className={appClassName}>
      {header}

      <main className={`main ${taskListCollapsed ? 'collapsed' : ''}`}>
        {error && (
          <div className="error-banner">
            {error}
            <button onClick={() => fetchData(true)}>再試行</button>
          </div>
        )}
        <Routes>
          <Route path="/" element={
            <GanttChart
              tasks={tasks}
              links={links}
              timeScale={timeScale}
              gridCollapsed={taskListCollapsed}
              displaySize={displaySize}
              filter={activeFilter}
              expandAllTrigger={expandAllTrigger}
              collapseAllTrigger={collapseAllTrigger}
              onTaskUpdate={updateTask}
              onTaskCreate={createTask}
              onTaskDelete={deleteTask}
              onTaskClone={cloneTask}
              onLinkCreate={createLink}
              onLinkUpdate={updateLink}
              onLinkDelete={deleteLink}
              isPrintMode={isPrintMode}
              gridWidth={gridWidth}
              obsidianHome={obsidianHome}
              onFilterChange={setFilter}
              holidays={calendar.holidaySettings?.holidays || []}
              onAddHoliday={calendar.addHoliday}
              onRemoveHoliday={calendar.removeHoliday}
              businessTrips={calendar.businessTripSettings?.business_trips || []}
              synonyms={synonyms}
              externalOpenTaskRequest={openInput.request}
              onExternalOpenHandled={openInput.markHandled}
            />
          } />
          <Route path="/grid" element={
            <>
              {/* 差分パネル（左側） */}
              <GridDiffPanel
                diffs={grid.diffs}
                selectedDiff={grid.selectedDiff}
                onCommit={grid.commit}
                committing={grid.committing}
                collapsed={diffPanelCollapsed}
                onToggle={() => setDiffPanelCollapsed(!diffPanelCollapsed)}
                onRevert={grid.revert}
              />
              {/* Univer グリッド */}
              <Suspense fallback={lazyFallback}>
                <UniverSheet
                  visible={viewMode === 'grid'}
                  tasks={gridFilteredTasks}
                  links={links}
                  diffs={grid.diffs}
                  onCellSelect={grid.setSelectedDiff}
                  onDiffRefresh={grid.refreshDiffs}
                />
              </Suspense>
            </>
          } />
        </Routes>
      </main>

      {/* Collapse Toggle (ガントモードのみ) */}
      {viewMode === 'gantt' && (
        <button
          className={`collapse-toggle ${taskListCollapsed ? 'collapsed' : ''}`}
          onClick={() => setTaskListCollapsed(!taskListCollapsed)}
          title="タスクリスト表示/非表示 (Ctrl+B)"
          style={{ left: taskListCollapsed ? '8px' : `${gridWidth}px` }}
        >
          {taskListCollapsed ? '▶' : '◀'}
        </button>
      )}

      {/* Diff Viewer Modal */}
      {showDiffViewer && (
        <Suspense fallback={null}>
          <DiffViewer
            currentTasks={tasks}
            onClose={() => setShowDiffViewer(false)}
            onTaskUpdate={updateTask}
            onTaskCreate={createTask}
            onTaskDelete={deleteTask}
            onRefreshData={refetchData}
          />
        </Suspense>
      )}

      {showCsvSyncSummary && (
        <CsvSyncSummaryModal
          summary={csvSync.summary}
          error={csvSync.error}
          onClose={() => setShowCsvSyncSummary(false)}
        />
      )}
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AppContent />
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
