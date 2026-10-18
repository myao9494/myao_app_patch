/**
 * ファイルツリーの右クリックメニュー (TreeContextMenu.jsx)
 *
 * 仕様:
 * 1. ignored項目では「無視リストから除外」、通常項目では「無視リストへ追加」を表示する。
 * 2. Embedded Python以外では「対象リポジトリを追加」を表示する（未解決も手動設定もなければ無効）。
 * 3. 画面外にはみ出さないよう表示位置を補正する。
 **/

import { Ban, GitBranch, ListPlus } from 'lucide-react';

export function TreeContextMenu({ menu, pythonMode, referenceData, onAddIgnore, onRemoveIgnore, onOpenReferenceEditor }) {
  const hasReferenceTargets = (referenceData.unresolved || []).length > 0 || Object.keys(referenceData.manual_references || {}).length > 0;
  return <div className="tree-context-menu" style={{ top: `${Math.min(menu.y, Math.max(8, window.innerHeight - 112))}px`, left: `${Math.min(menu.x, Math.max(8, window.innerWidth - 250))}px` }} onClick={event => event.stopPropagation()}>
    {menu.node.ignored ? <button onClick={() => onRemoveIgnore(menu.node)}><Ban/>無視リストから除外</button> : <button onClick={() => onAddIgnore(menu.node)}><ListPlus/>無視リストへ追加</button>}
    {pythonMode !== 'embedded' && <button onClick={() => onOpenReferenceEditor(menu.node)} disabled={!hasReferenceTargets}><GitBranch/>対象リポジトリを追加</button>}
  </div>;
}
