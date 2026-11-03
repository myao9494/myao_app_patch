/**
 * Markdown内の3D表示を画像にするときの計算（cad-view/cadViewModel.js）の単体テスト。
 * - 表示モード名と番号の対応
 * - 画像の大きさ・注記の文字サイズと色・折り返し・札の位置（プラグインの印刷用画像と同じ規則）
 * - カメラの合わせ方（平行投影の viewHeight）と断面の平面
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  annotationCaption,
  annotationFontPx,
  cadViewKey,
  cadViewLabel,
  cadViewMode,
  cadViewTitleFromKey,
  cadViewSize,
  fitCamera,
  orthoZoom,
  placeLabel,
  readablePrintColor,
  sectionPlaneSpec,
  wrapPrintText,
} from "../src/cad-view/cadViewModel.js";

test("cadViewMode / cadViewKey: 表示モード名とブロックの key（name）を行き来できる", () => {
  assert.equal(cadViewMode("3D-1"), "cad-view:3D-1");
  assert.equal(cadViewKey("cad-view:3D-1"), "3D-1");
  assert.equal(cadViewKey("excalidraw"), null);
  assert.equal(cadViewKey("cad-view:"), null);
});

test("cadViewLabel: name があれば名前、無ければ出現順の番号で示す", () => {
  assert.equal(cadViewLabel({ index: 1, key: "3D-2", name: "3D-2", model: "a.step" }), "3D表示「3D-2」（a.step）");
  assert.equal(cadViewLabel({ index: 0, key: "#1", name: "", model: "a.step" }), "3D表示 1（a.step）");
  assert.equal(cadViewTitleFromKey("#3"), "3D表示 3");
  assert.equal(cadViewTitleFromKey("3D-1"), "3D表示「3D-1」");
});

test("cadViewSize: 幅・高さの指定が無ければプラグインの既定 700×400", () => {
  assert.deepEqual(cadViewSize({}), { width: 700, height: 400 });
  assert.deepEqual(cadViewSize({ width: 579, height: 661 }), { width: 579, height: 661 });
});

test("annotationFontPx: プリセット名・数値・px指定を解決する", () => {
  assert.equal(annotationFontPx(undefined), 14);
  assert.equal(annotationFontPx("large"), 18);
  assert.equal(annotationFontPx(20), 20);
  assert.equal(annotationFontPx("16px"), 16);
  assert.equal(annotationFontPx("unknown"), 14);
});

test("readablePrintColor: 白背景で読めない明るい色は黒に置き換える", () => {
  assert.equal(readablePrintColor(undefined), "#111111");
  assert.equal(readablePrintColor("#ffc531"), "#111111");
  assert.equal(readablePrintColor("#30a46c"), "#30a46c");
});

test("annotationCaption: Markdownの記号を外して表示される文字にする", () => {
  assert.equal(annotationCaption("**太字** と [[note|別名]] と `code`\n"), "太字 と 別名 と code");
});

test("wrapPrintText: 改行を保ち、幅を超えたら1文字単位で折り返す", () => {
  assert.deepEqual(wrapPrintText("abcdef\nxy", 3, (line) => line.length), ["abc", "def", "xy"]);
});

test("placeLabel: 引出線があれば錨からずらし、画像の外へはみ出さない", () => {
  const size = { width: 400, height: 300 };
  const box = { width: 100, height: 20 };
  assert.deepEqual(placeLabel({ x: 100, y: 100 }, { leader: true, ox: 50, oy: -30 }, box, size), { cx: 150, cy: 70, leader: true });
  assert.deepEqual(placeLabel({ x: 390, y: 5 }, { leader: false }, box, size), { cx: 350, cy: 10, leader: false });
});

test("fitCamera / orthoZoom: viewHeight があれば見えている高さをそろえる", () => {
  const fit = fitCamera({ min: [0, 0, 0], max: [100, 50, 20] }, 2, false);
  assert.equal(fit.halfHeight, 65);
  assert.equal(fit.halfWidth, 130);
  assert.deepEqual(fit.center, [50, 25, 10]);
  assert.equal(orthoZoom({ viewHeight: 65 }, fit.halfHeight), 2);
  assert.equal(orthoZoom({ zoom: 0.8 }, fit.halfHeight), 0.8);
});

test("sectionPlaneSpec: 軸の範囲の割合で切り、反転で残す側を入れ替える", () => {
  const box = { min: [0, 0, 0], max: [10, 20, 40] };
  assert.equal(sectionPlaneSpec({ enabled: false }, box), null);
  assert.deepEqual(sectionPlaneSpec({ enabled: true, axis: "z", offset: 0.25 }, box), { normal: [0, 0, 1], constant: -10 });
  const flipped = sectionPlaneSpec({ enabled: true, axis: "x", offset: 0.5, flipped: true }, box);
  assert.deepEqual(flipped.normal.map((v) => v + 0), [-1, 0, 0]);
  assert.equal(flipped.constant, 5);
});
