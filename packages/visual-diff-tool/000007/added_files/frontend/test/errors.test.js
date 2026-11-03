/**
 * 想定外のエラーの扱い（lib/errors.js）の単体テスト。
 * - 表示する文面はどんな値が投げられても文字列になる
 * - 動作に影響しないブラウザーの警告と、中断した通信は通知しない
 */

import test from "node:test";
import assert from "node:assert/strict";
import { describeError, shouldIgnoreGlobalError } from "../src/lib/errors.js";

test("describeError: Error・文字列・空の値を文字列にする", () => {
  assert.equal(describeError(new Error("壊れた")), "壊れた");
  assert.equal(describeError("文字列"), "文字列");
  assert.equal(describeError({ reason: 1 }), "[object Object]");
  assert.equal(describeError(null), "原因不明のエラーです");
  assert.equal(describeError("x".repeat(600)).length, 500);
});

test("shouldIgnoreGlobalError: 動作に影響しないものだけ無視する", () => {
  assert.equal(shouldIgnoreGlobalError("ResizeObserver loop completed with undelivered notifications."), true);
  assert.equal(shouldIgnoreGlobalError(Object.assign(new Error("aborted"), { name: "AbortError" })), true);
  assert.equal(shouldIgnoreGlobalError(new TypeError("Cannot read properties of undefined")), false);
  assert.equal(shouldIgnoreGlobalError(null), false);
});
