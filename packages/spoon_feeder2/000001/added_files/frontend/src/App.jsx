/**
 * Spoonfeeder2 フロントエンドメインアプリケーション (App.jsx)
 * 
 * 仕様:
 * 1. リポジトリのパス指定・履歴選択、ファイルツリー表示、コンテキスト生成、コードパッチ適用、対話型ターミナルを統合提供。
 * 2. RepositorySelector による履歴全件選択・インクリメンタルサーチ対応のリポジトリ切り替え。
 * 3. 参照ライブラリ（Python/C#）の自動検出・ツリー表示・手動マッピング。
 * 4. ファイルプレビュー、無視リスト管理、設定ドロワー、依存関係マップ表示等の機能を提供。
 * 5. 現在開いているリポジトリのGit差分（デフォルト: git diff HEAD -- *.py）をクリップボードにコピーする機能を提供。
 **/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import '@xterm/xterm/css/xterm.css';
import {
  AlertTriangle, Ban, Check, ChevronDown, ChevronRight, CirclePlay, Clipboard,
  Code2, Copy, Download, ExternalLink, File, Folder, FolderOpen,
  GitBranch, GitCompare, ListPlus, LoaderCircle, Map, Menu, MonitorCog, RefreshCw, Save, Search,
  Settings, TerminalSquare, TestTube2, X
} from 'lucide-react';
import { FileIcon } from './components/FileIcon';
import { RepositorySelector } from './components/RepositorySelector';
import { DEFAULT_GIT_DIFF_COMMAND, formatGitDiffMessage, resolveGitDiffCommand } from './gitDiff';
import { CodePreview, MarkdownPreview } from './previewRenderer';
import { PreviewSearch } from './PreviewSearch';

const api = async (url, body, method = 'POST') => {
  const response = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.message || `HTTP ${response.status}`);
  return data;
};

export const flattenFiles = (nodes) => nodes.flatMap(node => node.type === 'file' ? (node.ignored ? [] : [node.path]) : flattenFiles(node.children || []));

function Toast({ message, onClose }) {
  useEffect(() => { const id = setTimeout(onClose, 3200); return () => clearTimeout(id); }, [message, onClose]);
  return <div className="toast"><Check size={16}/><span>{message}</span></div>;
}

function TreeNode({ node, selected, setSelected, filter, onPreview, onContextMenu, selectionPrefix = '', depth = 0 }) {
  const children = node.children || [];
  const matches = !filter || node.path.toLowerCase().includes(filter.toLowerCase());
  const childMatches = children.some(child => child.path.toLowerCase().includes(filter.toLowerCase()));
  const [open, setOpen] = useState(depth < 1 || Boolean(filter));
  useEffect(() => { if (filter && childMatches) setOpen(true); }, [filter, childMatches]);
  if (!matches && !childMatches) return null;
  const paths = flattenFiles([node]).map(path => `${selectionPrefix}${path}`);
  const checked = paths.length > 0 && paths.every(path => selected.has(path));
  const toggle = () => setSelected(previous => {
    const next = new Set(previous);
    paths.forEach(path => checked ? next.delete(path) : next.add(path));
    return next;
  });
  return <div className={`tree-entry ${node.ignored ? 'ignored' : ''}`}>
    <div
      className="tree-row"
      role="treeitem"
      tabIndex={-1}
      data-tree-item="true"
      data-tree-kind={node.type}
      data-tree-ignored={node.ignored ? 'true' : 'false'}
      data-tree-path={node.path}
      data-tree-repository={selectionPrefix.endsWith('::') ? selectionPrefix.slice(0, -2) : ''}
      aria-expanded={node.type === 'directory' ? open : undefined}
      aria-selected={node.type === 'file' ? checked : undefined}
      style={{ paddingLeft: `${depth * 16 + 6}px` }}
      onMouseDown={event => event.currentTarget.focus()}
      onDoubleClick={() => node.type === 'file' && !node.ignored && onPreview(node.path)}
      onContextMenu={event => { if (!onContextMenu) return; event.preventDefault(); onContextMenu(event, node); }}
    >
      {node.type === 'directory' ? <button className="icon-button tiny" tabIndex={-1} data-tree-toggle="true" onClick={event => { setOpen(!open); event.currentTarget.closest('.tree-row')?.focus(); }}>{open ? <ChevronDown/> : <ChevronRight/>}</button> : <span className="tree-spacer"/>}
      <input tabIndex={-1} type="checkbox" disabled={node.ignored || paths.length === 0} checked={checked} onChange={toggle} onClick={event => event.currentTarget.closest('.tree-row')?.focus()}/>
      <FileIcon
        name={node.name}
        type={node.type}
        isOpen={node.type === 'directory' && open}
        className={node.type === 'directory' ? 'tree-folder-icon' : 'tree-file-icon'}
      />
      <button className="tree-name" tabIndex={-1} onClick={event => { event.currentTarget.closest('.tree-row')?.focus(); node.type === 'directory' ? setOpen(!open) : onPreview(node.path); }}>{node.name}</button>
      {node.ignored && <span className="ignored-badge">ignored</span>}
    </div>
    {open && children.map(child => <TreeNode key={`${child.path}:${child.ignored}`} node={child} selected={selected} setSelected={setSelected} filter={filter} onPreview={onPreview} onContextMenu={onContextMenu} selectionPrefix={selectionPrefix} depth={depth + 1}/>) }
  </div>;
}

