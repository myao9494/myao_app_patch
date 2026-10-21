/**
 * コードモードのコンテキスト作成パネル (CodeContextPanel.jsx)
 *
 * 仕様:
 * 1. 「コンテキストを作成」で選択ファイル(＋参照ライブラリ)を1つのテキストにし、コピー・保存できる。
 * 2. 「呼び出されているモジュールを含む」で外部ライブラリを含めるか切り替える（既定ON）。
 * 3. 未作成のときはプレースホルダーを表示する。
 * 4. 保存先フォルダはMkDocsモードと共通。「保存」でその保存先へ *_context.txt を書き出し、「フォルダを開く」でFinder / Explorerで開く。
 * 5. 文字数（合計）を表示し、20万文字を超える場合は分割パートをタブで切り替えて表示・コピーできる。保存は全パートを *_context_partNofM.txt で書き出す。
 **/

import { Clipboard, Copy, Download, File, FolderOpen, LoaderCircle } from 'lucide-react';
import { ContextSummary } from './ContextSummary';

export function CodeContextPanel({ context, textParts, partIndex, setPartIndex, shownText, path, loading, selectedCount, includeExternalModules, setIncludeExternalModules, onGenerate, onCopy, onDownload, exportFolder, setExportFolder, onOpenFolder }) {
  return <>
    <p className="section-help">メインの選択ファイルと、実際に参照している外部ソースを1つのテキストにまとめます。</p>
    <div className="mkdocs-export-bar">
      <label className="mkdocs-folder-label">
        <span>保存先:</span>
        <input value={exportFolder} onChange={event => setExportFolder(event.target.value)} placeholder="~/Desktop/AI_Inputs"/>
      </label>
      <button onClick={onOpenFolder} title="保存先フォルダをFinder / Explorerで開く"><FolderOpen size={15}/>フォルダを開く</button>
    </div>
    <ContextSummary context={context} textParts={textParts} partIndex={partIndex} setPartIndex={setPartIndex}/>
    <div className="context-output">{context ? <textarea readOnly value={shownText ?? context}/> : <div className="context-placeholder"><File/><strong>repository_context.txt</strong><span>チャットへ添付できる形式で生成します</span></div>}</div>
    <div className="context-actions">{context ? <><button onClick={onCopy}><Copy/>{(textParts?.length || 0) > 1 ? 'このパートをコピー' : 'コピー'}</button><button onClick={onDownload}><Download/>{(textParts?.length || 0) > 1 ? `全${textParts.length}ファイルを保存` : '保存'}</button></> : <span/>}<label className="include-module-toggle" title="リポジトリ外の呼び出されているモジュール（PYTHONPATH等）をコンテキストに含めます"><input type="checkbox" checked={includeExternalModules} onChange={event => setIncludeExternalModules(event.target.checked)}/><span>呼び出されているモジュールを含む</span></label><button className="primary large" onClick={onGenerate} disabled={!path || loading || selectedCount === 0}>{loading ? <LoaderCircle className="spin"/> : <Clipboard/>}コンテキストを作成</button></div>
  </>;
}
