/**
 * ファイルプレビューモーダル (PreviewModal.jsx)
 *
 * 仕様:
 * 1. Markdownは整形表示、それ以外はコード表示で、検索バー付きで表示する。
 * 2. Esc で閉じる。
 **/

import { X } from 'lucide-react';
import { PreviewSearch } from '../PreviewSearch';
import { CodePreview, MarkdownPreview } from '../previewRenderer';

export function PreviewModal({ file, content, close }) {
  if (!file) return null;
  const isMarkdown = /\.md$/i.test(file);
  return <div className="modal-layer" onMouseDown={close}><div className={`modal preview-modal ${isMarkdown ? 'markdown-modal' : 'code-modal'}`} tabIndex="-1" onMouseDown={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
    <header><div><span className="eyebrow">FILE PREVIEW · {isMarkdown ? 'MARKDOWN' : 'CODE'}</span><h3>{file}</h3></div><button className="icon-button" onClick={close}><X/></button></header>
    <PreviewSearch>{isMarkdown ? <MarkdownPreview content={content}/> : <CodePreview content={content} path={file}/>}</PreviewSearch>
  </div></div>;
}
