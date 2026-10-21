/**
 * コンテキストの文字数表示と分割パートの切り替え (ContextSummary.jsx)
 *
 * 仕様:
 * 1. 出力全体の文字数を「合計 12.35万文字（123,456 / 上限200,000）」で表示する。上限超過時は警告色にする。
 * 2. 20万文字を超えて複数パートに分割された場合は、分割数とパートごとのタブを表示し、選択中のパートを切り替えられる。
 * 3. 未作成（文字数0）のときは何も表示しない。
 **/

import { CHAR_LIMIT, countChars, formatMan } from '../lib/charCount';

export function ContextSummary({ context, textParts = [], partIndex = 0, setPartIndex }) {
  if (!context) return null;
  const total = countChars(context);
  const split = textParts.length > 1;
  return <div className="context-summary">
    <div className={`char-count ${total > CHAR_LIMIT ? 'over' : ''}`} title={`${total.toLocaleString()}文字（上限 ${CHAR_LIMIT.toLocaleString()}文字）`}>
      <strong>合計 {formatMan(total)}</strong>
      <span>（{total.toLocaleString()} / 上限{CHAR_LIMIT.toLocaleString()}）</span>
      {split && <em>上限を超えるため全{textParts.length}ファイルに分割して出力します</em>}
    </div>
    {split && <div className="mkdocs-view-tabs part-tabs">
      {textParts.map((part, index) => <button key={part.index} className={index === partIndex ? 'active' : ''} onClick={() => setPartIndex(index)}>
        パート{part.index}/{part.total} ({formatMan(part.chars)})
      </button>)}
    </div>}
  </div>;
}
