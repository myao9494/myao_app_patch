/**
 * ヘッダーツールバー
 * 画面切替、ハンバーガーメニュー、検索・フィルター（表示期間、完了、固定、種別、オーナー）、タイムスケール切替を提供する。
 * ツールバー内は左右の矢印キーでフォーカスを移動できる。
 */
import { useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTheme } from '../../contexts/useTheme';
import { DEFAULT_TASK_FILTER } from '../../constants/gantt';
import { useSyncedState } from '../../hooks/useSyncedState';
import { HamburgerMenu } from './HamburgerMenu';
import { DayRangeInput, type DayRangeSide } from './DayRangeInput';
import { OptionButtonGroup } from './OptionButtonGroup';
import { handleButtonArrowKeys, handleInputArrowKeys, handleSelectArrowKeys } from './toolbarNavigation';
import type { BusinessTripSettings, HolidaySettings, TaskFilter } from '../../types/gantt';
import './Header.css';

const PERIOD_MODE_OPTIONS = [
  { value: 'all', label: 'ALL' },
  { value: 'before_today', label: '今日以前' },
  { value: 'limited', label: '期間限定' },
] as const;

const COMPLETED_OPTIONS = [
  { value: false, label: '未完了' },
  { value: true, label: '全て' },
] as const;

const TYPE_OPTIONS = [
  { value: 'all', label: '全て' },
  { value: 'task', label: 'task' },
  { value: 'project', label: 'pro' },
] as const;

const TIME_SCALE_OPTIONS = [
  { value: 'day', label: '日' },
  { value: 'month', label: '月' },
  { value: 'quarter', label: '四' },
  { value: 'year', label: '年' },
] as const;

interface HeaderProps {
  filter: TaskFilter;
  onFilterChange: (filter: TaskFilter) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onExportCSV: () => void;
  onImportCSV: (file: File) => void;
  onAutoMoveTasks: () => void;
  onDiffCompare: () => void; // 差分比較
  timeScale: 'day' | 'month' | 'quarter' | 'year';
  onTimeScaleChange: (scale: 'day' | 'month' | 'quarter' | 'year') => void;
  displaySize: number;
  onDisplaySizeChange: (size: number) => void;
  isPrintMode: boolean;
  onPrintModeToggle: () => void;
  gridWidth: number;
  onGridWidthChange: (width: number) => void;
  obsidianHome: string;
  onObsidianHomeChange: (path: string) => void;
  onShowCsvSyncSummary: () => void;
  holidaySettings: HolidaySettings | null;
  onHolidaySettingsChange: (settings: HolidaySettings) => void;
  businessTripSettings: BusinessTripSettings | null;
  onBusinessTripSettingsChange: (settings: BusinessTripSettings) => void;
}

