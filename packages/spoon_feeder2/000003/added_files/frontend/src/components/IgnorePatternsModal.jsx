/**
 * 無視リスト編集モーダル (IgnorePatternsModal.jsx)
 *
 * 仕様:
 * 1. 開いたときに現在の無視リストを読み込み、1行1パターンのテキストとして編集する。
 * 2. Ctrl/Cmd+S で保存して閉じる、Esc で破棄して閉じる、Ctrl/Cmd+Z・Shift+Z・Y でUndo/Redoする。
 * 3. 保存時は区切りを / に統一し、空行と重複を除いたパターンを送る。
 **/

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Save, X } from 'lucide-react';
import { api } from '../api';
import { TextHistory } from '../lib/ignoreHistory';
import { parseIgnoreText } from '../lib/selection';

export function IgnorePatternsModal({ open, close, path, initialPattern, onSaved, notify }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [configFile, setConfigFile] = useState('');
  const historyRef = useRef(new TextHistory());
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
      historyRef.current = new TextHistory(nextText);
    }).catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [open, path, initialPattern]);
  if (!open) return null;
  const updateText = nextText => { historyRef.current.push(nextText); setText(nextText); };
  const undo = () => setText(historyRef.current.undo());
  const redo = () => setText(historyRef.current.redo());
  const handleKeyDown = event => {
    const key = event.key.toLowerCase();
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && key === 's') { event.preventDefault(); event.stopPropagation(); save(); return; }
    if (modifier && key === 'z') { event.preventDefault(); event.stopPropagation(); event.shiftKey ? redo() : undo(); return; }
    if (modifier && key === 'y') { event.preventDefault(); event.stopPropagation(); redo(); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  };
  const save = async () => {
    const patterns = parseIgnoreText(text);
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
