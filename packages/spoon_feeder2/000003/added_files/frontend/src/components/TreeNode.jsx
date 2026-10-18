/**
 * ファイルツリーの1ノード (TreeNode.jsx)
 *
 * 仕様:
 * 1. ディレクトリは開閉、ファイルはチェックで選択切替・クリックでプレビュー、右クリックでメニューを開く。
 * 2. フィルター一致時は祖先を自動展開し、一致しないノードは描画しない。
 * 3. ignored項目はチェック不可で「ignored」バッジを表示する。
 * 4. キーボード操作用の data-tree-* 属性を付与する（操作は usePreview の handleTreeKeyDown が担当）。
 **/

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { flattenFiles, nodeMatchesFilter, toggleSelection } from '../lib/selection';
import { FileIcon } from './FileIcon';

export function TreeNode({ node, selected, setSelected, filter, onPreview, onContextMenu, selectionPrefix = '', depth = 0 }) {
  const children = node.children || [];
  const matches = nodeMatchesFilter(node.path, filter);
  const childMatches = children.some(child => child.path.toLowerCase().includes(filter.toLowerCase()));
  const [open, setOpen] = useState(depth < 1 || Boolean(filter));
  useEffect(() => { if (filter && childMatches) setOpen(true); }, [filter, childMatches]);
  if (!matches && !childMatches) return null;
  const paths = flattenFiles([node]).map(path => `${selectionPrefix}${path}`);
  const checked = paths.length > 0 && paths.every(path => selected.has(path));
  const toggle = () => setSelected(previous => toggleSelection(previous, paths, checked));
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
