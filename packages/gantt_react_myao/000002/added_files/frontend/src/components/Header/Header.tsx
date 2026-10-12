/**
 * ヘッダーツールバー
 * 画面切替、ハンバーガーメニュー、検索・フィルター（表示期間、完了、固定、種別、オーナー）、タイムスケール切替を提供する。
 * ツールバー内は左右の矢印キーでフォーカスを移動できる。
 */
import { useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTheme } from '../../contexts/useTheme';
import { useSyncedState } from '../../hooks/useSyncedState';
import { HamburgerMenu } from './HamburgerMenu';
import type { BusinessTripSettings, HolidaySettings, TaskFilter } from '../../types/gantt';
import './Header.css';

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

  // ヘッダーツールバー内のフォーカス可能な要素を見つけるヘルパー関数
  const findFocusableElements = (): HTMLElement[] => {
    const toolbar = document.querySelector('.toolbar');
    if (!toolbar) return [];
    const elements = toolbar.querySelectorAll('button:not([disabled]), input:not([disabled]):not([type="file"]), select:not([disabled])');
    return Array.from(elements) as HTMLElement[];
  };

  // 次のフォーカス可能な要素に移動
  const focusNextElement = (current: HTMLElement) => {
    const elements = findFocusableElements();
    const currentIndex = elements.indexOf(current);
    if (currentIndex !== -1 && currentIndex < elements.length - 1) {
      elements[currentIndex + 1].focus();
    }
  };

  // 前のフォーカス可能な要素に移動
  const focusPrevElement = (current: HTMLElement) => {
    const elements = findFocusableElements();
    const currentIndex = elements.indexOf(current);
    if (currentIndex > 0) {
      elements[currentIndex - 1].focus();
    }
  };

  // ボタン用の矢印キーハンドラ
  const handleButtonArrowKeys = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusNextElement(e.currentTarget);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusPrevElement(e.currentTarget);
    }
  };

  // 入力フィールド用の矢印キーハンドラ（カーソル位置を考慮）
  const handleInputArrowKeys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const input = e.currentTarget;
    if (e.key === 'ArrowRight' && input.selectionStart === input.value.length) {
      e.preventDefault();
      focusNextElement(input);
    } else if (e.key === 'ArrowLeft' && input.selectionStart === 0) {
      e.preventDefault();
      focusPrevElement(input);
    }
  };

  // select用の矢印キーハンドラ
  const handleSelectArrowKeys = (e: React.KeyboardEvent<HTMLSelectElement>) => {
    // Selectでは上下矢印がオプション選択に使われるため、左右のみ処理
    if (e.key === 'ArrowRight') {
      e.stopPropagation();
      e.preventDefault();
      focusNextElement(e.currentTarget);
    } else if (e.key === 'ArrowLeft') {
      e.stopPropagation();
      e.preventDefault();
      focusPrevElement(e.currentTarget);
    }
  };

  const handleResetFilter = () => {
    setSearchTextInput('');
    setSearchProjectInput('');
    onFilterChange({
      searchText: '',
      searchProject: '',
      showCompleted: false,
      showType: 'all',
      pinnedMode: 'all',
      category: '',
      periodMode: 'before_today',
      dateRangeStart: 0,
      dateRangeEnd: 0,
      owner: '',
    });
    setDateStartInput('0');
    setDateEndInput('0');
  };

  const activateLimitedPeriodMode = (target: 'start' | 'end') => {
    if (filter.periodMode !== 'limited') {
      onFilterChange({ ...filter, periodMode: 'limited' });
      window.requestAnimationFrame(() => {
        const input = target === 'start' ? dateStartInputRef.current : dateEndInputRef.current;
        input?.focus();
        input?.select();
      });
      return;
    }

    const input = target === 'start' ? dateStartInputRef.current : dateEndInputRef.current;
    input?.select();
  };

  const normalizeNumberInput = (value: string) =>
    value
      .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
      .replace(/[－ー―−]/g, '-');

  const isValidNumberInput = (value: string) => {
    const normalized = normalizeNumberInput(value);
    return normalized === '' || normalized === '-' || /^-?\d+$/.test(normalized);
  };

  const finalizeNumberInput = (value: string) => {
    const normalized = normalizeNumberInput(value);
    const num = Number(normalized) || 0;
    const clamped = Math.max(-1000, Math.min(1000, num));
    return String(clamped);
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
        <div className="btn-group">
          <button
            className={`btn ${filter.periodMode === 'all' ? 'active' : ''}`}
            onClick={() => onFilterChange({ ...filter, periodMode: 'all' })}
            onKeyDown={handleButtonArrowKeys}
          >
            ALL
          </button>
          <button
            className={`btn ${filter.periodMode === 'before_today' ? 'active' : ''}`}
            onClick={() => onFilterChange({ ...filter, periodMode: 'before_today' })}
            onKeyDown={handleButtonArrowKeys}
          >
            今日以前
          </button>
          <button
            className={`btn ${filter.periodMode === 'limited' ? 'active' : ''}`}
            onClick={() => onFilterChange({ ...filter, periodMode: 'limited' })}
            onKeyDown={handleButtonArrowKeys}
          >
            期間限定
          </button>
        </div>
        <input
          ref={dateStartInputRef}
          type="text"
          className="number-input wide"
          readOnly={filter.periodMode !== 'limited'}
          aria-disabled={filter.periodMode !== 'limited'}
          value={dateStartInput}
          onMouseDown={(e) => {
            if (filter.periodMode !== 'limited') {
              e.preventDefault();
              activateLimitedPeriodMode('start');
            }
          }}
          onFocus={() => activateLimitedPeriodMode('start')}
          onChange={(e) => {
            const val = e.target.value;
            if (isValidNumberInput(val)) {
              setDateStartInput(normalizeNumberInput(val));
            }
          }}
          onKeyDown={(e) => {
            e.stopPropagation(); // DHTMLX干渉防止

            if (e.key === 'Enter') {
              // 確定（フォーカスは維持し、値を適用）
              const finalized = finalizeNumberInput(dateStartInput);
              if (finalized !== dateStartInput) {
                setDateStartInput(finalized);
              }
              onFilterChange({ ...filter, dateRangeStart: Number(finalized) });
              e.currentTarget.select(); // 再選択して連続入力を容易に
              return;
            }

            if (e.key === 'ArrowRight') {
              const input = e.currentTarget;
              if (input.selectionStart === input.value.length) {
                e.preventDefault();
                // 次のinputを探す (spanをスキップ)
                let next = input.nextElementSibling as HTMLElement;
                while (next) {
                  if (next.tagName === 'INPUT') {
                    (next as HTMLInputElement).focus();
                    return;
                  }
                  next = next.nextElementSibling as HTMLElement;
                }
              }
            }

            if (e.key === 'ArrowLeft') {
              const input = e.currentTarget;
              if (input.selectionStart === 0) {
                e.preventDefault();
                // 前のbuttonを探す
                let prev = input.previousElementSibling as HTMLElement;
                while (prev) {
                  if (prev.tagName === 'BUTTON') {
                    prev.focus();
                    return;
                  }
                  prev = prev.previousElementSibling as HTMLElement;
                }
              }
            }
          }}
          onBlur={() => {
            const finalized = finalizeNumberInput(dateStartInput);
            setDateStartInput(finalized);
            onFilterChange({ ...filter, dateRangeStart: Number(finalized) });
          }}
        />
        <span tabIndex={-1}>~</span>
        <input
          ref={dateEndInputRef}
          type="text"
          className="number-input wide"
          readOnly={filter.periodMode !== 'limited'}
          aria-disabled={filter.periodMode !== 'limited'}
          value={dateEndInput}
          onMouseDown={(e) => {
            if (filter.periodMode !== 'limited') {
              e.preventDefault();
              activateLimitedPeriodMode('end');
            }
          }}
          onFocus={() => activateLimitedPeriodMode('end')}
          onChange={(e) => {
            const val = e.target.value;
            if (isValidNumberInput(val)) {
              setDateEndInput(normalizeNumberInput(val));
            }
          }}
          onKeyDown={(e) => {
            e.stopPropagation();

            if (e.key === 'Enter') {
              const finalized = finalizeNumberInput(dateEndInput);
              if (finalized !== dateEndInput) {
                setDateEndInput(finalized);
              }
              onFilterChange({ ...filter, dateRangeEnd: Number(finalized) });
              e.currentTarget.select();
              return;
            }

            if (e.key === 'ArrowLeft') {
              const input = e.currentTarget;
              if (input.selectionStart === 0) {
                e.preventDefault();
                // 前のinputを探す (spanをスキップ)
                let prev = input.previousElementSibling as HTMLElement;
                while (prev) {
                  if (prev.tagName === 'INPUT') {
                    (prev as HTMLInputElement).focus();
                    return;
                  }
                  prev = prev.previousElementSibling as HTMLElement;
                }
              }
            }

            if (e.key === 'ArrowRight') {
              const input = e.currentTarget;
              if (input.selectionStart === input.value.length) {
                // 次の要素（未完了ボタン）へ
                // input2 -> div.btn-group -> button
                e.preventDefault();
                // 親の次の要素を探すか、DOM構造決め打ち
                // Structure: ... input1, span, input2, div.toolbar-divider, div.btn-group ...
                // input2.nextElementSibling is div.toolbar-divider
                let next = input.nextElementSibling as HTMLElement;
                while (next) {
                  if (next.tagName === 'BUTTON' || (next.tagName === 'DIV' && next.classList.contains('btn-group'))) {
                    if (next.classList.contains('btn-group')) {
                      const btn = next.querySelector('button');
                      if (btn) { btn.focus(); return; }
                    }
                    if (next.tagName === 'BUTTON') {
                      next.focus(); return;
                    }
                  }
                  next = next.nextElementSibling as HTMLElement;
                }
              }
            }
          }}
          onBlur={() => {
            const finalized = finalizeNumberInput(dateEndInput);
            setDateEndInput(finalized);
            onFilterChange({ ...filter, dateRangeEnd: Number(finalized) });
          }}
        />

        <div className="toolbar-divider"></div>

        {/* Completed Filter */}
        <div className="btn-group">
          <button
            className={`btn ${!filter.showCompleted ? 'active' : ''}`}
            onClick={() => onFilterChange({ ...filter, showCompleted: false })}
            onKeyDown={handleButtonArrowKeys}
          >
            未完了
          </button>
          <button
            className={`btn ${filter.showCompleted ? 'active' : ''}`}
            onClick={() => onFilterChange({ ...filter, showCompleted: true })}
            onKeyDown={handleButtonArrowKeys}
          >
            全て
          </button>
        </div>

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
        <div className="btn-group">
          <button
            className={`btn ${filter.showType === 'all' ? 'active' : ''}`}
            onClick={() => onFilterChange({ ...filter, showType: 'all' })}
            onKeyDown={handleButtonArrowKeys}
          >
            全て
          </button>
          <button
            className={`btn ${filter.showType === 'task' ? 'active' : ''}`}
            onClick={() => onFilterChange({ ...filter, showType: 'task' })}
            onKeyDown={handleButtonArrowKeys}
          >
            task
          </button>
          <button
            className={`btn ${filter.showType === 'project' ? 'active' : ''}`}
            onClick={() => onFilterChange({ ...filter, showType: 'project' })}
            onKeyDown={handleButtonArrowKeys}
          >
            pro
          </button>
        </div>

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
        <div className="btn-group">
          <button
            className={`btn ${timeScale === 'day' ? 'active' : ''}`}
            onClick={() => onTimeScaleChange('day')}
            onKeyDown={handleButtonArrowKeys}
          >
            日
          </button>
          <button
            className={`btn ${timeScale === 'month' ? 'active' : ''}`}
            onClick={() => onTimeScaleChange('month')}
            onKeyDown={handleButtonArrowKeys}
          >
            月
          </button>
          <button
            className={`btn ${timeScale === 'quarter' ? 'active' : ''}`}
            onClick={() => onTimeScaleChange('quarter')}
            onKeyDown={handleButtonArrowKeys}
          >
            四
          </button>
          <button
            className={`btn ${timeScale === 'year' ? 'active' : ''}`}
            onClick={() => onTimeScaleChange('year')}
            onKeyDown={handleButtonArrowKeys}
          >
            年
          </button>
        </div>

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
