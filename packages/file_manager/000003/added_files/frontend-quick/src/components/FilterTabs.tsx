/**
 * フィルタタブコンポーネント
 * - すべて / 文書・メモ (.md, .txt) / 図面・画像 (.excalidraw, .svg, .drawio) の切替
 */
import React from 'react';
import { FilterCategory } from '../types';
import { FileText, Image as ImageIcon, Layers } from 'lucide-react';

interface FilterTabsProps {
  currentFilter: FilterCategory;
  onSelectFilter: (category: FilterCategory) => void;
  counts: { all: number; doc: number; diagram: number };
}

export const FilterTabs: React.FC<FilterTabsProps> = ({
  currentFilter,
  onSelectFilter,
  counts,
}) => {
  return (
    <div className="quick-filter-tabs">
      <button
        className={`quick-filter-tab ${currentFilter === 'all' ? 'active' : ''}`}
        onClick={() => onSelectFilter('all')}
      >
        <Layers size={14} />
        <span>すべて</span>
        <span className="quick-tab-badge">{counts.all}</span>
      </button>

      <button
        className={`quick-filter-tab ${currentFilter === 'doc' ? 'active' : ''}`}
        onClick={() => onSelectFilter('doc')}
      >
        <FileText size={14} />
        <span>文書・メモ</span>
        <span className="quick-tab-badge">{counts.doc}</span>
      </button>

      <button
        className={`quick-filter-tab ${currentFilter === 'diagram' ? 'active' : ''}`}
        onClick={() => onSelectFilter('diagram')}
      >
        <ImageIcon size={14} />
        <span>図面・画像</span>
        <span className="quick-tab-badge">{counts.diagram}</span>
      </button>
    </div>
  );
};
