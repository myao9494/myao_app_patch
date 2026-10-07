/**
 * CADファイルドロップハンドラーのテスト仕様
 * 
 * 1. 対応CAD拡張子（.step, .stp, .fcstd, .obj, .stl）の判定
 * 2. ドロップ時の```stepコードブロックの自動生成
 **/

import test from "node:test";
import assert from "node:assert/strict";
import { isCadFile, buildCadCodeBlock, extractCadPathFromDropData } from "./dropHandler";

test("対応CADファイル拡張子を正確に判定できること", () => {
  assert.equal(isCadFile("model.step"), true);
  assert.equal(isCadFile("part.STP"), true);
  assert.equal(isCadFile("drawing.fcstd"), true);
  assert.equal(isCadFile("mesh.obj"), true);
  assert.equal(isCadFile("part.stl"), true);
  assert.equal(isCadFile("document.md"), false);
  assert.equal(isCadFile("image.png"), false);
});

test("指定パスとオプションから```stepコードブロックを正確に生成できること", () => {
  const codeBlock = buildCadCodeBlock("01_data/2026/10/06/CBES.step");
  assert.equal(
    codeBlock,
    "```step\npath: 01_data/2026/10/06/CBES.step\nheight: 800\nview: iso\n```\n",
  );

  const customBlock = buildCadCodeBlock("models/part.stp", 600, "front", true);
  assert.equal(
    customBlock,
    "```step\npath: models/part.stp\nheight: 600\nview: front\nlocked: true\n```\n",
  );
});

test("ドロップされたテキストやWikilinkからCADファイルパスを正確に抽出できること", () => {
  assert.equal(
    extractCadPathFromDropData("[[CBES (50kg to 2000kg).step]]"),
    "CBES (50kg to 2000kg).step",
  );
  assert.equal(
    extractCadPathFromDropData("![[01_data/2026/10/06/CBES (50kg to 2000kg).step]]"),
    "01_data/2026/10/06/CBES (50kg to 2000kg).step",
  );
  assert.equal(
    extractCadPathFromDropData("01_data/2026/10/06/CBES (50kg to 2000kg).step"),
    "01_data/2026/10/06/CBES (50kg to 2000kg).step",
  );
  assert.equal(
    extractCadPathFromDropData("[[document.md]]"),
    null,
  );
});