function IgnorePatternsModal({ open, close, path, initialPattern, onSaved, notify }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [configFile, setConfigFile] = useState('');
  const historyRef = useRef({ items: [], index: -1 });
  useEffect(() => {
    if (!open || !path) return undefined;
    let active = true;
    setBusy(true); setError('');
    api('/api/ignore_patterns', { library_path: path }).then(data => {
      if (!active) return;
      const patterns = Array.isArray(data.patterns) ? data.patterns : [];
      if (initialPattern && !patterns.includes(initialPattern)) patterns.push(initialPattern);
      const nextText = patterns.join('\n');
      setText(nextText); setConfigFile(data.config_file || '');
      historyRef.current = { items: [nextText], index: 0 };
    }).catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [open, path, initialPattern]);
  if (!open) return null;
  const updateText = nextText => {
    const history = historyRef.current;
    const items = history.items.slice(0, history.index + 1);
    if (items[items.length - 1] !== nextText) items.push(nextText);
    historyRef.current = { items, index: items.length - 1 };
    setText(nextText);
  };
  const undo = () => {
    const history = historyRef.current;
    if (history.index <= 0) return;
    history.index -= 1; setText(history.items[history.index]);
  };
  const redo = () => {
    const history = historyRef.current;
    if (history.index >= history.items.length - 1) return;
    history.index += 1; setText(history.items[history.index]);
  };
  const handleKeyDown = event => {
    const key = event.key.toLowerCase();
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && key === 's') { event.preventDefault(); event.stopPropagation(); save(); return; }
    if (modifier && key === 'z') { event.preventDefault(); event.stopPropagation(); event.shiftKey ? redo() : undo(); return; }
    if (modifier && key === 'y') { event.preventDefault(); event.stopPropagation(); redo(); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  };
  const save = async () => {
    const patterns = Array.from(new Set(text.split(/\r?\n/).map(item => item.replaceAll('\\', '/').trim()).filter(Boolean)));
    setBusy(true); setError('');
    try {
      const data = await api('/api/save_ignore_patterns', { library_path: path, patterns });
      onSaved(data.patterns || patterns); notify(`無視リストを${data.config_file || configFile || '設定ファイル'}に保存しました。`); close();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <div className="modal-layer" onMouseDown={close}><div className="modal ignore-modal" onMouseDown={event => event.stopPropagation()} onKeyDown={handleKeyDown}>
    <header><div><span className="eyebrow">IGNORE LIST</span><h3>無視リストを編集</h3></div><button className="icon-button" onClick={close}><X/></button></header>
    <p className="ignore-help">1行に1つずつ、ファイル名・フォルダ名・globパターンを入力します。保存後にツリーへ反映されます。</p>
    <textarea className="ignore-editor" value={text} onChange={event => updateText(event.target.value)} placeholder={'例:\n.venv\n__pycache__\n*.generated.cs'} autoFocus/>
    {error && <div className="error-box"><AlertTriangle/>{error}</div>}
    <div className="ignore-actions"><span>{busy ? '読み込み中…' : `${text.split(/\r?\n/).filter(item => item.trim()).length}件`}</span><button onClick={close}>キャンセル</button><button className="primary" onClick={save} disabled={busy || !path}><Save/>保存</button></div>
  </div></div>;
}

function ReferenceRepositoryModal({ open, close, path, repositories, unresolved, initialFile, manualReferences, onSaved, notify }) {
  const matching = unresolved.filter(item => !initialFile || (item.source_files || []).includes(initialFile));
  const choices = matching.length ? matching : unresolved;
  const [module, setModule] = useState('');
  const [repositoryPath, setRepositoryPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setModule(choices[0]?.module || ''); setRepositoryPath(''); setError('');
  }, [open, initialFile, unresolved]);
  if (!open) return null;
  const save = async () => {
    if (!module || !repositoryPath.trim()) return;
    setBusy(true); setError('');
    try {
      await api('/api/save_reference_mapping', { library_path: path, module, repository_path: repositoryPath.trim() });
      notify(`「${module}」の参照リポジトリを保存しました。`); await onSaved(); close();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const remove = async (mappedModule, mappedPath) => {
    setBusy(true); setError('');
    try {
      await api('/api/remove_reference_mapping', { library_path: path, module: mappedModule, repository_path: mappedPath });
      notify(`「${mappedModule}」の手動設定を解除しました。`); await onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const handleKeyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); save(); }
  };
  return <div className="modal-layer" onMouseDown={close}><div className="modal reference-modal" onMouseDown={event => event.stopPropagation()} onKeyDown={handleKeyDown}>
    <header><div><span className="eyebrow">REFERENCE REPOSITORY</span><h3>対象リポジトリを追加</h3></div><button className="icon-button" onClick={close}><X/></button></header>
    <p className="ignore-help">自動解決できなかったモジュールと、そのソースリポジトリを対応付けます。設定はメインリポジトリごとに保存されます。</p>
    {choices.length ? <div className="reference-form">
      <label>未解決モジュール<select value={module} onChange={event => setModule(event.target.value)}>{choices.map(item => <option key={`${item.language}:${item.module}`} value={item.module}>{item.module} ({item.language === 'python' ? 'Python' : 'C#'})</option>)}</select></label>
      <label>参照リポジトリのパス<input list="reference-repository-list" value={repositoryPath} onChange={event => setRepositoryPath(event.target.value)} placeholder="例: C:\\work\\shared_library または /work/shared_library" autoFocus/></label>
      <datalist id="reference-repository-list">{repositories.filter(repo => repo !== path).map(repo => <option key={repo} value={repo}/>)}</datalist>
    </div> : <div className="reference-resolved"><Check/>未解決の参照はありません。</div>}
    {Object.keys(manualReferences || {}).length > 0 && <div className="manual-reference-list"><strong>手動設定</strong>{Object.entries(manualReferences).map(([mappedModule, mappedPath]) => <div key={mappedModule}><span><code>{mappedModule}</code><small>{mappedPath}</small></span><button className="icon-button tiny" title="手動設定を解除" onClick={() => remove(mappedModule, mappedPath)}><X/></button></div>)}</div>}
    {error && <div className="error-box"><AlertTriangle/>{error}</div>}
    <div className="ignore-actions"><span>{choices.length ? `${choices.length}件が未解決` : '自動解決済み'}</span><button onClick={close}>キャンセル</button><button className="primary" onClick={save} disabled={busy || !module || !repositoryPath.trim()}><ListPlus/>追加</button></div>
  </div></div>;
}

function HelpModal({ open, close }) {
  if (!open) return null;
  return <div className="modal-layer" onMouseDown={close}><div className="modal help-modal" onMouseDown={event => event.stopPropagation()}>
    <header><div><span className="eyebrow">SHORTCUTS & SETTINGS</span><h3>ショートカットと設定</h3></div><button className="icon-button" onClick={close}><X/></button></header>
    <div className="help-grid">
      <section><h4>ショートカット</h4><dl><div><dt><kbd>I</kbd></dt><dd>無視リスト編集モーダルを開く</dd></div><div><dt><kbd>H</kbd></dt><dd>この説明を開く／閉じる</dd></div><div><dt><kbd>Ctrl</kbd> + <kbd>S</kbd></dt><dd>編集中の無視リストを保存して閉じる</dd></div><div><dt><kbd>Esc</kbd></dt><dd>保存せずにモーダルを閉じる</dd></div><div><dt><kbd>Ctrl</kbd> + <kbd>Z</kbd></dt><dd>無視リスト編集中の変更を戻す</dd></div><div><dt><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd></dt><dd>戻した変更を進める</dd></div></dl></section>
      <section><h4>ハンバーガーメニュー</h4><dl><div><dt>ignored項目を表示</dt><dd>無視対象の入口を取り消し線で表示します。</dd></div><div><dt>無視リストを編集</dt><dd>1行1パターンで編集し、リポジトリの設定ファイルへ保存します。</dd></div><div><dt>Python実行モード</dt><dd>通常版はvenvと環境変数から参照ソースも自動検出します。Embedded版では参照リポジトリ機能を無効にします。</dd></div><div><dt>Git差分コマンド</dt><dd>クリップボードへ格納する差分を取得するコマンドを指定します（デフォルト: git diff HEAD -- *.py）。</dd></div><div><dt>対象リポジトリを追加</dt><dd>ファイルの右クリックから、未解決モジュールと外部ソースリポジトリを手動で対応付けます。</dd></div></dl></section>
    </div>
    <p className="help-note">入力欄やターミナルにカーソルがある間は、I/Hを通常の入力として扱います。</p>
  </div></div>;
}

function SettingsDrawer({ open, close, path, openIgnoreEditor, showIgnored, setShowIgnored, pythonMode, setPythonMode, embeddedDir, setEmbeddedDir, gitDiffCommand, setGitDiffCommand, reload }) {
  if (!open) return null;
  return <div className="drawer-layer" onMouseDown={close}>
    <aside className="drawer" onMouseDown={event => event.stopPropagation()}>
      <div className="drawer-title"><div><span className="eyebrow">SYSTEM</span><h2><Settings/>設定</h2></div><button className="icon-button" onClick={close}><X/></button></div>
      <div className="setting-group">
        <label className="switch-line"><div><strong>ignored項目を表示</strong><small>内部は走査せず、入口だけ取り消し線で表示します</small></div><input type="checkbox" checked={showIgnored} onChange={event => { setShowIgnored(event.target.checked); reload(event.target.checked); }}/></label>
      </div>
      <div className="setting-group"><button className="drawer-action" onClick={openIgnoreEditor} disabled={!path}><ListPlus/>無視リストを編集</button><small className="drawer-subnote">現在のリポジトリの設定ファイルを編集します。</small></div>
      <div className="setting-group"><label>Python実行モード</label>
        <select value={pythonMode} onChange={event => setPythonMode(event.target.value)}><option value="normal">通常版（venv自動検出）</option><option value="embedded">Embedded Python</option></select>
        {pythonMode === 'embedded' && <input value={embeddedDir} onChange={event => setEmbeddedDir(event.target.value)} placeholder="python.exeがあるフォルダ"/>}
      </div>
      <div className="setting-group"><label>Git差分コマンド</label>
        <input value={gitDiffCommand} onChange={event => setGitDiffCommand(event.target.value)} placeholder={DEFAULT_GIT_DIFF_COMMAND}/>
        <small className="drawer-subnote">差分コピー時に実行するgitコマンド（空欄時はデフォルト: {DEFAULT_GIT_DIFF_COMMAND}）</small>
      </div>
      <p className="drawer-note">設定はこのブラウザに自動保存されます。</p>
    </aside>
  </div>;
}

function PreviewModal({ file, content, close }) {
  if (!file) return null;
  const isMarkdown = /\.md$/i.test(file);
  return <div className="modal-layer" onMouseDown={close}><div className={`modal preview-modal ${isMarkdown ? 'markdown-modal' : 'code-modal'}`} tabIndex="-1" onMouseDown={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
    <header><div><span className="eyebrow">FILE PREVIEW · {isMarkdown ? 'MARKDOWN' : 'CODE'}</span><h3>{file}</h3></div><button className="icon-button" onClick={close}><X/></button></header>
    <PreviewSearch>{isMarkdown ? <MarkdownPreview content={content}/> : <CodePreview content={content} path={file}/>}</PreviewSearch>
  </div></div>;
}

function TerminalPanel({ path, pythonMode, embeddedDir }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('offline');
  const [shellName, setShellName] = useState('terminal');
  const [dimensions, setDimensions] = useState('100×28');
  const [restartKey, setRestartKey] = useState(0);
  const terminalHostRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);
  const socketRef = useRef(null);
  useEffect(() => {
    if (!open || !terminalHostRef.current) return;
    let disposed = false;
    let resizeObserver;
    let dataSubscription;
    let terminal;
    let socket;
    const workingPath = path || '.';
    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(([{ Terminal }, { FitAddon }]) => {
      if (disposed || !terminalHostRef.current) return;
      terminal = new Terminal({
        cursorBlink: true, cursorStyle: 'block', scrollback: 8000,
        fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 14, lineHeight: 1.25, convertEol: false,
        theme: {
          background: '#171c28', foreground: '#e5e7eb', cursor: '#a8adb8',
          cursorAccent: '#171c28', selectionBackground: '#53617a88',
          black: '#1f2430', red: '#ff657a', green: '#9dd274', yellow: '#eacb64',
          blue: '#72a7ff', magenta: '#ba8cff', cyan: '#5ccfe6', white: '#d8dee9',
          brightBlack: '#666b7a', brightRed: '#ff8b98', brightGreen: '#b8e986',
          brightYellow: '#ffe083', brightBlue: '#8fbcff', brightMagenta: '#cfa8ff',
          brightCyan: '#8be9fd', brightWhite: '#ffffff'
        }
      });
      const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(terminalHostRef.current);
      terminalRef.current = terminal; fitRef.current = fit; fit.fit();
      setDimensions(`${terminal.cols}×${terminal.rows}`);
      terminal.writeln('\x1b[90mConnecting to interactive shell…\x1b[0m');
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams({ cwd: workingPath, mode: pythonMode, embedded_python_dir: embeddedDir });
      socket = new WebSocket(`${protocol}//${location.host}/api/terminal/ws?${params}`);
      socketRef.current = socket; setStatus('connecting');
      let localEcho = false;
      socket.onopen = () => socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'ready') {
          localEcho = Boolean(message.localEcho); setStatus('ready'); setShellName(message.shell || 'shell');
          terminal.clear(); terminal.focus();
        } else if (message.type === 'output') terminal.write(message.data);
        else if (message.type === 'error') terminal.writeln(`\r\n\x1b[31m${message.data}\x1b[0m`);
      };
      socket.onclose = () => { setStatus('offline'); if (!disposed) terminal.writeln('\r\n\x1b[90m[terminal disconnected]\x1b[0m'); };
      socket.onerror = () => { setStatus('error'); terminal.writeln('\r\n\x1b[31m[connection error]\x1b[0m'); };
      dataSubscription = terminal.onData(data => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (localEcho) {
          if (data === '\r') terminal.write('\r\n');
          else if (data === '\x7f') terminal.write('\b \b');
          else if (!data.startsWith('\x1b')) terminal.write(data);
        }
        socket.send(JSON.stringify({ type: 'input', data }));
      });
      resizeObserver = new ResizeObserver(() => {
        if (disposed) return; fit.fit(); setDimensions(`${terminal.cols}×${terminal.rows}`);
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      });
      resizeObserver.observe(terminalHostRef.current);
    });
    return () => {
      disposed = true; resizeObserver?.disconnect(); dataSubscription?.dispose();
      if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) socket.close();
      terminal?.dispose(); terminalRef.current = null; fitRef.current = null;
    };
  }, [open, path, pythonMode, embeddedDir, restartKey]);
  return <section className={`terminal-panel ${open ? 'open' : ''}`}>
    <div className="terminal-heading">
      <button className="terminal-title" onClick={() => setOpen(!open)}><TerminalSquare/><strong>{path ? path.split(/[\\/]/).filter(Boolean).at(-1) : 'terminal'} — {shellName} — {dimensions}</strong></button>
      <span className={`status-dot ${status}`}/>
      {open && <button className="terminal-restart" title="ターミナルを再起動" onClick={() => setRestartKey(key => key + 1)}><RefreshCw/></button>}
      <button className="terminal-toggle" onClick={() => setOpen(!open)}><ChevronDown/></button>
    </div>
    {open && <div className="terminal-content" ref={terminalHostRef}/>} 
  </section>;
}

