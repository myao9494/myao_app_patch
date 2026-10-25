/**
 * @vitest-environment jsdom
 * 表示期間の日数入力欄（DayRangeInput）と、ツールバーのフォーカス移動のテスト
 **/
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DayRangeInput } from './DayRangeInput';
import { OptionButtonGroup } from './OptionButtonGroup';

afterEach(cleanup);

function Harness({ editable = true, onCommit = vi.fn(), onActivate = vi.fn(), initial = '0' }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="toolbar">
      <button>前のボタン</button>
      <DayRangeInput
        side="start"
        value={value}
        onValueChange={setValue}
        onCommit={onCommit}
        editable={editable}
        onActivate={onActivate}
      />
      <span>~</span>
      <DayRangeInput
        side="end"
        value="5"
        onValueChange={() => {}}
        onCommit={() => {}}
        editable={editable}
        onActivate={() => {}}
      />
      <div className="btn-group"><button>次のボタン</button></div>
    </div>
  );
}

const startInput = () => screen.getAllByRole('textbox')[0] as HTMLInputElement;
const endInput = () => screen.getAllByRole('textbox')[1] as HTMLInputElement;

describe('DayRangeInput', () => {
  it('全角で入力した数字は半角にそろえ、数字以外は受け付けないこと', () => {
    render(<Harness />);

    fireEvent.change(startInput(), { target: { value: '－１２' } });
    expect(startInput().value).toBe('-12');

    fireEvent.change(startInput(), { target: { value: 'abc' } });
    expect(startInput().value).toBe('-12');
  });

  it('Enter で範囲内の値に確定して反映すること', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} initial="5000" />);

    fireEvent.keyDown(startInput(), { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith(1000);
    expect(startInput().value).toBe('1000');
  });

  it('フォーカスを外したときも確定すること（空欄は 0）', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} initial="" />);

    fireEvent.blur(startInput());

    expect(onCommit).toHaveBeenCalledWith(0);
    expect(startInput().value).toBe('0');
  });

  it('期間限定でないときは読み取り専用で、触ると切り替えを要求すること', () => {
    const onActivate = vi.fn();
    render(<Harness editable={false} onActivate={onActivate} />);

    expect(startInput().readOnly).toBe(true);
    fireEvent.mouseDown(startInput());

    expect(onActivate).toHaveBeenCalledWith('start');
  });

  it('開始側は、右端で右キーを押すと終了側へ、先頭で左キーを押すと前のボタンへ移ること', () => {
    render(<Harness initial="5" />);

    startInput().focus();
    startInput().setSelectionRange(1, 1);
    fireEvent.keyDown(startInput(), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(endInput());

    startInput().focus();
    startInput().setSelectionRange(0, 0);
    fireEvent.keyDown(startInput(), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByText('前のボタン'));
  });

  it('終了側は、先頭で左キーを押すと開始側へ、右端で右キーを押すと次のボタン群へ移ること', () => {
    render(<Harness />);

    endInput().focus();
    endInput().setSelectionRange(0, 0);
    fireEvent.keyDown(endInput(), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(startInput());

    endInput().focus();
    endInput().setSelectionRange(1, 1);
    fireEvent.keyDown(endInput(), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByText('次のボタン'));
  });
});

describe('OptionButtonGroup', () => {
  it('選択中のボタンだけを active にし、押した値を通知すること', () => {
    const onSelect = vi.fn();
    render(
      <OptionButtonGroup
        options={[{ value: false, label: '未完了' }, { value: true, label: '全て' }]}
        value={true}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByText('全て').className).toContain('active');
    expect(screen.getByText('未完了').className).not.toContain('active');

    fireEvent.click(screen.getByText('未完了'));
    expect(onSelect).toHaveBeenCalledWith(false);
  });
});
