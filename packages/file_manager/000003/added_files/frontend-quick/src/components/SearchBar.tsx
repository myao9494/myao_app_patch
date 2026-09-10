/**
 * スマホ最適化検索バーコンポーネント
 * - 大きなタッチターゲットと即時クリアボタン
 * - 日本語IME入力対応
 * - リアルタイム検索とスピナー表示
 */
import React, { useRef } from 'react';
import { Search, X, Loader2 } from 'lucide-react';

interface SearchBarProps {
  query: string;
  onChange: (value: string) => void;
  onClear: () => void;
  isLoading: boolean;
}

export const SearchBar: React.FC<SearchBarProps> = ({
  query,
  onChange,
  onClear,
  isLoading,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClear = () => {
    onClear();
    if (inputRef.current) {
      inputRef.current.focus();
    }
  };

  return (
    <div className="quick-searchbar-container">
      <div className="quick-searchbar-wrapper">
        <Search className="quick-searchbar-icon" size={20} />
        <input
          ref={inputRef}
          type="search"
          className="quick-searchbar-input"
          placeholder="連絡先、メモ、ファイルを検索..."
          value={query}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck="false"
        />
        {isLoading ? (
          <Loader2 className="quick-searchbar-spinner animate-spin" size={18} />
        ) : query ? (
          <button
            type="button"
            className="quick-searchbar-clear"
            onClick={handleClear}
            aria-label="検索キーワードをクリア"
          >
            <X size={16} />
          </button>
        ) : null}
      </div>
    </div>
  );
};
