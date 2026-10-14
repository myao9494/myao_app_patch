/**
 * ペイン内のファイル名検索バー（Ctrl/Cmd+F または / でフォーカス）
 * - Enter で次のヒット、Shift+Enter で前のヒットへ（親の onEnter が処理）
 * - Escape で検索語を消して一覧へ戻る、↓ で一覧へ、↑ で履歴検索欄へ
 * - 件数バッジ（検索中は「現在位置 / ヒット数」、未検索時は「表示件数 / 全件数」）と正規表現トグル
 */
import type { RefObject } from "react";
import { Search, X } from "lucide-react";

interface FileListSearchBarProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  isRegex: boolean;
  onToggleRegex: () => void;
  badgeText: string;
  onEscape: () => void;
  onFocusList: () => void;
  onFocusHistorySearch: () => void;
  onEnter: (backwards: boolean) => void;
}

export function FileListSearchBar({
  inputRef,
  query,
  onQueryChange,
  isRegex,
  onToggleRegex,
  badgeText,
  onEscape,
  onFocusList,
  onFocusHistorySearch,
  onEnter,
}: FileListSearchBarProps) {
  return (
    <div className="search-bar">
      <Search size={14} className="search-icon" />
      <input
        ref={inputRef}
        type="text"
        placeholder={isRegex ? "正規表現で検索... (Ctrl+F / /)" : "検索... (Ctrl+F / /)"}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onEscape();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            onFocusList();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            onFocusHistorySearch();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            onEnter(e.shiftKey);
          }
        }}
      />
      {query && (
        <button
          className="search-clear-btn"
          onClick={() => {
            onQueryChange("");
            inputRef.current?.focus();
          }}
          title="検索をクリア (Esc)"
        >
          <X size={12} />
        </button>
      )}
      <span
        className="search-count-badge"
        title={query.trim() ? "現在ヒット位置 / 総ヒット件数 (Enter: 次へ / Shift+Enter: 前へ)" : "マッチ件数 / 全件数"}
      >
        {badgeText}
      </span>
      <button
        className={`regex-toggle ${isRegex ? "active" : ""}`}
        onClick={onToggleRegex}
        title="正規表現 (Regex)"
      >
        .*
      </button>
    </div>
  );
}