export function Header({
  filter,
  onFilterChange,
  onExpandAll,
  onCollapseAll,
  onExportCSV,
  onImportCSV,
  onAutoMoveTasks,
  onDiffCompare,
  timeScale,
  onTimeScaleChange,
  displaySize,
  onDisplaySizeChange,
  isPrintMode,
  onPrintModeToggle,
  gridWidth,
  onGridWidthChange,
  obsidianHome,
  onObsidianHomeChange,
  onShowCsvSyncSummary,
  holidaySettings,
  onHolidaySettingsChange,
  businessTripSettings,
  onBusinessTripSettingsChange,
}: HeaderProps) {
  const { darkMode, toggleDarkMode } = useTheme();
  const { pathname } = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dateStartInputRef = useRef<HTMLInputElement>(null);
  const dateEndInputRef = useRef<HTMLInputElement>(null);

  // 入力中の値を保持（"-"や空文字も許容）。フィルターが外部から変更された場合はその値に合わせる
  const [searchTextInput, setSearchTextInput] = useSyncedState(filter.searchText || '');
  const [searchProjectInput, setSearchProjectInput] = useSyncedState(filter.searchProject || '');
  const [dateStartInput, setDateStartInput] = useSyncedState(String(filter.dateRangeStart ?? 0));
  const [dateEndInput, setDateEndInput] = useSyncedState(String(filter.dateRangeEnd ?? 0));

  // 検索欄の入力を少し待ってからフィルターに反映する。
  // 検索語がある間は、完了済み・全期間も対象にする
  useEffect(() => {
    const nextSearchText = searchTextInput;
    const nextSearchProject = searchProjectInput;
    if (
      nextSearchText === (filter.searchText || '') &&
      nextSearchProject === (filter.searchProject || '')
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      const hasSearch = nextSearchText.trim() !== '' || nextSearchProject.trim() !== '';
      onFilterChange({
        ...filter,
        searchText: nextSearchText,
        searchProject: nextSearchProject,
        ...(hasSearch
          ? {
              showCompleted: true,
              periodMode: 'all' as const,
            }
          : {}),
      });
    }, 180);

    return () => window.clearTimeout(timer);
  }, [searchTextInput, searchProjectInput, filter, onFilterChange]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onImportCSV(file);
      e.target.value = '';
    }
  };

  const handleReloadData = () => {
    fileInputRef.current?.click();
  };

  const handleResetFilter = () => {
    setSearchTextInput('');
    setSearchProjectInput('');
    onFilterChange({ ...DEFAULT_TASK_FILTER });
    setDateStartInput('0');
    setDateEndInput('0');
  };

  /** 期間限定モードへ切り替えて、指定した日数入力欄を編集状態にする */
  const activateLimitedPeriodMode = (side: DayRangeSide) => {
    const input = side === 'start' ? dateStartInputRef.current : dateEndInputRef.current;
    if (filter.periodMode !== 'limited') {
      onFilterChange({ ...filter, periodMode: 'limited' });
      window.requestAnimationFrame(() => {
        input?.focus();
        input?.select();
      });
      return;
    }

    input?.select();
  };

  return (
    <header className="header">
      <div className="toolbar">
        {/* Logo */}
        <div className="logo">G</div>

        {/* View Mode Switcher */}
        <div className="btn-group">
          <Link
            to="/"
            className={`btn view-mode-btn ${pathname === '/' ? 'active' : ''}`}
            title="ガントチャート"
          >
            📊
          </Link>
          <Link
            to="/grid"
            className={`btn view-mode-btn ${pathname === '/grid' ? 'active' : ''}`}
            title="グリッド編集"
          >
            📋
          </Link>
        </div>

        {/* Hamburger Menu - Replaces setting menu and extra buttons */}
        <HamburgerMenu
          darkMode={darkMode}
          toggleDarkMode={toggleDarkMode}
          displaySize={displaySize}
          onDisplaySizeChange={onDisplaySizeChange}
          onAutoMoveTasks={onAutoMoveTasks}
          onReloadData={handleReloadData}
          onExportCSV={onExportCSV}
          onDiffCompare={onDiffCompare}
          isPrintMode={isPrintMode}
          onPrintModeToggle={onPrintModeToggle}
          gridWidth={gridWidth}
          onGridWidthChange={onGridWidthChange}
          obsidianHome={obsidianHome}
          onObsidianHomeChange={onObsidianHomeChange}
          onShowCsvSyncSummary={onShowCsvSyncSummary}
          holidaySettings={holidaySettings}
          onHolidaySettingsChange={onHolidaySettingsChange}
          businessTripSettings={businessTripSettings}
          onBusinessTripSettingsChange={onBusinessTripSettingsChange}
        />

        <div className="toolbar-divider"></div>

        {/* Filter Reset */}
        <button
          className="btn"
          onClick={handleResetFilter}
          title="フィルターを初期化"
          onKeyDown={handleButtonArrowKeys}
        >
          ↺
        </button>

        {/* Search */}
        <input
          type="text"
          placeholder="タスク検索..."
          className="search-input"
          value={searchTextInput}
          onChange={(e) => setSearchTextInput(e.target.value)}
          onKeyDown={handleInputArrowKeys}
        />
        <input
          type="text"
          placeholder="プロジェクト検索..."
          className="search-input"
          value={searchProjectInput}
          onChange={(e) => setSearchProjectInput(e.target.value)}
          onKeyDown={handleInputArrowKeys}
        />

        <div className="toolbar-divider"></div>

        {/* Expand/Collapse */}
        <button className="btn" onClick={onExpandAll} onKeyDown={handleButtonArrowKeys}>
          open
        </button>
        <button className="btn" onClick={onCollapseAll} onKeyDown={handleButtonArrowKeys}>
          close
        </button>

        <div className="toolbar-divider"></div>

        {/* Date Range */}
        <span className="label">表示期間:</span>
        <OptionButtonGroup
          options={PERIOD_MODE_OPTIONS}
          value={filter.periodMode}
          onSelect={(periodMode) => onFilterChange({ ...filter, periodMode })}
        />
        <DayRangeInput
          ref={dateStartInputRef}
          side="start"
          value={dateStartInput}
          onValueChange={setDateStartInput}
          onCommit={(dateRangeStart) => onFilterChange({ ...filter, dateRangeStart })}
          editable={filter.periodMode === 'limited'}
          onActivate={activateLimitedPeriodMode}
        />
        <span tabIndex={-1}>~</span>
        <DayRangeInput
          ref={dateEndInputRef}
          side="end"
          value={dateEndInput}
          onValueChange={setDateEndInput}
          onCommit={(dateRangeEnd) => onFilterChange({ ...filter, dateRangeEnd })}
          editable={filter.periodMode === 'limited'}
          onActivate={activateLimitedPeriodMode}
        />

        <div className="toolbar-divider"></div>

        {/* Completed Filter */}
        <OptionButtonGroup
          options={COMPLETED_OPTIONS}
          value={filter.showCompleted}
          onSelect={(showCompleted) => onFilterChange({ ...filter, showCompleted })}
        />

        <div className="toolbar-divider"></div>

        {/* Pin Filter */}
        <select
          className="select-input"
          value={filter.pinnedMode || 'all'}
          onChange={(e) =>
            onFilterChange({
              ...filter,
              pinnedMode: e.target.value as 'all' | 'pinned' | 'unpinned',
            })
          }
          onKeyDown={handleSelectArrowKeys}
          title="固定フィルター"
        >
          <option value="all">全</option>
          <option value="pinned">固定</option>
          <option value="unpinned">非固定</option>
        </select>

        <div className="toolbar-divider"></div>

        {/* Type Filter */}
        <OptionButtonGroup
          options={TYPE_OPTIONS}
          value={filter.showType}
          onSelect={(showType) => onFilterChange({ ...filter, showType })}
        />

        {/* Owner Filter */}
        <select
          className="select-input"
          value={filter.owner || ''}
          onChange={(e) =>
            onFilterChange({ ...filter, owner: e.target.value })
          }
          onKeyDown={handleSelectArrowKeys}
        >
          <option value="">All</option>
          <option value="自分">自分</option>
          <option value="待">待</option>
          <option value="サイン取">サイン取</option>
          <option value="他">他</option>
        </select>

        <div className="toolbar-divider"></div>

        {/* Time Scale */}
        <OptionButtonGroup options={TIME_SCALE_OPTIONS} value={timeScale} onSelect={onTimeScaleChange} />

        {/* Hidden File Input for Import */}
        <input
          type="file"
          ref={fileInputRef}
          accept=".csv,.zip"
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />

        {/* Previous buttons (auto move, import, export) are moved to HamburgerMenu */}
      </div>
    </header>
  );
}
