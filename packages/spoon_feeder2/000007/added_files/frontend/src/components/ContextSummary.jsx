/**
 * コンテキストの文字数表示と分割パートの切り替え (ContextSummary.jsx)
 *
 * 仕様:
 * 1. 出力全体の文字数を「合計 12.35万文字（123,456 / 上限5,000,000）」で表示する。上限は設定の「分割する最大文字数」(limit)。超過時は警告色にする。
 * 2. 上限を超えて複数パートに分割された場合は、分割数とパートごとのタブを表示し、選択中のパートを切り替えられる。
 * 3. 未作成（文字数0）のときは何も表示しない。
 **/

import { countChars, formatMan } from '../lib/charCount';
import { DEFAULT_TEXT_MAX_CHARS } from '../lib/textLimit';

export function ContextSummary({ context, textParts = [], partIndex = 0, setPartIndex, limit = DEFAULT_TEXT_MAX_CHARS }) {
  if (!context) return null;
  const total = countChars(context);
  const split = textParts.length > 1;
  return <div className="context-summary">
    <div className={`char-count ${total > limit ? 'over' : ''}`} title={`${total.toLocaleString()}文字（上限 ${limit.toLocaleString()}文字）`}>
      <strong>合計 {formatMan(total)}</strong>
      <span>（{total.toLocaleString()} / 上限{limit.toLocaleString()}）</span>
      {split && <em>上限を超えるため全{textParts.length}ファイルに分割して出力します</em>}
    </div>
    {split && <div className="mkdocs-view-tabs part-tabs">
      {textParts.map((part, index) => <button key={part.index} className={index === partIndex ? 'active' : ''} onClick={() => setPartIndex(index)}>
        パート{part.index}/{part.total} ({formatMan(part.chars)})
      </button>)}
    </div>}
  </div>;
}
