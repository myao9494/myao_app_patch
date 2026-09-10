/**
 * quickアプリ メインコンポーネント
 * - 状態管理（検索、フィルタ、閲覧、編集、設定）
 * - 画面遷移（検索一覧 ⇔ ファイル閲覧 ⇔ ファイル編集）
 * - URLクエリパラメータとの同期（?file=... による履歴保持・ブラウザ戻る復帰）
 * - モバイル特化のレイアウト構成
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  SearchResultItem,
  AppSettings,
  FilterCategory,
  FileContentResponse,
} from './types';
import { loadSettings, saveSettings } from './utils/config';
import { searchFiles, fetchFileContent } from './api/client';
import {
  getFilePathFromUrl,
  pushFileHistory,
  clearFileHistory,
} from './utils/navigation';
import { Header } from './components/Header';
import { SearchBar } from './components/SearchBar';
import { FilterTabs } from './components/FilterTabs';
import { SearchResults } from './components/SearchResults';
import { FileViewer } from './components/FileViewer';
import { FileEditor } from './components/FileEditor';
import { SettingsModal } from './components/SettingsModal';

export const App: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // 検索状態
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [filter, setFilter] = useState<FilterCategory>('all');

  // 閲覧・編集状態
  const [activeFile, setActiveFile] = useState<FileContentResponse | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [errorToast, setErrorToast] = useState<string | null>(null);

  // 設定保存ハンドラー
  const handleSaveSettings = (newSettings: AppSettings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
    // 設定変更後に再検索
    if (query.trim()) {
      executeSearch(query, newSettings);
    }
  };

  // 検索実行
  const executeSearch = useCallback(
    async (q: string, currentSettings: AppSettings) => {
      const trimmed = q.trim();
      if (!trimmed) {
        setResults([]);
        return;
      }

      setIsLoading(true);
      try {
        const res = await searchFiles(trimmed, currentSettings);
        setResults(res);
      } catch (err) {
        console.error('Search error:', err);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  // デバウンス検索
  useEffect(() => {
    const timer = setTimeout(() => {
      executeSearch(query, settings);
    }, 350);
    return () => clearTimeout(timer);
  }, [query, settings, executeSearch]);

  // ファイル種別フィルタリング
  const { filteredResults, counts } = useMemo(() => {
    let docCount = 0;
    let diagramCount = 0;

    const filtered = results.filter((item) => {
      if (item.is_directory) return false;
      const ext = item.name.split('.').pop()?.toLowerCase() || '';

      const isDoc = ['md', 'txt'].includes(ext);
      const isDiagram =
        ['svg', 'png', 'jpg', 'jpeg', 'excalidraw'].includes(ext) ||
        item.name.includes('.drawio');

      if (isDoc) docCount++;
      if (isDiagram) diagramCount++;

      if (filter === 'doc') return isDoc;
      if (filter === 'diagram') return isDiagram;
      return true;
    });

    return {
      filteredResults: filtered,
      counts: {
        all: results.length,
        doc: docCount,
        diagram: diagramCount,
      },
    };
  }, [results, filter]);

  // ファイルオープン共通処理（URLパラメータと同期）
  const openFile = useCallback(
    async (filePath: string, updateHistory = true) => {
      setIsLoadingFile(true);
      setErrorToast(null);
      try {
        const fileData = await fetchFileContent(filePath, settings);
        setActiveFile(fileData);
        setIsEditing(false);
        if (updateHistory) {
          pushFileHistory(filePath);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'ファイルの取得に失敗しました';
        setErrorToast(msg);
        setTimeout(() => setErrorToast(null), 3000);
        clearFileHistory();
      } finally {
        setIsLoadingFile(false);
      }
    },
    [settings]
  );

  // 初回ロード時: URLクエリパラメータからファイルを開く（外部リンクから戻った際にも復元）
  useEffect(() => {
    const initialPath = getFilePathFromUrl(window.location.search);
    if (initialPath) {
      openFile(initialPath, false);
    }
  }, [openFile]);

  // ブラウザの戻る・進む（popstate）対応
  useEffect(() => {
    const handlePopState = () => {
      const filePath = getFilePathFromUrl(window.location.search);
      if (filePath) {
        if (!activeFile || activeFile.path !== filePath) {
          openFile(filePath, false);
        }
      } else {
        setActiveFile(null);
        setIsEditing(false);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [activeFile, openFile]);

  // 外部サイトから戻った際（bfcache対策）
  useEffect(() => {
    const handlePageShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        const filePath = getFilePathFromUrl(window.location.search);
        if (filePath && (!activeFile || activeFile.path !== filePath)) {
          openFile(filePath, false);
        }
      }
    };
    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, [activeFile, openFile]);

  // ファイルタップ時（閲覧画面へ）
  const handleSelectFile = (item: SearchResultItem) => {
    if (item.is_directory) return;
    openFile(item.path, true);
  };

  // リンク経由でのファイル直接オープン
  const handleOpenFileByPath = (filePath: string) => {
    openFile(filePath, true);
  };

  // ファイル閲覧から一覧への戻るハンドラー
  const handleBackToSearch = () => {
    clearFileHistory();
    setActiveFile(null);
    setIsEditing(false);
  };

  // 保存完了時ハンドラー
  const handleSaved = (newContent: string) => {
    if (activeFile) {
      setActiveFile({ ...activeFile, content: newContent });
    }
    setIsEditing(false);
  };

  // Wikilink等での検索画面への遷移
  const handleSearchQuery = (searchWord: string) => {
    clearFileHistory();
    setActiveFile(null);
    setQuery(searchWord);
  };

  return (
    <div className="quick-app-root">
      {/* トースト通知 */}
      {errorToast && (
        <div className="quick-toast-error">
          <span>{errorToast}</span>
        </div>
      )}

      {/* 編集モード画面 */}
      {activeFile && isEditing ? (
        <FileEditor
          file={activeFile}
          settings={settings}
          onBack={() => setIsEditing(false)}
          onSaved={handleSaved}
        />
      ) : activeFile ? (
        /* 閲覧モード画面 */
        <FileViewer
          file={activeFile}
          settings={settings}
          onBack={handleBackToSearch}
          onEdit={() => setIsEditing(true)}
          onOpenFileByPath={handleOpenFileByPath}
          onSearchQuery={handleSearchQuery}
        />
      ) : (
        /* メイン検索画面 */
        <div className="quick-main-screen">
          <Header
            settings={settings}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />

          <SearchBar
            query={query}
            onChange={setQuery}
            onClear={() => setQuery('')}
            isLoading={isLoading || isLoadingFile}
          />

          <FilterTabs
            currentFilter={filter}
            onSelectFilter={setFilter}
            counts={counts}
          />

          <SearchResults
            results={filteredResults}
            onSelectFile={handleSelectFile}
            query={query}
            isLoading={isLoading}
          />
        </div>
      )}

      {/* 設定モーダル */}
      <SettingsModal
        isOpen={isSettingsOpen}
        settings={settings}
        onClose={() => setIsSettingsOpen(false)}
        onSave={handleSaveSettings}
      />
    </div>
  );
};
export default App;
