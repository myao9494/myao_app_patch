/**
 * 印刷用画像のレイアウト計算のテスト
 *
 * 1. 画像の大きさはコードブロックの幅・高さに従う
 * 2. 白い背景で読めない文字色を置き換える
 * 3. 注記の折り返し
 * 4. 座標軸の画面上の向き
 **/

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  PRINT_DEFAULT_HEIGHT,
  PRINT_DEFAULT_WIDTH,
  printSize,
  readablePrintColor,
  screenAxes,
  wrapPrintText,
} from "./printLayout";

test("printSize: コードブロックの幅と高さをそのまま使う", () => {
  assert.deepEqual(printSize({ width: 579, height: 661 }), { width: 579, height: 661 });
});

test("printSize: 指定が無いときは既定の大きさにする", () => {
  assert.deepEqual(printSize({}), { width: PRINT_DEFAULT_WIDTH, height: PRINT_DEFAULT_HEIGHT });
  assert.deepEqual(printSize({ height: 300 }), { width: PRINT_DEFAULT_WIDTH, height: 300 });
});

test("readablePrintColor: 指定の無い文字は濃い色にする（ダークテーマの白文字を持ち込まない）", () => {
  assert.equal(readablePrintColor(undefined), "#111111");
});

test("readablePrintColor: 白・黄色は白い背景で読めないため濃い色にする", () => {
  assert.equal(readablePrintColor("#ffffff"), "#111111");
  assert.equal(readablePrintColor("#fff"), "#111111");
  assert.equal(readablePrintColor("#ffc531"), "#111111");
});

test("readablePrintColor: 読める色はそのまま使う", () => {
  assert.equal(readablePrintColor("#000000"), "#000000");
  assert.equal(readablePrintColor("#e5484d"), "#e5484d");
  assert.equal(readablePrintColor("#30a46c"), "#30a46c");
  assert.equal(readablePrintColor("rebeccapurple"), "rebeccapurple");
});

test("wrapPrintText: 幅に収まる行は折り返さない", () => {
  assert.deepEqual(wrapPrintText("abc", 10, (s) => s.length), ["abc"]);
});

test("wrapPrintText: 改行を保ち、長い行は文字単位で折り返す", () => {
  assert.deepEqual(wrapPrintText("abcde\nあいう", 2, (s) => s.length), ["ab", "cd", "e", "あい", "う"]);
});

test("wrapPrintText: 末尾の空行は出さない", () => {
  assert.deepEqual(wrapPrintText("thnalktnha\n", 100, (s) => s.length), ["thnalktnha"]);
});

test("wrapPrintText: 途中の空行は残す", () => {
  assert.deepEqual(wrapPrintText("a\n\nb", 100, (s) => s.length), ["a", "", "b"]);
});

const axisOf = (axes: ReturnType<typeof screenAxes>, label: string) => {
  const axis = axes.find((a) => a.label === label);
  assert.ok(axis);
  return axis;
};

test("screenAxes: 正面から見ると X は右、Y は上、Z は手前を向く", () => {
  const axes = screenAxes(new THREE.Quaternion(), new THREE.Quaternion());
  assert.ok(Math.abs(axisOf(axes, "X").x - 1) < 1e-9);
  assert.ok(Math.abs(axisOf(axes, "Y").y - 1) < 1e-9);
  assert.ok(Math.abs(axisOf(axes, "Z").depth - 1) < 1e-9);
});

test("screenAxes: カメラを右へ90度回すと X は手前を向かず奥へ向く", () => {
  const camera = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
  const axes = screenAxes(camera, new THREE.Quaternion());
  assert.ok(Math.abs(axisOf(axes, "X").depth + 1) < 1e-9);
  assert.ok(Math.abs(axisOf(axes, "Z").x - 1) < 1e-9);
});

test("screenAxes: モデルの回転（90°回転ボタン）を反映する", () => {
  const model = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  const axes = screenAxes(new THREE.Quaternion(), model);
  assert.ok(Math.abs(axisOf(axes, "X").y - 1) < 1e-9);
});

test("screenAxes: 手前の軸が最後に描かれるよう、奥から順に並べる", () => {
  const axes = screenAxes(new THREE.Quaternion(), new THREE.Quaternion());
  assert.equal(axes[axes.length - 1].label, "Z");
});
