/**
 * 無視リスト編集のUndo/Redo履歴のテスト (ignoreHistory.test.js)
 **/

import { describe, expect, it } from 'vitest';
import { TextHistory } from './ignoreHistory';

describe('TextHistory', () => {
  it('編集を積み、undo / redo で前後のテキストへ移動する', () => {
    const history = new TextHistory('a');
    history.push('ab');
    history.push('abc');
    expect(history.undo()).toBe('ab');
    expect(history.undo()).toBe('a');
    expect(history.undo()).toBe('a');
    expect(history.redo()).toBe('ab');
    expect(history.redo()).toBe('abc');
    expect(history.redo()).toBe('abc');
  });

  it('undo後に新しく編集するとredo側の履歴を破棄する', () => {
    const history = new TextHistory('a');
    history.push('b');
    history.undo();
    history.push('c');
    expect(history.redo()).toBe('c');
    expect(history.undo()).toBe('a');
  });

  it('直前と同じテキストは履歴に積まない', () => {
    const history = new TextHistory('a');
    history.push('a');
    history.push('b');
    history.push('b');
    expect(history.items).toEqual(['a', 'b']);
  });
});
