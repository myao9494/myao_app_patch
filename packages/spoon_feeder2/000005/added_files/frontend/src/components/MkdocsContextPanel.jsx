/**
 * MkDocsモードのコンテキスト作成パネル (MkdocsContextPanel.jsx)
 *
 * 仕様:
 * 1. 保存先フォルダの指定・Finder/Explorerで開く操作を提供する。
 * 2. 「プレビュー生成」で統合マークダウンと結合画像を表示し、タブで切り替える。
 * 3. 「2ファイルを保存」でMD＋結合画像を保存先へ書き出す。MD/画像を個別にコピー・保存できる。
 * 4. 文字数（合計）を表示する。20万文字超のMDは分割パートをタブで切り替え、結合画像は容量超過時に複数枚へ分割して縦に並べて表示する。
 **/

import { BookOpen, Clipboard, Copy, Download, File, FolderOpen, Image as ImageIcon, LoaderCircle, Save } from 'lucide-react';
import { ContextSummary } from './ContextSummary';

const formatMegabytes = bytes => `${(bytes / 1000000).toFixed(2)}MB`;

export function MkdocsContextPanel({ context, textParts, partIndex, setPartIndex, shownText, path, loading, selectedCount, mkdocs, onGenerate, onCopy, onDownload }) {
  const { exportFolder, setExportFolder, imageParts = [], stats, viewTab, setViewTab, saving } = mkdocs;
  const busy = !path || loading || saving || selectedCount === 0;
  return <>
    <p className="section-help">呼び出されている全画像をリンク記法付きの1枚の画像に縦結合し、統合マークダウンと2ファイルに分けて出力します（5ファイル添付制限対応）。</p>
    <div className="mkdocs-export-bar">
      <label className="mkdocs-folder-label">
        <span>保存先:</span>
        <input value={exportFolder} onChange={event => setExportFolder(event.target.value)} placeholder="~/Desktop/AI_Inputs"/>
      </label>
      <button onClick={mkdocs.onOpenFolder} title="保存先フォルダをFinder / Explorerで開く"><FolderOpen size={15}/>フォルダを開く</button>
    </div>
    <ContextSummary context={context} textParts={textParts} partIndex={partIndex} setPartIndex={setPartIndex}/>
    {context && (
      <div className="mkdocs-view-tabs">
        <button className={viewTab === 'markdown' ? 'active' : ''} onClick={() => setViewTab('markdown')}>
          <File size={14}/>統合マークダウン ({stats?.total_documents || 0}件)
        </button>
        <button className={viewTab === 'image' ? 'active' : ''} onClick={() => setViewTab('image')}>
          <ImageIcon size={14}/>結合画像プレビュー ({stats?.total_images || 0}枚連結{imageParts.length > 1 ? `・${imageParts.length}ファイルに分割` : ''})
        </button>
      </div>
    )}
    <div className="context-output">
      {context ? (
        viewTab === 'image' ? (
          imageParts.length > 0 ? (
            <div className="mkdocs-image-preview-wrap">
              <div className="mkdocs-image-meta-list">
                {(stats?.images_meta || []).map(item => (
                  <span key={item.index} className="mkdocs-image-chip">
                    【図{item.index}】 {item.doc_path} → <code>{item.link_text}</code>
                  </span>
                ))}
              </div>
              {imageParts.map(part => <figure key={part.index} className="mkdocs-image-part">
                {imageParts.length > 1 && <figcaption>結合画像 {part.index}/{part.total}（【図{part.figures[0]}】〜【図{part.figures[1]}】・{formatMegabytes(part.size)}）</figcaption>}
                <img src={part.data_url} alt={`結合画像プレビュー ${part.index}`} className="mkdocs-combined-image" />
              </figure>)}
            </div>
          ) : (
            <div className="context-placeholder"><ImageIcon/><strong>呼び出されている画像はありません</strong><span>選択中のMarkdownに画像リンクが含まれていないため、マークダウンのみ出力されます</span></div>
          )
        ) : (
          <textarea readOnly value={shownText ?? context}/>
        )
      ) : (
        <div className="context-placeholder"><BookOpen/><strong>*_context.md ＋ *_images.png</strong><span>MkDocsのMarkdownと呼び出し画像を2ファイルに分けて生成します</span></div>
      )}
    </div>
    <div className="context-actions mkdocs-actions">
      {context ? (
        <div className="mkdocs-sub-actions">
          <button onClick={onCopy}><Copy/>{(textParts?.length || 0) > 1 ? 'このパートをコピー' : 'MDをコピー'}</button>
          <button onClick={onDownload}><Download/>{(textParts?.length || 0) > 1 ? `MD保存(全${textParts.length}ファイル)` : 'MD保存'}</button>
          {imageParts.length > 0 && <button onClick={mkdocs.downloadImage}><ImageIcon/>{imageParts.length > 1 ? `結合画像保存(全${imageParts.length}枚)` : '結合画像保存'}</button>}
        </div>
      ) : <span/>}
      <div className="mkdocs-main-actions">
        <button onClick={onGenerate} disabled={busy}>
          {loading ? <LoaderCircle className="spin"/> : <Clipboard/>}プレビュー生成
        </button>
        <button className="primary large" onClick={mkdocs.onSave} disabled={busy}>
          {saving ? <LoaderCircle className="spin"/> : <Save/>}2ファイルを保存 (MD＋画像)
        </button>
      </div>
    </div>
  </>;
}
