/**
 * ツールバーの「選択肢のボタン群」（表示期間・完了・種別・タイムスケールなど）。
 * 選択中のボタンは active になり、左右キーで隣へフォーカスを移せる。
 */
import { handleButtonArrowKeys } from './toolbarNavigation';

interface Option<T> {
  value: T;
  label: string;
}

interface OptionButtonGroupProps<T> {
  options: ReadonlyArray<Option<T>>;
  value: T;
  onSelect: (value: T) => void;
}

export function OptionButtonGroup<T extends string | boolean>({
  options,
  value,
  onSelect,
}: OptionButtonGroupProps<T>) {
  return (
    <div className="btn-group">
      {options.map((option) => (
        <button
          key={String(option.value)}
          className={`btn ${option.value === value ? 'active' : ''}`}
          onClick={() => onSelect(option.value)}
          onKeyDown={handleButtonArrowKeys}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
