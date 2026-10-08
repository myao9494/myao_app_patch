/**
 * テキストエリアのUndo/Redo履歴管理機能の単体テスト
 **/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TextHistory } from "./textHistory";

describe("TextHistory", () => {
  it("初期値を正しく保持できること", () => {
    const history = new TextHistory("初期テキスト");
    assert.equal(history.current, "初期テキスト");
    assert.equal(history.canUndo(), false);
    assert.equal(history.canRedo(), false);
  });

  it("値のプッシュとUndoができること", () => {
    const history = new TextHistory("A");
    history.push("AB");
    history.push("ABC");

    assert.equal(history.canUndo(), true);
    assert.equal(history.undo(), "AB");
    assert.equal(history.undo(), "A");
    assert.equal(history.canUndo(), false);
    assert.equal(history.undo(), undefined);
  });

  it("Undo後にRedoができること", () => {
    const history = new TextHistory("A");
    history.push("AB");
    history.push("ABC");

    history.undo(); // "AB"
    history.undo(); // "A"

    assert.equal(history.canRedo(), true);
    assert.equal(history.redo(), "AB");
    assert.equal(history.redo(), "ABC");
    assert.equal(history.canRedo(), false);
  });

  it("Undo後に新しい値をプッシュするとRedoスタックがクリアされること", () => {
    const history = new TextHistory("A");
    history.push("AB");
    history.undo(); // "A"

    history.push("AX");
    assert.equal(history.canRedo(), false);
    assert.equal(history.current, "AX");
    assert.equal(history.undo(), "A");
  });

  it("同じ値が連続してプッシュされた場合は重複記録しないこと", () => {
    const history = new TextHistory("A");
    history.push("A");
    history.push("A");
    assert.equal(history.canUndo(), false);
  });
});
