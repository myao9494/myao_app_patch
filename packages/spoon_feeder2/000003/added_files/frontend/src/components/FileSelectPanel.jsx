/**
 * ファイル選択パネル (FileSelectPanel.jsx)
 *
 * 仕様:
 * 1. ファイルツリー（検索・全選択/解除・キーボード操作・右クリックメニュー）と選択数を表示する。
 * 2. 「ライブラリを自動チェック」(MkDocsモードでは「リンク先MDを自動チェック」)で呼び出し先を自動選択する。
 * 3. コードモードで外部ライブラリが検出されたときは、ツリー下部に参照ライブラリ(読み取り専用)と未解決・警告を表示する。
 **/

import { AlertTriangle, Folder, FolderOpen, GitBranch, LoaderCircle, Search, Sparkles } from 'lucide-react';
import { TreeNode } from './TreeNode';

function ReferenceTreeSection({ referenceData, referenceSelected, setReferenceSelected, referenceFileCount, filter, onPreview, onOpenReferenceEditor }) {
  const { repositories = [], unresolved = [], warnings = [] } = referenceData;
  return <div className="reference-tree-section">
    <div className="reference-tree-title"><span><GitBranch/>参照ライブラリ</span><em>{referenceSelected.size} / {referenceFileCount}</em></div>
    {repositories.map(repo => <section className="reference-repository" key={repo.path}>
      <header><span><Folder/>{repo.name}</span><small title={repo.path}>{repo.reason === 'manual' ? '手動' : repo.reason === 'project-reference' ? 'ProjectReference' : '環境から検出'}</small></header>
      {(repo.tree || []).map(node => <TreeNode key={`${repo.path}:${node.path}`} node={node} selected={referenceSelected} setSelected={setReferenceSelected} filter={filter} onPreview={file => onPreview(file, repo.path)} selectionPrefix={`${repo.path}::`}/>) }
    </section>)}
    {unresolved.length > 0 && <button className="unresolved-reference" onClick={() => onOpenReferenceEditor()}><AlertTriangle/>{unresolved.length}件の参照先を確認</button>}
    {warnings.map(warning => <div className="reference-warning" key={warning}><AlertTriangle/>{warning}</div>)}
  </div>;
}

export function FileSelectPanel({
  tree, allFiles, selected, setSelected, filter, setFilter, treeRef, onTreeKeyDown, onPreview, onContextMenu,
  path, loading, activeMode, autoCheckLoading, onAutoCheck,
  referenceData, referenceSelected, setReferenceSelected, referenceFileCount, onOpenReferenceEditor
}) {
  const hasReferences = activeMode !== 'mkdocs' && referenceData.enabled
    && ((referenceData.repositories || []).length > 0 || (referenceData.unresolved || []).length > 0 || (referenceData.warnings || []).length > 0);
  return <section className="card repository-card">
    <div className="section-heading">
      <div><span className="eyebrow">SELECT</span><h2><Folder/>ファイルを選択</h2></div>
      <div className="section-heading-actions">
        <button
          className="auto-check-button"
          onClick={onAutoCheck}
          disabled={!path || loading || autoCheckLoading || selected.size === 0}
          title={activeMode === 'mkdocs' ? '選択中のMarkdownやmkdocs.ymlからリンクされている同一リポジトリ内のMarkdownに自動でチェックを入れます' : '現在選択されているファイルから呼び出されている同一リポジトリ内のモジュールに自動でチェックを入れます'}
        >
          {autoCheckLoading ? <LoaderCircle className="spin"/> : <Sparkles/>}
          {activeMode === 'mkdocs' ? 'リンク先MDを自動チェック' : 'ライブラリを自動チェック'}
        </button>
        <span className="count-badge">{selected.size} / {allFiles.length}</span>
      </div>
    </div>
    <div className="tree-tools"><div><Search/><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="ファイルを検索"/></div><button onClick={() => setSelected(selected.size === allFiles.length ? new Set() : new Set(allFiles))}>{selected.size === allFiles.length ? '選択解除' : 'すべて選択'}</button></div>
    <div className="tree-scroll" ref={treeRef} tabIndex={0} role="tree" aria-label="ファイル選択ツリー" onKeyDown={onTreeKeyDown}>
      {tree.length ? tree.map(node => <TreeNode key={`${node.path}:${node.ignored}`} node={node} selected={selected} setSelected={setSelected} filter={filter} onPreview={onPreview} onContextMenu={onContextMenu}/>) : <div className="empty-state"><FolderOpen/><p>リポジトリを読み込むと<br/>ファイルが表示されます</p></div>}
      {hasReferences && <ReferenceTreeSection referenceData={referenceData} referenceSelected={referenceSelected} setReferenceSelected={setReferenceSelected} referenceFileCount={referenceFileCount} filter={filter} onPreview={onPreview} onOpenReferenceEditor={onOpenReferenceEditor}/>}
    </div>
    <p className="tree-hint">クリックでプレビュー · 右クリックで無視設定／未解決リポジトリを追加</p>
  </section>;
}
