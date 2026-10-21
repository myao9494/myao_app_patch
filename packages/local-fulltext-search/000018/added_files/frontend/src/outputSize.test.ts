/**
 * 出力の文字数・容量の表示（outputSize）のテスト。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { countChars, formatMan, formatMegabytes } from "./outputSize.ts";

test("文字数は「12.35万文字」の形にする", () => {
  assert.equal(formatMan(123_456), "12.35万文字");
  assert.equal(formatMan(0), "0.00万文字");
});

test("容量は MB（小数 2 桁、1MB = 1,000,000 バイト）で表す", () => {
  assert.equal(formatMegabytes(4_500_000), "4.50MB");
  assert.equal(formatMegabytes(3_880_469), "3.88MB");
});

test("絵文字などのサロゲートペアは 1 文字と数える（サーバーの数え方と同じ）", () => {
  assert.equal(countChars("あ😀b"), 3);
  assert.equal(countChars(""), 0);
});
