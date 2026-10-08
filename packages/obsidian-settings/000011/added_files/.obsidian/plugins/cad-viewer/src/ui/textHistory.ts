/**
 * テキストエリアおよび入力向けUndo/Redo履歴管理クラス
 * 
 * 1. テキスト入力の変更履歴スタックを管理
 * 2. Ctrl+Z / Cmd+Z によるUndo（元に戻す）
 * 3. Ctrl+Y / Cmd+Shift+Z によるRedo（やり直す）
 * 4. 同一値の連続プッシュ抑制、スタックサイズ上限管理
 **/

export class TextHistory {
  private stack: string[] = [];
  private index = 0;
  private maxHistory: number;

  constructor(initialValue = "", maxHistory = 100) {
    this.stack = [initialValue];
    this.index = 0;
    this.maxHistory = maxHistory;
  }

  get current(): string {
    return this.stack[this.index] ?? "";
  }

  canUndo(): boolean {
    return this.index > 0;
  }

  canRedo(): boolean {
    return this.index < this.stack.length - 1;
  }

  push(value: string): void {
    if (this.stack[this.index] === value) return;

    // 現在位置より先の履歴を破棄
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(value);

    // 上限を超えたら古いものを削除
    if (this.stack.length > this.maxHistory) {
      this.stack.shift();
    } else {
      this.index++;
    }
  }

  undo(): string | undefined {
    if (!this.canUndo()) return undefined;
    this.index--;
    return this.current;
  }

  redo(): string | undefined {
    if (!this.canRedo()) return undefined;
    this.index++;
    return this.current;
  }

  reset(value: string): void {
    this.stack = [value];
    this.index = 0;
  }
}
