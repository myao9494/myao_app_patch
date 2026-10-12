/**
 * アプリ本体
 *
 * Excalidraw に、ローカルファイルとの同期（useFileSync）・独自ショートカット・
 * ドラッグ&ドロップ・ヘッダーボタン・埋め込みノートの右クリックメニューを組み合わせる。
 * 開くファイルは URL の `?filepath=` で指定する（未指定時は localStorage に保存）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Excalidraw, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

import { AnnotationSettingsModal } from './AnnotationSettingsModal';
import { EmbeddedNoteContextMenu, useEmbeddedNoteContextMenu } from './EmbeddedNoteContextMenu';
import { HeaderToolbar } from './HeaderToolbar';
import { ShortcutHelpModal } from './ShortcutHelpModal';
import { useDragAndDrop } from '../hooks/useDragAndDrop';
import { useFileSync } from '../hooks/useFileSync';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useNotification } from '../hooks/useNotification';
import { loadAnnotationSettings, saveAnnotationSettings, type AnnotationSettings } from '../utils/annotationSettings';
import { openInEditor, saveExcalidrawFile, saveLibrary, type ExcalidrawFileData } from '../utils/backendApi';
import { isLibrarySynced, markLibrarySynced } from '../utils/libraryItems';
import { handleStickyNoteLink, openPathWithFallback } from '../utils/linkHandler';
import { getParentFolder, normalizePath, openFileInNewTab } from '../utils/pathUtils';
import { exportToSvgFile } from '../utils/svgExport';
import { generateTabTitle } from '../utils/titleUtils';

import defaultTemplateRaw from '../shoki.excalidraw?raw';

import './App.scss';

/** 新規作成時のテンプレート（shoki.excalidraw） */
const parseTemplate = (): ExcalidrawFileData | null => {
  try {
    return JSON.parse(defaultTemplateRaw) as ExcalidrawFileData;
  } catch (error) {
    console.error('テンプレートファイルの解析に失敗しました:', error);
    return null;
  }
};
const DEFAULT_TEMPLATE_DATA = parseTemplate();

/** ファイル名を入力させ、テンプレートから新しい図面を作って別タブで開く */
const createNewFileFromTemplate = async (currentFolder: string | null) => {
  const fileName = prompt('新しいファイル名を入力してください（拡張子なし）:');
  if (!fileName || !fileName.trim()) {
    return;
  }
  if (!DEFAULT_TEMPLATE_DATA) {
    alert('テンプレートデータを読み込めなかったため、新規ファイルを作成できませんでした。');
    return;
  }

  const name = `${fileName.trim()}.excalidraw`;
  const fullPath = normalizePath(currentFolder ? `${currentFolder}/${name}` : name);
  const saveResult = await saveExcalidrawFile(fullPath, structuredClone(DEFAULT_TEMPLATE_DATA), true);
  if (!saveResult.success) {
    console.error('Error preparing new file from template:', saveResult.message);
    alert('テンプレートの保存に失敗したため、新規ファイルを作成できませんでした。');
    return;
  }
  openFileInNewTab(fullPath);
};

const requireFolder = (folder: string | null): folder is string => {
  if (!folder) {
    alert('現在のフォルダが取得できません。ファイルを開いてからお試しください。');
    return false;
  }
  return true;
};

/** フォルダをVS Codeで開く（なければOSのファイルマネージャー） */
const openFolderInCode = async (folder: string | null) => {
  if (!requireFolder(folder)) {
    return;
  }
  try {
    const result = await openInEditor(folder);
    if (result.fallbackUsed) {
      alert('VS Codeが見つからないため、代わりにファイルマネージャーでフォルダを開きました。');
    }
  } catch (error) {
    console.error('Error opening folder in editor:', error);
    alert('フォルダを開けませんでした。VS CodeまたはOSのファイルマネージャー設定を確認してください。');
  }
};

/** フォルダをOSのファイルマネージャーで開く */
const openFolderInExplorer = async (folder: string | null) => {
  if (!requireFolder(folder)) {
    return;
  }
  try {
    // ポップアップブロックを避けるため、クリック直後に空タブを開いておく
    const redirectWindow = window.open('about:blank', '_blank');
    await openPathWithFallback(folder, redirectWindow);
  } catch (error) {
    console.error('フォルダを開く処理で例外が発生しました:', error);
    alert('フォルダを開く処理でエラーが発生しました。詳細はコンソールを確認してください。');
  }
};

/** ライブラリの変更を共有ライブラリファイルへ自動保存する（空での上書きは防ぐ） */
const handleLibraryChange = async (libraryItems: readonly unknown[]) => {
  if (!libraryItems || libraryItems.length === 0) {
    console.warn('空のライブラリデータの保存をスキップしました');
    return;
  }
  if (isLibrarySynced(libraryItems)) {
    return;
  }
  const saved = await saveLibrary({
    type: 'excalidrawlib',
    version: 2,
    source: window.location.origin,
    libraryItems,
  });
  if (saved) {
    markLibrarySynced(libraryItems);
    console.log('ライブラリが自動保存されました');
  } else {
    console.error('ライブラリの保存に失敗しました');
  }
};

