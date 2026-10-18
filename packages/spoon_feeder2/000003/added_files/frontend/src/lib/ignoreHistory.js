/**
 * 無視リスト編集用のUndo/Redo履歴 (ignoreHistory.js)
 *
 * 仕様:
 * 1. 編集テキストを履歴として積み、undo / redo で前後のテキストを返す（端では現在値のまま）。
 * 2. undo後に新しい編集をすると、redo側の履歴は破棄する。
 * 3. 直前と同じテキストは履歴に積まない。
 **/

export class TextHistory {
  constructor(initial = '') {
    this.items = [initial];
    this.index = 0;
  }

  get current() { return this.items[this.index]; }

  push(text) {
    const items = this.items.slice(0, this.index + 1);
    if (items[items.length - 1] !== text) items.push(text);
    this.items = items;
    this.index = items.length - 1;
    return this.current;
  }

  undo() {
    if (this.index > 0) this.index -= 1;
    return this.current;
  }

  redo() {
    if (this.index < this.items.length - 1) this.index += 1;
    return this.current;
  }
}
