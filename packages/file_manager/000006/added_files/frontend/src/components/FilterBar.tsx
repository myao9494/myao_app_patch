/**
 * フィルタバーコンポーネント
 * ファイル種別でフィルタリング
 */
import { EXT_FILTERS, TYPE_FILTERS } from "./filterOptions";
import "./FilterBar.css";

interface FilterBarProps {
  typeFilter: string;
  extFilter: string;
  onTypeChange: (type: string) => void;
  onExtChange: (ext: string) => void;
  isFocused?: boolean;
}

export function FilterBar({ typeFilter, extFilter, onTypeChange, onExtChange, isFocused = false }: FilterBarProps) {
  return (
    <div className={`filter-bar ${isFocused ? 'section-focused' : ''}`}>
      <div className="filter-group">
        {TYPE_FILTERS.map((f) => (
          <button
            key={f.id}
            className={`filter-btn ${typeFilter === f.id ? "active" : ""}`}
            onClick={() => onTypeChange(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="filter-divider" />
      <div className="filter-group">
        {EXT_FILTERS.map((f) => (
          <button
            key={f.id}
            className={`filter-btn ${extFilter === f.id ? "active" : ""}`}
            onClick={() => onExtChange(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}
