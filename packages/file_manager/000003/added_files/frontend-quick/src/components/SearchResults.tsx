/**
 * 検索結果リストコンポーネント
 * - モバイル向けカード形式の表示
 * - スニペット（本文マッチ箇所）のプレビュー表示
 * - ファイル種別ごとのアイコン分岐
 */
import React from 'react';
import { SearchResultItem } from '../types';
import { FileText, Folder, Image, FileCode, ChevronRight } from 'lucide-react';

interface SearchResultsProps {
  results: SearchResultItem[];
  onSelectFile: (item: SearchResultItem) => void;
  query: string;
  isLoading: boolean;
}

export const SearchResults: React.FC<SearchResultsProps> = ({
  results,
  onSelectFile,
  query,
  isLoading,
}) => {
  if (isLoading && results.length === 0) {
    return (
      <div className="quick-empty-state">
        <p>検索中...</p>
      </div>
    );
  }

  if (!query && results.length === 0) {
    return (
      <div className="quick-empty-state">
        <p className="quick-empty-hint">キーワードを入力して端末内のファイルを検索</p>
        <span className="quick-empty-sub">例: 「学校」「連絡先」「090」「議事録」</span>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="quick-empty-state">
        <p>該当するファイルが見つかりませんでした</p>
      </div>
    );
  }

  const getFileIcon = (item: SearchResultItem) => {
    if (item.is_directory) return <Folder size={18} className="icon-folder" />;
    const ext = item.name.split('.').pop()?.toLowerCase() || '';
    if (['md', 'txt'].includes(ext)) return <FileText size={18} className="icon-doc" />;
    if (['svg', 'png', 'jpg', 'jpeg', 'excalidraw'].includes(ext) || item.name.includes('.drawio')) {
      return <Image size={18} className="icon-image" />;
    }
    return <FileCode size={18} className="icon-code" />;
  };

  const formatPath = (path: string) => {
    // パスを省略して最後の2階層程度を表示
    const parts = path.split('/');
    if (parts.length > 3) {
      return '.../' + parts.slice(-3, -1).join('/');
    }
    return parts.slice(0, -1).join('/');
  };

  const renderSnippetWithMark = (snippet: string) => {
    const parts = snippet.split(/(<mark>.*?<\/mark>)/g);
    return parts.map((part, index) => {
      if (part.startsWith('<mark>') && part.endsWith('</mark>')) {
        const text = part.slice(6, -7);
        return (
          <mark key={index} className="quick-snippet-mark">
            {text}
          </mark>
        );
      }
      return part;
    });
  };

  return (
    <div className="quick-results-list">
      {results.map((item, idx) => (
        <div
          key={`${item.path}-${idx}`}
          className="quick-result-card"
          onClick={() => onSelectFile(item)}
          role="button"
          tabIndex={0}
        >
          <div className="quick-card-main">
            <div className="quick-card-icon">{getFileIcon(item)}</div>
            <div className="quick-card-info">
              <div className="quick-card-title">{item.name}</div>
              <div className="quick-card-path">{formatPath(item.path)}</div>
            </div>
            <ChevronRight size={18} className="quick-card-arrow" />
          </div>

          {item.snippet && (
            <div className="quick-card-snippet">
              <span className="snippet-text">
                {renderSnippetWithMark(item.snippet)}
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
