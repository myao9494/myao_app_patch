/**
 * 設定ドロワー (SettingsDrawer.jsx)
 *
 * 仕様:
 * 1. ignored項目の表示、無視リスト編集、Python実行モード(通常/Embedded)、Git差分コマンドを設定する。
 * 2. Embedded選択時のみ python.exe のフォルダ入力欄を表示する。
 **/

import { ListPlus, Settings, X } from 'lucide-react';
import { DEFAULT_GIT_DIFF_COMMAND } from '../gitDiff';

export function SettingsDrawer({ open, close, path, openIgnoreEditor, showIgnored, setShowIgnored, pythonMode, setPythonMode, embeddedDir, setEmbeddedDir, gitDiffCommand, setGitDiffCommand, reload }) {
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
