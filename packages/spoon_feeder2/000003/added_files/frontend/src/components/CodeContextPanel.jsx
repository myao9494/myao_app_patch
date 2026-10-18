/**
 * コードモードのコンテキスト作成パネル (CodeContextPanel.jsx)
 *
 * 仕様:
 * 1. 「コンテキストを作成」で選択ファイル(＋参照ライブラリ)を1つのテキストにし、コピー・保存できる。
 * 2. 「呼び出されているモジュールを含む」で外部ライブラリを含めるか切り替える（既定ON）。
 * 3. 未作成のときはプレースホルダーを表示する。
 **/

import { Clipboard, Copy, Download, File, LoaderCircle } from 'lucide-react';

export function CodeContextPanel({ context, path, loading, selectedCount, includeExternalModules, setIncludeExternalModules, onGenerate, onCopy, onDownload }) {
  return <>
    <p className="section-help">メインの選択ファイルと、実際に参照している外部ソースを1つのテキストにまとめます。</p>
    <div className="context-output">{context ? <textarea readOnly value={context}/> : <div className="context-placeholder"><File/><strong>repository_context.txt</strong><span>チャットへ添付できる形式で生成します</span></div>}</div>
    <div className="context-actions">{context ? <><button onClick={onCopy}><Copy/>コピー</button><button onClick={onDownload}><Download/>保存</button></> : <span/>}<label className="include-module-toggle" title="リポジトリ外の呼び出されているモジュール（PYTHONPATH等）をコンテキストに含めます"><input type="checkbox" checked={includeExternalModules} onChange={event => setIncludeExternalModules(event.target.checked)}/><span>呼び出されているモジュールを含む</span></label><button className="primary large" onClick={onGenerate} disabled={!path || loading || selectedCount === 0}>{loading ? <LoaderCircle className="spin"/> : <Clipboard/>}コンテキストを作成</button></div>
  </>;
}