function PatchPanel({ path, pythonMode, embeddedDir, notify }) {
  const [output, setOutput] = useState('');
  const [targetPath, setTargetPath] = useState('');
  const [preview, setPreview] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testCommand, setTestCommand] = useState('python -m pytest');
  const [testResult, setTestResult] = useState(null);
  const requestPreview = async (nextOverrides = overrides) => {
    if (!path || !output.trim()) return setError('リポジトリとAI出力を指定してください。');
    setBusy(true); setError('');
    try { setPreview(await api('/api/patch/preview', { library_path: path, ai_output: output, target_path: targetPath, overrides: nextOverrides })); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const choose = (key, value) => { const next = { ...overrides, [key]: value }; setOverrides(next); requestPreview(next); };
  const apply = async () => {
    setBusy(true); setError('');
    try { const data = await api('/api/patch/apply', { library_path: path, ai_output: output, target_path: targetPath, overrides }); if (data.status !== 'success') throw new Error(data.message); notify(data.message); setPreview(null); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setError('');
    try { setTestResult(await api('/api/test', { library_path: path, test_command: testCommand, python_mode: pythonMode, embedded_python_dir: embeddedDir })); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const feedback = async () => {
    const merged = `${testResult?.stdout || ''}\n${testResult?.stderr || ''}`.trim();
    const data = await api('/api/feedback_context', { library_path: path, test_command: testCommand, output: merged, exit_code: testResult?.exit_code });
    await navigator.clipboard.writeText(data.context); notify('修正依頼用のテスト結果をコピーしました。');
  };
  return <section className="card patch-card">
    <div className="section-heading"><div><span className="eyebrow">APPLY</span><h2><Code2/>AIの変更を反映</h2></div><span className="format-pill">3形式を自動判定</span></div>
    <p className="section-help">関数全体、ファイルパス付きコードブロック、または &lt;file_changes&gt; を貼り付けてください。</p>
    <div className="patch-inputs"><textarea value={output} onChange={event => { setOutput(event.target.value); setPreview(null); }} placeholder="AIの回答をここに貼り付けます"/><div className="target-line"><input value={targetPath} onChange={event => setTargetPath(event.target.value)} placeholder="反映先ファイル（通常は空欄でOK）"/><button className="primary" onClick={() => requestPreview()} disabled={busy}>{busy ? <LoaderCircle className="spin"/> : <Search/>}差分を確認</button></div></div>
    {error && <div className="error-box"><AlertTriangle/>{error}</div>}
    {preview && <div className="preview-area">
      <div className="preview-title"><strong>{preview.message}</strong>{preview.status === 'success' && <button className="success-button" onClick={apply} disabled={busy}><Save/>この差分を反映</button>}</div>
      {preview.changes.map(change => <div className="change" key={change.key}>
        <div className="change-meta"><span>{change.path || change.symbol || '反映先未確定'}</span><em>{change.action}</em></div>
        {!change.path && <select value="" onChange={event => choose(change.key, event.target.value)}><option value="">反映先を選択…</option>{change.candidates.map(candidate => <option key={candidate}>{candidate}</option>)}</select>}
        {change.diff && <pre className="diff">{change.diff}</pre>}
      </div>)}
    </div>}
    <div className="test-row"><TestTube2/><input value={testCommand} onChange={event => setTestCommand(event.target.value)}/><button onClick={test} disabled={!path || busy}><CirclePlay/>テスト</button>{testResult && <span className={testResult.exit_code === 0 ? 'test-ok' : 'test-ng'}>{testResult.exit_code === 0 ? '成功' : `失敗 (${testResult.exit_code ?? 'timeout'})`}</span>}</div>
    {testResult && <div className="test-output"><pre>{`${testResult.stdout || ''}\n${testResult.stderr || ''}`}</pre>{testResult.exit_code !== 0 && <button onClick={feedback}><Copy/>LLMへ戻す文面をコピー</button>}</div>}
  </section>;
}

function MainPage() {
  const [path, setPath] = useState(localStorage.getItem('spoonfeederPath') || '');
  const [activePath, setActivePath] = useState(localStorage.getItem('spoonfeederPath') || '');
  const [repositories, setRepositories] = useState([]);
  const [tree, setTree] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [filter, setFilter] = useState('');
  const [showIgnored, setShowIgnored] = useState(localStorage.getItem('showIgnored') === 'true');
  const [pythonMode, setPythonMode] = useState(localStorage.getItem('pythonMode') || 'normal');
  const [embeddedDir, setEmbeddedDir] = useState(localStorage.getItem('embeddedDir') || '');
  const [gitDiffCommand, setGitDiffCommand] = useState(localStorage.getItem('gitDiffCommand') ?? DEFAULT_GIT_DIFF_COMMAND);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [context, setContext] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [previewFile, setPreviewFile] = useState('');
  const [previewContent, setPreviewContent] = useState('');
  const [ignoreEditorOpen, setIgnoreEditorOpen] = useState(false);
  const [ignoreEditorPattern, setIgnoreEditorPattern] = useState('');
  const [contextMenu, setContextMenu] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [referenceData, setReferenceData] = useState({ enabled: true, repositories: [], unresolved: [], manual_references: {}, warnings: [] });
  const [referenceSelected, setReferenceSelected] = useState(new Set());
  const [referenceEditorOpen, setReferenceEditorOpen] = useState(false);
  const [referenceInitialFile, setReferenceInitialFile] = useState('');
  const referenceAvailableRef = useRef(new Set());
  const treeRef = useRef(null);
  const previewReturnRef = useRef(null);
  const notify = useCallback(message => setToast(message), []);
  useEffect(() => { localStorage.setItem('showIgnored', String(showIgnored)); }, [showIgnored]);
  useEffect(() => { localStorage.setItem('pythonMode', pythonMode); localStorage.setItem('embeddedDir', embeddedDir); }, [pythonMode, embeddedDir]);
  useEffect(() => { localStorage.setItem('gitDiffCommand', gitDiffCommand); }, [gitDiffCommand]);
  useEffect(() => { api('/api/repositories', undefined, 'GET').then(data => setRepositories(data.repositories || [])).catch(() => {}); }, []);
  const load = useCallback(async (overrideShowIgnored = showIgnored, overridePath = path) => {
    if (!overridePath.trim()) return setError('リポジトリのフォルダパスを入力してください。');
    setLoading(true); setError(''); setContext('');
    try {
      const data = await api('/api/repository_structure', { library_path: overridePath, show_ignored: overrideShowIgnored });
      setTree(data.files || []); const all = flattenFiles(data.files || []);
      setSelected(new Set(data.selected_files?.length ? data.selected_files.filter(item => all.includes(item)) : all));
      setPath(overridePath); setActivePath(overridePath); localStorage.setItem('spoonfeederPath', overridePath);
      setRepositories(previous => Array.from(new Set([...previous, overridePath])));
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }, [path, showIgnored]);
  useEffect(() => { if (path) load(showIgnored, path); }, []);
  const refreshReferences = useCallback(async () => {
    if (!activePath || pythonMode === 'embedded') {
      referenceAvailableRef.current = new Set(); setReferenceSelected(new Set());
      setReferenceData({ enabled: false, repositories: [], unresolved: [], manual_references: {}, warnings: [] });
      return;
    }
    try {
      const data = await api('/api/reference_modules', { library_path: activePath, selected_files: Array.from(selected), python_mode: pythonMode });
      const available = new Set((data.repositories || []).flatMap(repo => (repo.files || []).map(file => `${repo.path}::${file}`)));
      const previousAvailable = referenceAvailableRef.current;
      setReferenceSelected(previous => new Set(Array.from(available).filter(key => !previousAvailable.has(key) || previous.has(key))));
      referenceAvailableRef.current = available;
      setReferenceData(data);
    } catch (err) {
      setReferenceData(previous => ({ ...previous, warnings: [err.message] }));
    }
  }, [activePath, pythonMode, selected]);
  useEffect(() => {
    const timer = setTimeout(refreshReferences, 220);
    return () => clearTimeout(timer);
  }, [refreshReferences]);
  useEffect(() => {
    const close = () => setContextMenu(null);
    const shortcuts = event => {
      if (event.defaultPrevented) return;
      const key = event.key.toLowerCase();
      if (helpOpen) {
        if (key === 'h' || event.key === 'Escape') { event.preventDefault(); setHelpOpen(false); }
        return;
      }
      if (ignoreEditorOpen || referenceEditorOpen) return;
      if (event.key === 'Escape') { if (previewFile) closePreview(); else close(); return; }
      const target = event.target;
      if (target instanceof HTMLElement && (target.matches('input, textarea, select, [contenteditable="true"]') || target.closest('.xterm'))) return;
      if (!event.ctrlKey && !event.metaKey && !event.altKey && key === 'i') { event.preventDefault(); openIgnoreEditor(); }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && key === 'h') { event.preventDefault(); setHelpOpen(true); }
    };
    window.addEventListener('click', close); window.addEventListener('keydown', shortcuts);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', shortcuts); };
  }, [helpOpen, ignoreEditorOpen, referenceEditorOpen, path, previewFile]);
  const openIgnoreEditor = (pattern = '') => { setSettingsOpen(false); setIgnoreEditorPattern(pattern); setIgnoreEditorOpen(true); };
  const refreshAfterIgnoreChange = async () => { setIgnoreEditorOpen(false); await load(showIgnored, path); };
  const addIgnorePattern = async node => {
    setContextMenu(null);
    try {
      const current = await api('/api/ignore_patterns', { library_path: path });
      const patterns = Array.from(new Set([...(current.patterns || []), node.path]));
      const data = await api('/api/save_ignore_patterns', { library_path: path, patterns });
      await load(showIgnored, path); notify(`「${node.path}」を無視リストに追加しました。`);
      return data;
    } catch (err) { setError(err.message); }
  };
  const removeIgnorePattern = async node => {
    setContextMenu(null);
    try {
      const data = await api('/api/remove_ignore_pattern', { library_path: path, path: node.path });
      await load(showIgnored, path);
      notify(data.status === 'success' ? `「${node.path}」を無視リストから除外しました。` : data.message);
    } catch (err) { setError(err.message); }
  };
  const handleTreeContextMenu = (event, node) => {
    setContextMenu({ x: event.clientX, y: event.clientY, node });
  };
  const openReferenceEditor = node => {
    setReferenceInitialFile(node?.type === 'file' ? node.path : '');
    setContextMenu(null); setReferenceEditorOpen(true);
  };
  const generate = async () => {
    setLoading(true); setError('');
    try {
      const referenceFiles = (referenceData.repositories || []).map(repo => ({ repository_path: repo.path, files: (repo.files || []).filter(file => referenceSelected.has(`${repo.path}::${file}`)) }));
      const data = await api('/api/repository_context', { library_path: activePath || path, selected_files: Array.from(selected), reference_files: referenceFiles });
      setContext(data.context); notify(`メイン${data.file_count}件・参照${data.reference_file_count || 0}件のコンテキストを作成しました。`);
    }
    catch (err) { setError(err.message); } finally { setLoading(false); }
  };
  const copy = async () => { await navigator.clipboard.writeText(context); notify('コンテキストをコピーしました。'); };
  const download = () => { const url = URL.createObjectURL(new Blob([context], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = 'repository_context.txt'; link.click(); URL.revokeObjectURL(url); notify('repository_context.txtを保存しました。'); };
  const closePreview = () => {
    setPreviewFile('');
    const returnFocus = previewReturnRef.current;
    setTimeout(() => {
      const items = Array.from(treeRef.current?.querySelectorAll('[data-tree-item="true"]') || []);
      const target = returnFocus && items.find(item => item.dataset.treePath === returnFocus.path && (item.dataset.treeRepository || activePath || path) === returnFocus.repository);
      (target || treeRef.current)?.focus();
    }, 0);
  };
  const openPreview = async (file, repositoryPath = activePath || path) => {
    const focused = treeRef.current?.querySelector('[data-tree-item="true"]:focus');
    if (focused) previewReturnRef.current = { path: focused.dataset.treePath, repository: focused.dataset.treeRepository || activePath || path };
    setPreviewFile(file); setPreviewContent('読み込み中…'); try { const data = await api('/api/file_content', { library_path: repositoryPath, file_path: file }); setPreviewContent(data.content); } catch (err) { setPreviewContent(err.message); }
  };
  const copyGitDiff = async () => {
    if (!path) return;
    setLoadingDiff(true);
    try {
      const effectiveCommand = resolveGitDiffCommand(gitDiffCommand);
      const data = await api('/api/git_diff', { library_path: path, command: effectiveCommand });
      await navigator.clipboard.writeText(data.diff || '');
      notify(formatGitDiffMessage(data.diff));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingDiff(false);
    }
  };
  const openCode = async () => { const data = await api('/api/open_in_code', { library_path: path }); data.status === 'success' ? notify(data.message) : setError(data.message); };
  const openMap = () => window.open(`/map?path=${encodeURIComponent(path)}`, '_blank', 'noopener');
  const allFiles = useMemo(() => flattenFiles(tree), [tree]);
  const referenceFileCount = useMemo(() => (referenceData.repositories || []).reduce((total, repo) => total + (repo.files || []).length, 0), [referenceData]);
  const handleTreeKeyDown = event => {
    const tree = treeRef.current;
    if (!tree) return;
    const items = Array.from(tree.querySelectorAll('[data-tree-item="true"]'));
    const current = event.target.closest?.('[data-tree-item="true"]');
    const index = current ? items.indexOf(current) : -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const nextIndex = index < 0
        ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[nextIndex]?.focus();
      return;
    }
    if (!current) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      if (current.dataset.treeKind !== 'directory') return;
      const expanded = current.getAttribute('aria-expanded') === 'true';
      if ((event.key === 'ArrowRight' && !expanded) || (event.key === 'ArrowLeft' && expanded)) {
        event.preventDefault();
        current.querySelector('[data-tree-toggle="true"]')?.click();
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey && current.dataset.treeKind === 'file' && current.dataset.treeIgnored !== 'true') {
        openPreview(current.dataset.treePath, current.dataset.treeRepository || activePath || path);
        return;
      }
      if (current.dataset.treeKind === 'directory') {
        current.querySelector('[data-tree-toggle="true"]')?.click();
      } else if (current.dataset.treeIgnored !== 'true') {
        current.querySelector('input[type="checkbox"]:not(:disabled)')?.click();
      }
    }
  };
  return <div className="app-shell">
    <header className="topbar"><div className="brand"><div className="logo">S</div><div><h1>Spoonfeeder<span>2</span></h1><p>Repository context workspace</p></div></div><div className="top-actions"><button onClick={openMap} disabled={!path}><Map/>依存関係マップ<ExternalLink/></button><button onClick={() => openIgnoreEditor()} disabled={!path}><ListPlus/>無視リスト編集</button><button className="icon-button" onClick={() => setSettingsOpen(true)}><Menu/></button></div></header>
    <main>
      <section className="path-bar card">
        <div className="path-label"><GitBranch/><span>REPOSITORY</span></div>
        <RepositorySelector
          path={path}
          setPath={setPath}
          repositories={repositories}
          setRepositories={setRepositories}
          onLoad={load}
          loading={loading}
          showIgnored={showIgnored}
          notify={notify}
        />
        <button
          onClick={copyGitDiff}
          disabled={!path || loadingDiff}
          title={`Git差分をクリップボードにコピー (${resolveGitDiffCommand(gitDiffCommand)})`}
        >
          {loadingDiff ? <LoaderCircle className="spin"/> : <GitCompare/>}Git差分コピー
        </button>
        <button onClick={openCode} disabled={!path}><MonitorCog/>VS Code</button>
      </section>
      {error && <div className="error-box global"><AlertTriangle/>{error}<button onClick={() => setError('')}><X/></button></div>}
      <div className="workspace-grid">
        <section className="card repository-card">
          <div className="section-heading"><div><span className="eyebrow">SELECT</span><h2><Folder/>ファイルを選択</h2></div><span className="count-badge">{selected.size} / {allFiles.length}</span></div>
          <div className="tree-tools"><div><Search/><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="ファイルを検索"/></div><button onClick={() => setSelected(selected.size === allFiles.length ? new Set() : new Set(allFiles))}>{selected.size === allFiles.length ? '選択解除' : 'すべて選択'}</button></div>
          <div className="tree-scroll" ref={treeRef} tabIndex={0} role="tree" aria-label="ファイル選択ツリー" onKeyDown={handleTreeKeyDown}>
            {tree.length ? tree.map(node => <TreeNode key={`${node.path}:${node.ignored}`} node={node} selected={selected} setSelected={setSelected} filter={filter} onPreview={openPreview} onContextMenu={handleTreeContextMenu}/>) : <div className="empty-state"><FolderOpen/><p>リポジトリを読み込むと<br/>ファイルが表示されます</p></div>}
            {referenceData.enabled && ((referenceData.repositories || []).length > 0 || (referenceData.unresolved || []).length > 0 || (referenceData.warnings || []).length > 0) && <div className="reference-tree-section">
              <div className="reference-tree-title"><span><GitBranch/>参照ライブラリ</span><em>{referenceSelected.size} / {referenceFileCount}</em></div>
              {(referenceData.repositories || []).map(repo => <section className="reference-repository" key={repo.path}>
                <header><span><Folder/>{repo.name}</span><small title={repo.path}>{repo.reason === 'manual' ? '手動' : repo.reason === 'project-reference' ? 'ProjectReference' : '環境から検出'}</small></header>
                {(repo.tree || []).map(node => <TreeNode key={`${repo.path}:${node.path}`} node={node} selected={referenceSelected} setSelected={setReferenceSelected} filter={filter} onPreview={file => openPreview(file, repo.path)} selectionPrefix={`${repo.path}::`}/>) }
              </section>)}
              {(referenceData.unresolved || []).length > 0 && <button className="unresolved-reference" onClick={() => openReferenceEditor()}><AlertTriangle/>{referenceData.unresolved.length}件の参照先を確認</button>}
              {(referenceData.warnings || []).map(warning => <div className="reference-warning" key={warning}><AlertTriangle/>{warning}</div>)}
            </div>}
          </div>
          <p className="tree-hint">クリックでプレビュー · 右クリックで無視設定／未解決リポジトリを追加</p>
        </section>
        <section className="card context-card"><div className="section-heading"><div><span className="eyebrow">CONTEXT</span><h2><Clipboard/>チャット添付用コンテキスト</h2></div>{context && <span className="ready-pill">READY</span>}</div><p className="section-help">メインの選択ファイルと、実際に参照している外部ソースを1つのテキストにまとめます。</p><div className="context-output">{context ? <textarea readOnly value={context}/> : <div className="context-placeholder"><File/><strong>repository_context.txt</strong><span>チャットへ添付できる形式で生成します</span></div>}</div><div className="context-actions">{context ? <><button onClick={copy}><Copy/>コピー</button><button onClick={download}><Download/>保存</button></> : <span/>}<button className="primary large" onClick={generate} disabled={!path || loading || selected.size === 0}>{loading ? <LoaderCircle className="spin"/> : <Clipboard/>}コンテキストを作成</button></div></section>
      </div>
      <PatchPanel path={path} pythonMode={pythonMode} embeddedDir={embeddedDir} notify={notify}/>
      <TerminalPanel path={path} pythonMode={pythonMode} embeddedDir={embeddedDir}/>
    </main>
    <SettingsDrawer open={settingsOpen} close={() => setSettingsOpen(false)} path={path} openIgnoreEditor={() => openIgnoreEditor()} showIgnored={showIgnored} setShowIgnored={setShowIgnored} pythonMode={pythonMode} setPythonMode={setPythonMode} embeddedDir={embeddedDir} setEmbeddedDir={setEmbeddedDir} gitDiffCommand={gitDiffCommand} setGitDiffCommand={setGitDiffCommand} reload={value => load(value)}/>
    <PreviewModal file={previewFile} content={previewContent} close={closePreview}/>
    <IgnorePatternsModal open={ignoreEditorOpen} close={() => setIgnoreEditorOpen(false)} path={path} initialPattern={ignoreEditorPattern} onSaved={refreshAfterIgnoreChange} notify={notify}/>
    <ReferenceRepositoryModal open={referenceEditorOpen} close={() => setReferenceEditorOpen(false)} path={activePath || path} repositories={repositories} unresolved={referenceData.unresolved || []} initialFile={referenceInitialFile} manualReferences={referenceData.manual_references || {}} onSaved={refreshReferences} notify={notify}/>
    <HelpModal open={helpOpen} close={() => setHelpOpen(false)}/>
    {contextMenu && <div className="tree-context-menu" style={{ top: `${Math.min(contextMenu.y, Math.max(8, window.innerHeight - 112))}px`, left: `${Math.min(contextMenu.x, Math.max(8, window.innerWidth - 250))}px` }} onClick={event => event.stopPropagation()}>
      {contextMenu.node.ignored ? <button onClick={() => removeIgnorePattern(contextMenu.node)}><Ban/>無視リストから除外</button> : <button onClick={() => addIgnorePattern(contextMenu.node)}><ListPlus/>無視リストへ追加</button>}
      {pythonMode !== 'embedded' && <button onClick={() => openReferenceEditor(contextMenu.node)} disabled={(referenceData.unresolved || []).length === 0 && Object.keys(referenceData.manual_references || {}).length === 0}><GitBranch/>対象リポジトリを追加</button>}
    </div>}
    {toast && <Toast message={toast} onClose={() => setToast('')}/>}<footer>Python + C# · Git-aware · Local only</footer>
  </div>;
}

function DependencyMap() {
  const params = new URLSearchParams(location.search);
  const [path, setPath] = useState(params.get('path') || localStorage.getItem('spoonfeederPath') || '');
  const [data, setData] = useState({ nodes: [], edges: [] });
  const [filters, setFilters] = useState({ contains: true, import: true, calls: true });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const svgRef = useRef(null);
  const load = async () => { try { setError(''); setData(await api('/api/dependency_map', { library_path: path })); } catch (err) { setError(err.message); } };
  useEffect(() => { if (path) load(); }, []);
  useEffect(() => {
    if (!svgRef.current || !data.nodes.length) return;
    const svg = d3.select(svgRef.current); svg.selectAll('*').remove();
    const width = svgRef.current.clientWidth, height = svgRef.current.clientHeight;
    const viewport = svg.append('g');
    svg.call(d3.zoom().scaleExtent([0.15, 4]).on('zoom', event => viewport.attr('transform', event.transform)));
    const nodes = data.nodes.map(item => ({ ...item }));
    const visibleEdges = data.edges.filter(edge => filters[edge.type]);
    const links = visibleEdges.map(item => ({ ...item }));
    const simulation = d3.forceSimulation(nodes).force('link', d3.forceLink(links).id(d => d.id).distance(d => d.type === 'contains' ? 50 : 150)).force('charge', d3.forceManyBody().strength(-220)).force('center', d3.forceCenter(width / 2, height / 2)).force('collide', d3.forceCollide(22));
    const link = viewport.append('g').selectAll('line').data(links).join('line').attr('class', d => `graph-link ${d.type}`);
    const node = viewport.append('g').selectAll('g').data(nodes).join('g').attr('class', d => `graph-node ${d.type}`).call(d3.drag().on('start', (event, d) => { if (!event.active) simulation.alphaTarget(.3).restart(); d.fx = d.x; d.fy = d.y; }).on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; }).on('end', (event, d) => { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));
    node.append('circle').attr('r', d => d.type === 'file' ? 11 : d.type === 'class' ? 8 : 5).on('click', (_, d) => setSelected(d));
    node.append('text').attr('x', 13).attr('y', 4).text(d => d.label);
    simulation.on('tick', () => { link.attr('x1', d => d.source.x).attr('y1', d => d.source.y).attr('x2', d => d.target.x).attr('y2', d => d.target.y); node.attr('transform', d => `translate(${d.x},${d.y})`); });
    return () => simulation.stop();
  }, [data, filters]);
  useEffect(() => { if (!svgRef.current) return; d3.select(svgRef.current).selectAll('.graph-node').classed('dim', d => query && !d.label.toLowerCase().includes(query.toLowerCase())); }, [query]);
  return <div className="map-page"><svg ref={svgRef}/><aside className="map-controls"><div className="brand mini"><div className="logo">S</div><div><h1>Spoonfeeder Map</h1><p>Python + C# dependencies</p></div></div><label>解析パス</label><div className="map-path"><input value={path} onChange={event => setPath(event.target.value)}/><button onClick={load}><RefreshCw/></button></div><label>ノード検索</label><div className="search-box"><Search/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="名前を入力"/></div><label>関係を表示</label>{Object.keys(filters).map(key => <label className="switch-line compact" key={key}><span>{key === 'contains' ? '包含関係' : key === 'import' ? 'import / using' : '呼び出し'}</span><input type="checkbox" checked={filters[key]} onChange={event => setFilters({ ...filters, [key]: event.target.checked })}/></label>)}<div className="legend"><span><i className="file"/>ファイル</span><span><i className="class"/>クラス</span><span><i className="function"/>関数</span></div>{error && <div className="error-box"><AlertTriangle/>{error}</div>}<a href="/">← コンテキスト画面へ戻る</a></aside>{selected && <aside className="node-detail"><button onClick={() => setSelected(null)}><X/></button><span className="eyebrow">{selected.type}</span><h2>{selected.label}</h2><code>{selected.id}</code>{selected.parent && <p>所属<br/><strong>{selected.parent}</strong></p>}</aside>}</div>;
}

export default function App() { return location.pathname === '/map' ? <DependencyMap/> : <MainPage/>; }
