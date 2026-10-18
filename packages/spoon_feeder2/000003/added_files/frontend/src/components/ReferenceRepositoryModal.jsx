/**
 * 未解決モジュールと参照リポジトリの手動対応付けモーダル (ReferenceRepositoryModal.jsx)
 *
 * 仕様:
 * 1. 自動解決できなかったモジュールを選び、参照元リポジトリのパスと対応付けて保存する（メインリポジトリごと）。
 * 2. 保存済みの手動設定を一覧し、個別に解除できる。
 * 3. Enter で追加、Esc で閉じる。
 **/

import { useEffect, useState } from 'react';
import { AlertTriangle, Check, ListPlus, X } from 'lucide-react';
import { api } from '../api';

export function ReferenceRepositoryModal({ open, close, path, repositories, unresolved, initialFile, manualReferences, onSaved, notify }) {
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
