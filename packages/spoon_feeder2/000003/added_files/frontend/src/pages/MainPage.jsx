/**
 * メイン画面 (MainPage.jsx)
 *
 * 仕様:
 * 1. リポジトリのパス指定・履歴選択、ファイルツリー、コンテキスト生成、コードパッチ適用、対話型ターミナルを統合提供。
 * 2. 参照ライブラリ（Python/C#）の自動検出・ツリー表示・手動マッピング（useReferences）。
 * 3. 「ライブラリを自動チェック」/「リンク先MDを自動チェック」による同一リポジトリ内の呼び出しモジュール・リンク先MDの自動選択。
 * 4. mkdocs.yml / mkdocs.yaml によるMkDocsリポジトリの自動判定（手動でコード/MkDocsモード切替）と、MD＋結合画像の2ファイル出力（useMkdocsBundle）。
 * 5. Git差分（既定: git diff HEAD -- *.py）のクリップボードコピー、ファイルプレビュー、無視リスト、設定ドロワー。
 * 画面領域ごとの描画は components/、状態と副作用は hooks/、純粋ロジックは lib/ に分離している。
 **/

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookOpen, Clipboard, X } from 'lucide-react';
import { api } from '../api';
import { CodeContextPanel } from '../components/CodeContextPanel';
import { FileSelectPanel } from '../components/FileSelectPanel';
import { HelpModal } from '../components/HelpModal';
import { IgnorePatternsModal } from '../components/IgnorePatternsModal';
import { MkdocsContextPanel } from '../components/MkdocsContextPanel';
import { PatchPanel } from '../components/PatchPanel';
import { PathBar } from '../components/PathBar';
import { PreviewModal } from '../components/PreviewModal';
import { ReferenceRepositoryModal } from '../components/ReferenceRepositoryModal';
import { SettingsDrawer } from '../components/SettingsDrawer';
import { TerminalPanel } from '../components/TerminalPanel';
import { Toast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { TreeContextMenu } from '../components/TreeContextMenu';
import { DEFAULT_GIT_DIFF_COMMAND, formatGitDiffMessage, resolveGitDiffCommand } from '../gitDiff';
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts';
import { useMkdocsBundle } from '../hooks/useMkdocsBundle';
import { usePersistentState } from '../hooks/usePersistentState';
import { usePreview } from '../hooks/usePreview';
import { useReferences } from '../hooks/useReferences';
import { downloadText } from '../lib/download';
import { filterReferenceFilesByInclusion, flattenFiles, initialSelection, mergeAutoSelectedFiles, resolveRepositoryMode } from '../lib/selection';

const EMPTY_MKDOCS_CONFIG = { is_mkdocs: false, config_file: '', site_name: '', docs_dir: 'docs' };
const storedPath = () => { try { return localStorage.getItem('spoonfeederPath') || ''; } catch { return ''; } };

export function MainPage() {
  const [path, setPath] = useState(storedPath);
  const [activePath, setActivePath] = useState(storedPath);
  const [repositories, setRepositories] = useState([]);
  const [tree, setTree] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [filter, setFilter] = useState('');
  const [showIgnored, setShowIgnored] = usePersistentState('showIgnored', false, raw => raw === 'true');
  const [pythonMode, setPythonMode] = usePersistentState('pythonMode', 'normal', raw => raw || 'normal');
  const [embeddedDir, setEmbeddedDir] = usePersistentState('embeddedDir', '', raw => raw || '');
  const [gitDiffCommand, setGitDiffCommand] = usePersistentState('gitDiffCommand', DEFAULT_GIT_DIFF_COMMAND);
  const [includeExternalModules, setIncludeExternalModules] = usePersistentState('includeExternalModules', true, raw => raw !== 'false');
  const [loading, setLoading] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [autoCheckLoading, setAutoCheckLoading] = useState(false);
  const [context, setContext] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [ignoreEditor, setIgnoreEditor] = useState({ open: false, pattern: '' });
  const [referenceEditor, setReferenceEditor] = useState({ open: false, file: '' });
  const [contextMenu, setContextMenu] = useState(null);
  const [isMkdocsRepo, setIsMkdocsRepo] = useState(false);
  const [mkdocsConfig, setMkdocsConfig] = useState(EMPTY_MKDOCS_CONFIG);
  const [modeOverride, setModeOverride] = useState('');

  const notify = useCallback(message => setToast(message), []);
  const closeToast = useCallback(() => setToast(''), []);
  const activeMode = useMemo(() => resolveRepositoryMode(isMkdocsRepo, modeOverride), [isMkdocsRepo, modeOverride]);
  const libraryPath = activePath || path;
  const allFiles = useMemo(() => flattenFiles(tree), [tree]);

  const { referenceData, referenceSelected, setReferenceSelected, refreshReferences, referenceFileCount } = useReferences({ activePath, pythonMode, selected, activeMode });
  const { treeRef, previewFile, previewContent, openPreview, closePreview, handleTreeKeyDown } = usePreview({ activePath, path });
  const mkdocs = useMkdocsBundle({ libraryPath, selected, siteName: mkdocsConfig.site_name, notify, setContext });

  /** 非同期操作のエラーを画面上部のエラー欄に表示する。 */
  const guarded = action => async (...args) => {
    setError('');
    try { return await action(...args); } catch (err) { setError(err.message); return undefined; }
  };

  const load = useCallback(async (overrideShowIgnored = showIgnored, overridePath = path) => {
    if (!overridePath.trim()) return setError('リポジトリのフォルダパスを入力してください。');
    setLoading(true); setError(''); setContext(''); mkdocs.reset(); setModeOverride('');
    try {
      const data = await api('/api/repository_structure', { library_path: overridePath, show_ignored: overrideShowIgnored });
      setTree(data.files || []);
      setSelected(initialSelection(data.selected_files, flattenFiles(data.files || [])));
      setIsMkdocsRepo(Boolean(data.is_mkdocs_repository));
      setMkdocsConfig(data.mkdocs_config || EMPTY_MKDOCS_CONFIG);
      setPath(overridePath); setActivePath(overridePath);
      try { localStorage.setItem('spoonfeederPath', overridePath); } catch { /* 保存できなくても動作は継続する */ }
      setRepositories(previous => Array.from(new Set([...previous, overridePath])));
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }, [path, showIgnored]);

  useEffect(() => { api('/api/repositories', undefined, 'GET').then(data => setRepositories(data.repositories || [])).catch(() => {}); }, []);
  useEffect(() => { if (path) load(showIgnored, path); }, []);

  const openIgnoreEditor = (pattern = '') => { setSettingsOpen(false); setIgnoreEditor({ open: true, pattern }); };
  const openReferenceEditor = node => { setReferenceEditor({ open: true, file: node?.type === 'file' ? node.path : '' }); setContextMenu(null); };

  useGlobalShortcuts({
    helpOpen, modalOpen: ignoreEditor.open || referenceEditor.open, previewFile,
    onToggleHelp: setHelpOpen, onClosePreview: closePreview, onCloseContextMenu: () => setContextMenu(null),
    onOpenIgnoreEditor: () => openIgnoreEditor()
  });

  const autoCheckModules = guarded(async () => {
    if (!path || selected.size === 0) return;
    setAutoCheckLoading(true);
    try {
      const data = await api('/api/auto_select_modules', { library_path: libraryPath, selected_files: Array.from(selected) });
      setSelected(mergeAutoSelectedFiles(selected, data.selected_files || []));
      const addedCount = (data.added_files || []).length;
      const markdown = activeMode === 'mkdocs';
      notify(addedCount > 0
        ? (markdown ? `リンクされている${addedCount}件のMarkdownにチェックを入れました。` : `呼び出されている${addedCount}件のモジュールにチェックを入れました。`)
        : (markdown ? 'リンク先のMarkdownはすべてチェック済みです。' : '呼び出されているモジュールはすべてチェック済みです。'));
    } finally { setAutoCheckLoading(false); }
  });

  const addIgnorePattern = guarded(async node => {
    setContextMenu(null);
    const current = await api('/api/ignore_patterns', { library_path: path });
    await api('/api/save_ignore_patterns', { library_path: path, patterns: Array.from(new Set([...(current.patterns || []), node.path])) });
    await load(showIgnored, path); notify(`「${node.path}」を無視リストに追加しました。`);
  });

  const removeIgnorePattern = guarded(async node => {
    setContextMenu(null);
    const data = await api('/api/remove_ignore_pattern', { library_path: path, path: node.path });
    await load(showIgnored, path);
    notify(data.status === 'success' ? `「${node.path}」を無視リストから除外しました。` : data.message);
  });

  const generate = async () => {
    setLoading(true); setError('');
    try {
      if (activeMode === 'mkdocs') {
        await mkdocs.preview();
      } else {
        const referenceFiles = filterReferenceFilesByInclusion(referenceData.repositories || [], referenceSelected, includeExternalModules);
        const data = await api('/api/repository_context', { library_path: libraryPath, selected_files: Array.from(selected), reference_files: referenceFiles });
        setContext(data.context); notify(`メイン${data.file_count}件・参照${data.reference_file_count || 0}件のコンテキストを作成しました。`);
      }
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  };

  const copy = guarded(async () => { await navigator.clipboard.writeText(context); notify('コンテキストをコピーしました。'); });
  const download = () => {
    const filename = activeMode === 'mkdocs' ? 'mkdocs_context.md' : 'repository_context.txt';
    downloadText(filename, context); notify(`${filename}を保存しました。`);
  };
  const copyGitDiff = async () => {
    if (!path) return;
    setLoadingDiff(true); setError('');
    try {
      const data = await api('/api/git_diff', { library_path: path, command: resolveGitDiffCommand(gitDiffCommand) });
      await navigator.clipboard.writeText(data.diff || '');
      notify(formatGitDiffMessage(data.diff));
    } catch (err) { setError(err.message); } finally { setLoadingDiff(false); }
  };
  const openCode = guarded(async () => { const data = await api('/api/open_in_code', { library_path: path }); if (data.status === 'success') notify(data.message); else setError(data.message); });
  const openMap = () => window.open(`/map?path=${encodeURIComponent(path)}`, '_blank', 'noopener');

  const mkdocsPanel = { ...mkdocs, onOpenFolder: guarded(mkdocs.openFolder), onSave: guarded(mkdocs.save) };
  const contextPanelProps = { context, path, loading, selectedCount: selected.size, onGenerate: generate, onCopy: copy, onDownload: download };

  return <div className="app-shell">
    <TopBar path={path} onOpenMap={openMap} onOpenIgnoreEditor={() => openIgnoreEditor()} onOpenSettings={() => setSettingsOpen(true)}/>
    <main>
      <PathBar
        path={path} setPath={setPath} repositories={repositories} setRepositories={setRepositories} onLoad={load} loading={loading}
        showIgnored={showIgnored} notify={notify} activeMode={activeMode} isMkdocsRepo={isMkdocsRepo} mkdocsConfig={mkdocsConfig}
        onToggleMode={() => setModeOverride(activeMode === 'mkdocs' ? 'code' : 'mkdocs')}
        gitDiffCommand={gitDiffCommand} loadingDiff={loadingDiff} onCopyGitDiff={copyGitDiff} onOpenCode={openCode}
      />
      {error && <div className="error-box global"><AlertTriangle/>{error}<button onClick={() => setError('')}><X/></button></div>}
      <div className="workspace-grid">
        <FileSelectPanel
          tree={tree} allFiles={allFiles} selected={selected} setSelected={setSelected} filter={filter} setFilter={setFilter}
          treeRef={treeRef} onTreeKeyDown={handleTreeKeyDown} onPreview={openPreview} onContextMenu={(event, node) => setContextMenu({ x: event.clientX, y: event.clientY, node })}
          path={path} loading={loading} activeMode={activeMode} autoCheckLoading={autoCheckLoading} onAutoCheck={autoCheckModules}
          referenceData={referenceData} referenceSelected={referenceSelected} setReferenceSelected={setReferenceSelected}
          referenceFileCount={referenceFileCount} onOpenReferenceEditor={openReferenceEditor}
        />
        <section className="card context-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">{activeMode === 'mkdocs' ? `MKDOCS CONTEXT · ${mkdocsConfig.config_file || 'YAML'}` : 'CONTEXT'}</span>
              <h2>{activeMode === 'mkdocs' ? <BookOpen/> : <Clipboard/>}{activeMode === 'mkdocs' ? 'MkDocs AIコンテキスト＆結合画像' : 'チャット添付用コンテキスト'}</h2>
            </div>
            {context && <span className="ready-pill">READY</span>}
          </div>
          {activeMode === 'mkdocs'
            ? <MkdocsContextPanel {...contextPanelProps} mkdocs={mkdocsPanel}/>
            : <CodeContextPanel {...contextPanelProps} includeExternalModules={includeExternalModules} setIncludeExternalModules={setIncludeExternalModules}/>}
        </section>
      </div>
      <PatchPanel path={path} pythonMode={pythonMode} embeddedDir={embeddedDir} notify={notify} activeMode={activeMode}/>
      <TerminalPanel path={path} pythonMode={pythonMode} embeddedDir={embeddedDir}/>
    </main>
    <SettingsDrawer open={settingsOpen} close={() => setSettingsOpen(false)} path={path} openIgnoreEditor={() => openIgnoreEditor()} showIgnored={showIgnored} setShowIgnored={setShowIgnored} pythonMode={pythonMode} setPythonMode={setPythonMode} embeddedDir={embeddedDir} setEmbeddedDir={setEmbeddedDir} gitDiffCommand={gitDiffCommand} setGitDiffCommand={setGitDiffCommand} reload={value => load(value)}/>
    <PreviewModal file={previewFile} content={previewContent} close={closePreview}/>
    <IgnorePatternsModal open={ignoreEditor.open} close={() => setIgnoreEditor(state => ({ ...state, open: false }))} path={path} initialPattern={ignoreEditor.pattern} onSaved={async () => { setIgnoreEditor(state => ({ ...state, open: false })); await load(showIgnored, path); }} notify={notify}/>
    <ReferenceRepositoryModal open={referenceEditor.open} close={() => setReferenceEditor(state => ({ ...state, open: false }))} path={libraryPath} repositories={repositories} unresolved={referenceData.unresolved || []} initialFile={referenceEditor.file} manualReferences={referenceData.manual_references || {}} onSaved={refreshReferences} notify={notify}/>
    <HelpModal open={helpOpen} close={() => setHelpOpen(false)}/>
    {contextMenu && <TreeContextMenu menu={contextMenu} pythonMode={pythonMode} referenceData={referenceData} onAddIgnore={addIgnorePattern} onRemoveIgnore={removeIgnorePattern} onOpenReferenceEditor={openReferenceEditor}/>}
    {toast && <Toast message={toast} onClose={closeToast}/>}<footer>Python + C# + MkDocs · Git-aware · Local only</footer>
  </div>;
}
