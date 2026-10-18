/**
 * リポジトリ選択バー (PathBar.jsx)
 *
 * 仕様:
 * 1. RepositorySelector（履歴選択・検索・削除）、コード/MkDocsモード切替、Git差分コピー、VS Code起動を並べる。
 * 2. Git差分コピーのツールチップには実際に実行されるコマンド（空欄時は既定）を表示する。
 **/

import { BookOpen, Code2, GitBranch, GitCompare, LoaderCircle, MonitorCog } from 'lucide-react';
import { resolveGitDiffCommand } from '../gitDiff';
import { RepositorySelector } from './RepositorySelector';

export function PathBar({
  path, setPath, repositories, setRepositories, onLoad, loading, showIgnored, notify,
  activeMode, isMkdocsRepo, mkdocsConfig, onToggleMode,
  gitDiffCommand, loadingDiff, onCopyGitDiff, onOpenCode
}) {
  return <section className="path-bar card">
    <div className="path-label"><GitBranch/><span>REPOSITORY</span></div>
    <RepositorySelector
      path={path}
      setPath={setPath}
      repositories={repositories}
      setRepositories={setRepositories}
      onLoad={onLoad}
      loading={loading}
      showIgnored={showIgnored}
      notify={notify}
    />
    {path && <button
      className={`mode-switch-button ${activeMode === 'mkdocs' ? 'mkdocs-active' : 'code-active'}`}
      onClick={onToggleMode}
      title={isMkdocsRepo ? `YAML検出: ${mkdocsConfig.config_file || 'mkdocs.yml'} (${mkdocsConfig.site_name || ''}) — クリックでモード切替` : 'クリックで通常コードモード / MkDocsモードを切り替え'}
    >
      {activeMode === 'mkdocs' ? <><BookOpen size={16}/>MkDocsモード</> : <><Code2 size={16}/>コードモード</>}
    </button>}
    <button
      onClick={onCopyGitDiff}
      disabled={!path || loadingDiff}
      title={`Git差分をクリップボードにコピー (${resolveGitDiffCommand(gitDiffCommand)})`}
    >
      {loadingDiff ? <LoaderCircle className="spin"/> : <GitCompare/>}Git差分コピー
    </button>
    <button onClick={onOpenCode} disabled={!path}><MonitorCog/>VS Code</button>
  </section>;
}
