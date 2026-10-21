/**
 * ファイルプレビューモーダル (PreviewModal.jsx)
 *
 * 仕様:
 * 1. Markdownは整形表示、それ以外はコード表示で、検索バー付きで表示する。
 * 2. Esc で閉じる。
 * 3. ヘッダーにファイルの文字数（万文字・実数）を表示する。
 **/

import { X } from 'lucide-react';
import { countChars, formatMan } from '../lib/charCount';
import { PreviewSearch } from '../PreviewSearch';
import { CodePreview, MarkdownPreview } from '../previewRenderer';

export function PreviewModal({ file, content, close }) {
  if (!file) return null;
  const isMarkdown = /\.md$/i.test(file);
  const chars = countChars(content);
  return <div className="modal-layer" onMouseDown={close}><div className={`modal preview-modal ${isMarkdown ? 'markdown-modal' : 'code-modal'}`} tabIndex="-1" onMouseDown={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
    <header><div><span className="eyebrow">FILE PREVIEW · {isMarkdown ? 'MARKDOWN' : 'CODE'}</span><h3>{file}</h3></div><span className="char-count preview-char-count" title="このファイルの文字数"><strong>{formatMan(chars)}</strong><span>（{chars.toLocaleString()}文字）</span></span><button className="icon-button" onClick={close}><X/></button></header>
    <PreviewSearch>{isMarkdown ? <MarkdownPreview content={content}/> : <CodePreview content={content} path={file}/>}</PreviewSearch>
  </div></div>;
}
