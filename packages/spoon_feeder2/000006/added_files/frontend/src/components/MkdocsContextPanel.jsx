/**
 * MkDocsモードのコンテキスト作成パネル (MkdocsContextPanel.jsx)
 *
 * 仕様:
 * 1. 保存先フォルダの指定・Finder/Explorerで開く操作を提供する。
 * 2. 「プレビュー生成」で統合マークダウンと図PDFを表示し、タブで切り替える。
 * 3. 「2ファイルを保存」でMD＋図PDFを保存先へ書き出す。MD/図PDFを個別にコピー・保存できる。
 * 4. 図PDFの上限サイズ(MB。既定10MB)を指定できる。上限を超えると図の境界で複数のPDFに分割し、縦に並べてプレビューする。
 * 5. 文字数（合計）を表示する。20万文字超のMDは分割パートをタブで切り替える。
 **/

import { useEffect, useState } from 'react';
import { BookOpen, Clipboard, Copy, Download, File, FileText, FolderOpen, LoaderCircle, Save } from 'lucide-react';
import { dataUrlToBlob } from '../lib/download';
import { MAX_PDF_MAX_MB, MIN_PDF_MAX_MB } from '../lib/pdfLimit';
import { ContextSummary } from './ContextSummary';

const formatMegabytes = bytes => `${(bytes / 1000000).toFixed(2)}MB`;

// 大きなData URLをそのままiframeへ渡さず、Blob URLにして表示する（描画できない環境では空のまま）。
function PdfFrame({ part }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const blobUrl = URL.createObjectURL(dataUrlToBlob(part.data_url));
    setUrl(blobUrl);
    return () => URL.revokeObjectURL(blobUrl);
  }, [part.data_url]);
  return <iframe className="mkdocs-pdf-frame" title={`図PDFプレビュー ${part.index}`} src={url || undefined}/>;
}

export function MkdocsContextPanel({ context, textParts, partIndex, setPartIndex, shownText, path, loading, selectedCount, mkdocs, onGenerate, onCopy, onDownload }) {
  const { exportFolder, setExportFolder, pdfParts = [], pdfMaxMbText, setPdfMaxMbText, stats, viewTab, setViewTab, saving } = mkdocs;
  const busy = !path || loading || saving || selectedCount === 0;
  return <>
    <p className="section-help">呼び出されている全画像をリンク記法付きの図PDF（1図1ページ・無劣化）にまとめ、統合マークダウンと2ファイルに分けて出力します（5ファイル添付制限・自動圧縮対応）。</p>
    <div className="mkdocs-export-bar">
      <label className="mkdocs-folder-label">
        <span>保存先:</span>
        <input value={exportFolder} onChange={event => setExportFolder(event.target.value)} placeholder="~/Desktop/AI_Inputs"/>
      </label>
      <label className="mkdocs-folder-label mkdocs-pdf-limit" title="図PDFがこのサイズを超えると、図の境界で複数のPDFに分割します">
        <span>PDF上限(MB):</span>
        <input type="number" min={MIN_PDF_MAX_MB} max={MAX_PDF_MAX_MB} step="0.5" value={pdfMaxMbText} onChange={event => setPdfMaxMbText(event.target.value)}/>
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
          <FileText size={14}/>図PDFプレビュー ({stats?.total_images || 0}枚{pdfParts.length > 1 ? `・${pdfParts.length}ファイルに分割` : ''})
        </button>
      </div>
    )}
    <div className="context-output">
      {context ? (
        viewTab === 'image' ? (
          pdfParts.length > 0 ? (
            <div className="mkdocs-image-preview-wrap">
              <div className="mkdocs-image-meta-list">
                {(stats?.images_meta || []).map(item => (
                  <span key={item.index} className="mkdocs-image-chip">
                    【図{item.index}】 {item.doc_path} → <code>{item.link_text}</code>
                  </span>
                ))}
              </div>
              {pdfParts.map(part => <figure key={part.index} className="mkdocs-image-part">
                <figcaption>図PDF {part.index}/{part.total}（【図{part.figures[0]}】〜【図{part.figures[1]}】・{formatMegabytes(part.size)}）</figcaption>
                <PdfFrame part={part}/>
              </figure>)}
            </div>
          ) : (
            <div className="context-placeholder"><FileText/><strong>呼び出されている画像はありません</strong><span>選択中のMarkdownに画像リンクが含まれていないため、マークダウンのみ出力されます</span></div>
          )
        ) : (
          <textarea readOnly value={shownText ?? context}/>
        )
      ) : (
        <div className="context-placeholder"><BookOpen/><strong>*_context.md ＋ *_images.pdf</strong><span>MkDocsのMarkdownと呼び出し画像（図PDF）を2ファイルに分けて生成します</span></div>
      )}
    </div>
    <div className="context-actions mkdocs-actions">
      {context ? (
        <div className="mkdocs-sub-actions">
          <button onClick={onCopy}><Copy/>{(textParts?.length || 0) > 1 ? 'このパートをコピー' : 'MDをコピー'}</button>
          <button onClick={onDownload}><Download/>{(textParts?.length || 0) > 1 ? `MD保存(全${textParts.length}ファイル)` : 'MD保存'}</button>
          {pdfParts.length > 0 && <button onClick={mkdocs.downloadPdf}><FileText/>{pdfParts.length > 1 ? `図PDF保存(全${pdfParts.length}ファイル)` : '図PDF保存'}</button>}
        </div>
      ) : <span/>}
      <div className="mkdocs-main-actions">
        <button onClick={onGenerate} disabled={busy}>
          {loading ? <LoaderCircle className="spin"/> : <Clipboard/>}プレビュー生成
        </button>
        <button className="primary large" onClick={mkdocs.onSave} disabled={busy}>
          {saving ? <LoaderCircle className="spin"/> : <Save/>}2ファイルを保存 (MD＋図PDF)
        </button>
      </div>
    </div>
  </>;
}
