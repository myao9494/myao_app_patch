/**
 * メインアプリケーションコンポーネント
 * ガントチャートとプレーンなグリッド（Univer）の画面をルーティング（`/` と `/grid`）で切り替える
 * ルーティングにより、複数のブラウザタブで各画面を別々に開いて並べて表示可能
 **/
import { useState, useEffect, useCallback, useMemo, useDeferredValue } from 'react';
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { Header } from './components/Header/Header';
import { CsvSyncSummaryModal } from './components/Header/CsvSyncSummaryModal';
import { GanttChart } from './components/GanttChart/GanttChart';
import { UniverSheet } from './components/UniverSheet/UniverSheet';
import { DiffViewer } from './components/DiffViewer/DiffViewer';
import { GridDiffPanel } from './components/GridDiffPanel/GridDiffPanel';
import { ApiGuide } from './components/ApiGuide/ApiGuide';
import { useLocalStorage } from './hooks/useLocalStorage';
import * as api from './services/api';
import { formatDateString } from './constants/gantt';
import { buildTaskFilterIndexes, computeVisibleTreeTasks } from './utils/filterUtils';
import type {
  HolidaySettings,
  BusinessTripSettings,
  Task,
  Link as GanttLink,
  TaskFilter,
  GridDiffItem,
  CreateTaskRequest,
  ObsidianCsvSyncSummary,
  ObsidianCsvSyncSummaryNotFound,
} from './types/gantt';
import './styles/variables.css';
import './App.css';

const defaultFilter: TaskFilter = {
  searchText: '',
  searchProject: '',
  showCompleted: false,
  showType: 'all',
  pinnedMode: 'all',
  category: '',
  periodMode: 'before_today',  // デフォルトで今日以前表示
  dateRangeStart: 0,
  dateRangeEnd: 0,
};

const defaultObsidianHome = '';
const legacyObsidianHome = '/Users/mine/000_work/obsidian-dagnetz';

