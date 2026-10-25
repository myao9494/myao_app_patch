/**
 * 表示期間（期間限定モード）の日数入力欄。開始側と終了側で同じ挙動を共有する。
 *
 * - 期間限定モードでないときは読み取り専用で、触れるとモードを切り替えてから入力できるようにする。
 * - 入力中は全角数字なども受け付け、Enter かフォーカスを外したときに -1000〜1000 の値として確定する。
 */
import { forwardRef } from 'react';
import { finalizeNumberInput, isValidNumberInput, normalizeNumberInput } from '../../utils/numberInput';
import { focusSiblingMatching, pickButton, pickInput } from './toolbarNavigation';

export type DayRangeSide = 'start' | 'end';

interface DayRangeInputProps {
  side: DayRangeSide;
  value: string;
  onValueChange: (value: string) => void;
  /** 確定した日数をフィルターへ反映する */
  onCommit: (days: number) => void;
  /** 期間限定モードのときだけ編集できる */
  editable: boolean;
  /** 期間限定モードへ切り替えて、この欄を編集状態にする */
  onActivate: (side: DayRangeSide) => void;
}

export const DayRangeInput = forwardRef<HTMLInputElement, DayRangeInputProps>(function DayRangeInput(
  { side, value, onValueChange, onCommit, editable, onActivate },
  ref,
) {
  const commit = () => {
    const finalized = finalizeNumberInput(value);
    if (finalized !== value) onValueChange(finalized);
    onCommit(Number(finalized));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation(); // DHTMLX干渉防止
    const input = event.currentTarget;

    if (event.key === 'Enter') {
      commit();
      input.select(); // 再選択して連続入力を容易に
      return;
    }

    // 開始側: 右は終了側の入力欄へ、左は表示期間のボタンへ。終了側: 左は開始側の入力欄へ、右は次のボタン群へ。
    const atEnd = input.selectionStart === input.value.length;
    const atStart = input.selectionStart === 0;
    if (event.key === 'ArrowRight' && atEnd) {
      event.preventDefault();
      focusSiblingMatching(input, 'next', side === 'start' ? pickInput : pickButton);
    } else if (event.key === 'ArrowLeft' && atStart) {
      event.preventDefault();
      focusSiblingMatching(input, 'prev', side === 'start' ? pickButton : pickInput);
    }
  };

  return (
    <input
      ref={ref}
      type="text"
      className="number-input wide"
      readOnly={!editable}
      aria-disabled={!editable}
      value={value}
      onMouseDown={(event) => {
        if (!editable) {
          event.preventDefault();
          onActivate(side);
        }
      }}
      onFocus={() => onActivate(side)}
      onChange={(event) => {
        if (isValidNumberInput(event.target.value)) {
          onValueChange(normalizeNumberInput(event.target.value));
        }
      }}
      onKeyDown={handleKeyDown}
      onBlur={commit}
    />
  );
});