export default function App() {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);
  const [annotationSettings, setAnnotationSettings] = useState<AnnotationSettings>(() => loadAnnotationSettings());
  const [isAnnotationSettingsOpen, setIsAnnotationSettingsOpen] = useState(false);
  const [isShortcutHelpOpen, setIsShortcutHelpOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { notification, notify } = useNotification();
  const embeddedFilePathsRef = useRef<Record<string, string>>({});
  const contextMenu = useEmbeddedNoteContextMenu(excalidrawAPI, embeddedFilePathsRef);

  const { currentFilePath, initialDataPromise, handleChange, saveNow } = useFileSync({
    excalidrawAPI,
    notify,
    embeddedFilePathsRef,
    onSceneReplaced: contextMenu.closeMenu,
  });

  const currentFolder = getParentFolder(currentFilePath);
  const currentFolderRef = useRef(currentFolder);
  currentFolderRef.current = currentFolder;

  useEffect(() => {
    document.title = generateTabTitle(currentFilePath);
  }, [currentFilePath]);

  const toggleAnnotationSettings = useCallback(() => setIsAnnotationSettingsOpen((open) => !open), []);
  const toggleShortcutHelp = useCallback(() => setIsShortcutHelpOpen((open) => !open), []);
  const handleSave = useCallback(() => void saveNow(), [saveNow]);

  const handleExportSvg = useCallback(async () => {
    if (!excalidrawAPI) {
      return;
    }
    const elements = excalidrawAPI.getSceneElements();
    const appState = excalidrawAPI.getAppState();
    const selectedElements = elements.filter((element) => appState.selectedElementIds[element.id]);
    const saved = await exportToSvgFile(
      elements,
      appState,
      excalidrawAPI.getFiles(),
      currentFolderRef.current,
      selectedElements.length > 0 ? selectedElements : null,
    );
    console.log(saved ? 'SVGファイルの保存に成功しました' : 'SVGファイルを保存しませんでした');
  }, [excalidrawAPI]);

  const handleLinkOpen = useCallback((
    element: NonDeletedExcalidrawElement,
    event: CustomEvent<{ nativeEvent: MouseEvent | React.PointerEvent<HTMLCanvasElement> }>,
  ) => {
    if (!element.link) {
      return;
    }
    // Excalidraw 標準のリンク処理の代わりに、ファイル・コマンド・Obsidian に対応した処理を行う
    event.preventDefault();
    event.detail?.nativeEvent?.preventDefault();
    event.detail?.nativeEvent?.stopPropagation();
    void handleStickyNoteLink(element.link, currentFolderRef.current ?? undefined);
  }, []);

  useKeyboardShortcuts({
    excalidrawAPI,
    viewportCoordsToSceneCoords,
    onSave: handleSave,
    onToggleAnnotationSettings: toggleAnnotationSettings,
    onToggleShortcutHelp: toggleShortcutHelp,
    annotationSettings,
  });

  useDragAndDrop({ excalidrawAPI, currentFilePath, containerRef });

  return (
    <div className="App">
      {notification && (
        <div className={`save-notification ${notification.isError ? 'error' : ''}`}>
          {notification.message}
        </div>
      )}

      <HeaderToolbar
        onNewFile={() => void createNewFileFromTemplate(currentFolder)}
        onToggleAnnotationSettings={toggleAnnotationSettings}
        onToggleShortcutHelp={toggleShortcutHelp}
        onOpenFolder={() => void openFolderInExplorer(currentFolder)}
        onOpenInCode={() => void openFolderInCode(currentFolder)}
        onSave={handleSave}
        onExportSvg={() => void handleExportSvg()}
      />

      <EmbeddedNoteContextMenu
        menu={contextMenu.menu}
        menuRef={contextMenu.menuRef}
        onClose={contextMenu.closeMenu}
      />
      <AnnotationSettingsModal
        isOpen={isAnnotationSettingsOpen}
        onClose={() => setIsAnnotationSettingsOpen(false)}
        settings={annotationSettings}
        onUpdateSettings={(newSettings) => {
          setAnnotationSettings(newSettings);
          saveAnnotationSettings(newSettings);
        }}
      />
      <ShortcutHelpModal isOpen={isShortcutHelpOpen} onClose={() => setIsShortcutHelpOpen(false)} />

      <div className="excalidraw-wrapper" ref={containerRef} onContextMenuCapture={contextMenu.handleContextMenu}>
        <Excalidraw
          excalidrawAPI={setExcalidrawAPI}
          initialData={initialDataPromise}
          langCode="ja-JP"
          onChange={handleChange}
          onLibraryChange={handleLibraryChange}
          onLinkOpen={handleLinkOpen}
        />
      </div>
    </div>
  );
}