function AppContent() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [links, setLinks] = useState<GanttLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filter, setFilter] = useLocalStorage<TaskFilter>(
    'gantt_filter',
    defaultFilter
  );
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
  const [timeScale, setTimeScale] = useLocalStorage<
    'day' | 'month' | 'quarter' | 'year'
  >('gantt_timeScale', 'month');
  const [taskListCollapsed, setTaskListCollapsed] = useLocalStorage(
    'gantt_taskListCollapsed',
    false
  );
  const [displaySize, setDisplaySize] = useLocalStorage(
    'gantt_displaySize',
    100
  );
  const [gridWidth, setGridWidth] = useLocalStorage(
    'gantt_gridWidth',
    380
  );
  const [obsidianHome, setObsidianHome] = useLocalStorage(
    'gantt_obsidianHome',
    defaultObsidianHome
  );
  const [csvSyncSummary, setCsvSyncSummary] = useState<ObsidianCsvSyncSummary | ObsidianCsvSyncSummaryNotFound | null>(null);
  const [csvSyncSummaryError, setCsvSyncSummaryError] = useState<string | null>(null);
  const [showCsvSyncSummary, setShowCsvSyncSummary] = useState(false);
  const [holidaySettings, setHolidaySettings] = useState<HolidaySettings | null>(null);
  const [businessTripSettings, setBusinessTripSettings] = useState<BusinessTripSettings | null>(null);
  const [synonyms, setSynonyms] = useState<string[][]>([]);

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const platform = navigator.platform.toLowerCase();
    if (platform.includes('win') && obsidianHome === legacyObsidianHome) {
      setObsidianHome(defaultObsidianHome);
    }
  }, [obsidianHome, setObsidianHome]);

  // 表示モード: ガントチャート or グリッド
  const location = useLocation();
  const navigate = useNavigate();
  const viewMode = location.pathname === '/grid' ? 'grid' : 'gantt';
  const [externalOpenTaskRequest, setExternalOpenTaskRequest] = useState<{ requestId: number; taskId: number; attempt: number } | null>(null);
  const [lastHandledOpenInputRequestId, setLastHandledOpenInputRequestId] = useState(() =>
    Number(window.sessionStorage.getItem('gantt_lastOpenInputRequestId') || '0')
  );
  const [localUpdateSequence, setLocalUpdateSequence] = useState<number | null>(null);

  // Fetch data from API
  const fetchData = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    setError(null);
    const result = await api.getTasks();
    if (result.success && result.data) {
      setTasks(result.data.tasks || []);
      setLinks(result.data.links || []);
      // シーケンス番号を同期して不要なリロードを防止
      const seqResult = await api.getGanttUpdateSequence();
      if (seqResult.success && seqResult.data) {
        setLocalUpdateSequence(seqResult.data.sequence);
      }
    } else {
      setError(result.error || 'データの取得に失敗しました');
      // Use empty data if API fails
      setTasks([]);
      setLinks([]);
    }
    if (showLoading) setLoading(false);
  }, []);


  useEffect(() => {
    fetchData(true);
  }, [fetchData]);

  // 更新シーケンスのポーリングによる自動更新
  useEffect(() => {
    let cancelled = false;

    const checkUpdateSequence = async () => {
      const result = await api.getGanttUpdateSequence();
      if (cancelled || !result.success || !result.data) return;

      const currentSeq = result.data.sequence;
      if (localUpdateSequence === null) {
        setLocalUpdateSequence(currentSeq);
      } else if (currentSeq > localUpdateSequence) {
        // バックエンド側で更新があればデータを再取得
        await fetchData(false);
      }
    };

    void checkUpdateSequence();
    const timerId = window.setInterval(checkUpdateSequence, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [localUpdateSequence, fetchData]);


  useEffect(() => {
    const sendHeartbeat = () => {
      void api.sendTaskInputOpenClientHeartbeat();
    };

    sendHeartbeat();
    const timerId = window.setInterval(sendHeartbeat, 5000);

    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const pollOpenInputRequest = async () => {
      const result = await api.getTaskInputOpenRequest();
      if (cancelled || !result.success || !result.data) return;

      const request = result.data;
      if (request.request_id <= lastHandledOpenInputRequestId) return;

      setExternalOpenTaskRequest({
        requestId: request.request_id,
        taskId: request.task_id,
        attempt: Date.now(),
      });

      if (location.pathname !== '/') {
        navigate('/');
      }
    };

    pollOpenInputRequest();
    const timerId = window.setInterval(pollOpenInputRequest, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [lastHandledOpenInputRequestId, location.pathname, navigate]);

  const handleExternalOpenHandled = useCallback((requestId: number) => {
    setLastHandledOpenInputRequestId((prev) => {
      const next = Math.max(prev, requestId);
      window.sessionStorage.setItem('gantt_lastOpenInputRequestId', String(next));
      return next;
    });
    void api.acknowledgeTaskInputOpenRequest(requestId);
  }, []);

  useEffect(() => {
    const fetchHolidaySettings = async () => {
      const result = await api.getHolidays();
      if (result.success && result.data) {
        setHolidaySettings(result.data);
      }
    };

    fetchHolidaySettings();
  }, []);

  useEffect(() => {
    const fetchBusinessTripSettings = async () => {
      const result = await api.getBusinessTrips();
      if (result.success && result.data) {
        setBusinessTripSettings(result.data);
      }
    };

    fetchBusinessTripSettings();
  }, []);

  useEffect(() => {
    const fetchSynonyms = async () => {
      const result = await api.getSynonyms();
      if (result.success && result.data) {
        setSynonyms(result.data.groups || []);
      }
    };

    fetchSynonyms();
  }, []);

  useEffect(() => {
    const targetHome = obsidianHome.trim();
    if (!targetHome) {
      setCsvSyncSummary(null);
      setCsvSyncSummaryError(null);
      return;
    }

    let cancelled = false;

    const runSync = async () => {
      const result = await api.syncObsidianCsv(targetHome);
      if (cancelled) return;
      if (result.success && result.data) {
        setCsvSyncSummary(result.data);
        setCsvSyncSummaryError(null);
      } else {
        setCsvSyncSummaryError(result.error || 'Obsidian CSV同期に失敗しました');
      }
    };

    runSync();
    const timerId = window.setInterval(runSync, 30 * 60 * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [obsidianHome]);

  // Task handlers
  // バックエンドの応答データ（実際のDB状態）を使ってローカルステートを更新する
  const handleTaskUpdate = useCallback(async (id: number, taskData: Partial<Task>) => {
    const result = await api.updateTask(id, taskData);
    if (result.success && result.data) {
      // バックエンドの応答データをそのまま使い、ローカルステートとDBの一貫性を保つ
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, ...result.data } : t))
      );
    }
  }, []);

  // タスク作成ハンドラ: 作成後にタスクデータを返し、リロードする
  const handleTaskCreate = useCallback(async (taskData: Partial<Task>): Promise<Task | undefined> => {
    const requestData: CreateTaskRequest = {
      ...taskData,
      id: taskData.id,
      text: taskData.text || '新規タスク',
      start_date: taskData.start_date || new Date().toISOString().split('T')[0] + ' 00:00:00',
      end_date: taskData.end_date || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] + ' 00:00:00',
    };
    const result = await api.createTask(requestData);
    if (result.success && result.data) {
      // データをリロードして正しいソート順で表示
      await fetchData();
      return result.data;
    }
    return undefined;
  }, [fetchData]);

  const handleTaskDelete = useCallback(async (id: number) => {
    const result = await api.deleteTask(id);
    if (result.success && result.data) {
      const deletedIds = [result.data.deleted_id, ...result.data.deleted_children];
      setTasks((prev) => prev.filter((t) => !deletedIds.includes(t.id)));
    }
  }, []);

  // 休日追加ハンドラ
  const handleAddHoliday = useCallback(async (dateStr: string) => {
    try {
      const result = await api.addHoliday(dateStr);
      if (result.success && result.data) {
        setHolidaySettings(result.data);
      } else {
        alert(result.error || '休日の追加に失敗しました');
      }
    } catch (err) {
      console.error('Failed to add holiday:', err);
      alert('休日の追加に失敗しました');
    }
  }, []);

  // 休日解除ハンドラ
  const handleRemoveHoliday = useCallback(async (dateStr: string) => {
    try {
      const result = await api.deleteHoliday(dateStr);
      if (result.success && result.data) {
        setHolidaySettings(result.data);
      } else {
        alert(result.error || '休日の解除に失敗しました');
      }
    } catch (err) {
      console.error('Failed to remove holiday:', err);
      alert('休日の解除に失敗しました');
    }
  }, []);

  // Link handlers
  const handleLinkCreate = useCallback(async (linkData: Omit<GanttLink, 'id'>): Promise<GanttLink | undefined> => {
    const result = await api.createLink(linkData);
    if (result.success && result.data) {
      const newLink = result.data;
      setLinks((prev) => [...prev, newLink]);
      return newLink;
    }
    return undefined;
  }, []);

  const handleLinkUpdate = useCallback(async (id: number, linkData: Partial<GanttLink>) => {
    const result = await api.updateLink(id, linkData);
    if (result.success) {
      setLinks((prev) =>
        prev.map((l) => (l.id === id ? { ...l, ...linkData } : l))
      );
    }
  }, []);

  const handleLinkDelete = useCallback(async (id: number) => {
    const result = await api.deleteLink(id);
    if (result.success) {
      setLinks((prev) => prev.filter((l) => l.id !== id));
    }
  }, []);

  // Clone task handler
  // id: コピー元タスクID, targetId: 挿入先タスクID（そのタスクの後ろに挿入）
  const handleTaskClone = useCallback(async (id: number, targetId?: number) => {
    const result = await api.cloneTask(id, targetId);
    if (result.success && result.data) {
      // 再帰的コピーに対応するため、全データを再取得する
      await fetchData();
      return result.data;
    }
  }, [fetchData]);

  // Expand/Collapse - トリガーカウンタを使用してGantt内部を直接操作
  const [expandAllTrigger, setExpandAllTrigger] = useState(0);
  const [collapseAllTrigger, setCollapseAllTrigger] = useState(0);

  const handleExpandAll = () => {
    setExpandAllTrigger((prev) => prev + 1);
  };

  const handleCollapseAll = () => {
    setCollapseAllTrigger((prev) => prev + 1);
  };

  // Export/Import
  const handleExportCSV = async () => {
    const blob = await api.exportCSV();
    if (blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const now = new Date();
      const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
      a.href = url;
      a.download = `gantt_data_${timestamp}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const handleImportCSV = async (file: File) => {
    const result = await api.importCSV(file);
    if (result.success) {
      await fetchData();
    } else {
      alert(result.error || 'インポートに失敗しました');
    }
  };

  // Task自動移動
  // 未完了タスクの開始日を今日に、プロジェクトの開始日を直近の月曜日に移動
  const handleAutoMoveTasks = async () => {
    // 今日の日付（時刻は00:00:00）
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 直近の月曜日を取得
    const getMostRecentMonday = (baseDate: Date): Date => {
      const result = new Date(baseDate);
      const day = result.getDay();
      const diff = (day + 6) % 7; // Monday=0, Sunday=6
      result.setDate(result.getDate() - diff);
      return result;
    };

    const recentMonday = getMostRecentMonday(today);
    let modifiedCount = 0;

    // 各タスクをチェックして移動
    for (const task of tasks) {
      // 完了済みはスキップ
      if (task.progress >= 1 || task.is_pinned) {
        continue;
      }

      // タスクの開始日を取得
      const taskStartDate = task.start_date ? new Date(String(task.start_date).replace(' ', 'T')) : null;
      if (!taskStartDate) continue;
      taskStartDate.setHours(0, 0, 0, 0);

      // 将来のタスクはスキップ（開始日が今日より後）
      if (taskStartDate.getTime() > today.getTime()) {
        continue;
      }

      let targetStart: Date;
      if (task.kind_task === 1) {
        // task: 今日に移動
        targetStart = today;
      } else if (task.kind_task === 2) {
        // project: 直近の月曜日に移動
        targetStart = recentMonday;
      } else {
        // MS等はスキップ
        continue;
      }

      // 既にターゲット日ならスキップ
      if (taskStartDate.getTime() === targetStart.getTime()) {
        continue;
      }

      // 新しい開始日と終了日を計算
      const duration = task.duration || 1;
      const newEndDate = new Date(targetStart);
      newEndDate.setDate(newEndDate.getDate() + duration);

      // API経由で更新
      await api.updateTask(task.id, {
        start_date: formatDateString(targetStart),
        end_date: formatDateString(newEndDate),
      });

      modifiedCount++;
    }

    // 結果を通知し、データをリロード
    if (modifiedCount > 0) {
      alert(`${modifiedCount}件のタスクを移動しました。`);
      await fetchData();
    } else {
      alert('移動対象のタスクがありません。');
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+B - toggle task list
      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault();
        setTaskListCollapsed((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setTaskListCollapsed]);

  // グリッド専用フィルター（Ganttと同じ判定を共有）
  const taskFilterIndexes = useMemo(() => buildTaskFilterIndexes(tasks, synonyms), [tasks, synonyms]);
  const gridFilteredTasks = useMemo(() => {
    return computeVisibleTreeTasks(tasks, activeFilter, taskFilterIndexes, synonyms);
  }, [tasks, activeFilter, taskFilterIndexes, synonyms]);

  // Print Mode
  const [isPrintMode, setIsPrintMode] = useState(false);

  const togglePrintMode = () => {
    setIsPrintMode((prev) => !prev);
  };

  // Diff Compare Mode
  const [showDiffViewer, setShowDiffViewer] = useState(false);

  const handleDiffCompare = () => {
    setShowDiffViewer(true);
  };

  const handleShowCsvSyncSummary = useCallback(async () => {
    const targetHome = obsidianHome.trim();
    if (!targetHome) {
      alert('先にObsidianホームを設定してください。');
      return;
    }

    const result = await api.getObsidianCsvSyncSummary(targetHome);
    if (result.success && result.data) {
      setCsvSyncSummary(result.data);
      setCsvSyncSummaryError(null);
    } else {
      setCsvSyncSummaryError(result.error || '差分サマリの取得に失敗しました');
    }
    setShowCsvSyncSummary(true);
  }, [obsidianHome]);

  // --- グリッド差分管理 ---
  const [gridDiffs, setGridDiffs] = useState<GridDiffItem[]>([]);
  const [selectedDiff, setSelectedDiff] = useState<GridDiffItem | null>(null);
  const [gridCommitting, setGridCommitting] = useState(false);
  const [diffPanelCollapsed, setDiffPanelCollapsed] = useLocalStorage('gantt_diffPanelCollapsed', false);
  const [gridInitialized, setGridInitialized] = useState(false);

  // グリッドモード切り替え時にステージングを初期化
  useEffect(() => {
    if (viewMode === 'grid' && !gridInitialized) {
      api.initGrid().then((result) => {
        if (result.success) {
          setGridInitialized(true);
          // 差分取得（初期状態では差分なしのはず）
          api.getGridDiff().then((diffResult) => {
            if (diffResult.success && diffResult.data) {
              setGridDiffs(diffResult.data.diffs);
            }
          });
        }
      });
    }
    // グリッドモードから離れたら初期化フラグをリセット
    if (viewMode !== 'grid') {
      setGridInitialized(false);
      setGridDiffs([]);
      setSelectedDiff(null);
    }
  }, [viewMode, gridInitialized]);

  // 差分リフレッシュ
  const handleDiffRefresh = useCallback(async () => {
    const result = await api.getGridDiff();
    if (result.success && result.data) {
      setGridDiffs(result.data.diffs);
    }
  }, []);

  // アップロード（コミット）
  const handleGridCommit = useCallback(async () => {
    setGridCommitting(true);
    try {
      const result = await api.commitGrid();
      if (result.success && result.data) {
        const { updated_tasks, updated_links, errors } = result.data;
        if (errors.length > 0) {
          alert(`アップロードにエラーがありました: ${errors.join(', ')}`);
        } else {
          alert(`アップロード完了: Tasks ${updated_tasks}件, Links ${updated_links}件`);
        }
        // 本テーブルデータを再取得
        await fetchData();
        // ステージングも再初期化
        await api.initGrid();
        // 差分クリア
        setGridDiffs([]);
        setSelectedDiff(null);
      }
    } finally {
      setGridCommitting(false);
    }
  }, [fetchData]);

  // 元に戻す（Undo）
  const handleGridRevert = useCallback(async (item: GridDiffItem) => {
    const result = await api.revertGridDiff(item.table, item.id, item.field);
    if (result.success) {
      await handleDiffRefresh();
      // もし選択中だった差分を戻したなら選択解除
      if (selectedDiff?.id === item.id && selectedDiff?.field === item.field) {
        setSelectedDiff(null);
      }
    } else {
      alert(`元に戻す処理に失敗しました: ${result.error}`);
    }
  }, [handleDiffRefresh, selectedDiff]);

  if (location.pathname === '/api-guide') {
    return <ApiGuide />;
  }

  if (loading) {
    return (
      <div className={`app ${isPrintMode ? 'print-mode' : ''}`}>
        <Header
          filter={filter}
          onFilterChange={setFilter}
          onExpandAll={handleExpandAll}
          onCollapseAll={handleCollapseAll}
          onExportCSV={handleExportCSV}
          onImportCSV={handleImportCSV}
          onAutoMoveTasks={handleAutoMoveTasks}
          onDiffCompare={handleDiffCompare}
          timeScale={timeScale}
          onTimeScaleChange={setTimeScale}
          displaySize={displaySize}
          onDisplaySizeChange={setDisplaySize}
          isPrintMode={isPrintMode}
          onPrintModeToggle={togglePrintMode}
          gridWidth={gridWidth}
          onGridWidthChange={setGridWidth}
          obsidianHome={obsidianHome}
          onObsidianHomeChange={setObsidianHome}
          onShowCsvSyncSummary={handleShowCsvSyncSummary}
          holidaySettings={holidaySettings}
          onHolidaySettingsChange={setHolidaySettings}
          businessTripSettings={businessTripSettings}
          onBusinessTripSettingsChange={setBusinessTripSettings}
        />
        <main className="main">
          <div className="loading">読み込み中...</div>
        </main>
      </div>
    );
  }

  return (
    <div className={`app ${isPrintMode ? 'print-mode' : ''}`}>
      <Header
        filter={filter}
        onFilterChange={setFilter}
        onExpandAll={handleExpandAll}
        onCollapseAll={handleCollapseAll}
        onExportCSV={handleExportCSV}
        onImportCSV={handleImportCSV}
        onAutoMoveTasks={handleAutoMoveTasks}
        onDiffCompare={handleDiffCompare}
        timeScale={timeScale}
        onTimeScaleChange={setTimeScale}
        displaySize={displaySize}
        onDisplaySizeChange={setDisplaySize}
        isPrintMode={isPrintMode}
        onPrintModeToggle={togglePrintMode}
        gridWidth={gridWidth}
        onGridWidthChange={setGridWidth}
        obsidianHome={obsidianHome}
        onObsidianHomeChange={setObsidianHome}
        onShowCsvSyncSummary={handleShowCsvSyncSummary}
        holidaySettings={holidaySettings}
        onHolidaySettingsChange={setHolidaySettings}
        businessTripSettings={businessTripSettings}
        onBusinessTripSettingsChange={setBusinessTripSettings}
      />

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
              onTaskUpdate={handleTaskUpdate}
              onTaskCreate={handleTaskCreate}
              onTaskDelete={handleTaskDelete}
              onTaskClone={handleTaskClone}
              onLinkCreate={handleLinkCreate}
              onLinkUpdate={handleLinkUpdate}
              onLinkDelete={handleLinkDelete}
              isPrintMode={isPrintMode}
              gridWidth={gridWidth}
              obsidianHome={obsidianHome}
              onFilterChange={setFilter}
              holidays={holidaySettings?.holidays || []}
              onAddHoliday={handleAddHoliday}
              onRemoveHoliday={handleRemoveHoliday}
              businessTrips={businessTripSettings?.business_trips || []}
              synonyms={synonyms}
              externalOpenTaskRequest={externalOpenTaskRequest}
              onExternalOpenHandled={handleExternalOpenHandled}
            />
          } />
          <Route path="/grid" element={
            <>
              {/* 差分パネル（左側） */}
              <GridDiffPanel
                diffs={gridDiffs}
                selectedDiff={selectedDiff}
                onCommit={handleGridCommit}
                committing={gridCommitting}
                collapsed={diffPanelCollapsed}
                onToggle={() => setDiffPanelCollapsed(!diffPanelCollapsed)}
                onRevert={handleGridRevert}
              />
              {/* Univer グリッド */}
              <UniverSheet
                visible={viewMode === 'grid'}
                tasks={gridFilteredTasks}
                links={links}
                diffs={gridDiffs}
                onCellSelect={setSelectedDiff}
                onDiffRefresh={handleDiffRefresh}
              />
            </>
          } />
          <Route path="/api-guide" element={<ApiGuide />} />
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
        <DiffViewer
          currentTasks={tasks}
          onClose={() => setShowDiffViewer(false)}
          onTaskUpdate={handleTaskUpdate}
          onTaskCreate={handleTaskCreate}
          onTaskDelete={handleTaskDelete}
          onRefreshData={() => fetchData(false)}
        />
      )}

      {showCsvSyncSummary && (
        <CsvSyncSummaryModal
          summary={csvSyncSummary}
          error={csvSyncSummaryError}
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
