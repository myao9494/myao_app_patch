/**
 * 3D寸法測定および注記（アノテーション）計算ユーティリティの単体テスト仕様。
 * - 2点間直線距離 (L) および軸成分 (dX, dY, dZ) の正確な計算
 * - 頂点スナップ (最近傍頂点探索) の精度と判定
 * - 寸法オブジェクトおよび注記オブジェクトの生成・バリデーション
 * - 3Dワールド座標からスクリーンピクセル座標への射影変換
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateDistance,
  findNearestVertex,
  createMeasurement,
  createAnnotation,
  projectToScreen,
  fitCircleFrom3Points,
  detectSmartDimension,
  createSmartMeasurement,
} from "../src/three-diff/measureUtils.js";

test("calculateDistance: 2点間の直線距離と各軸成分を正しく計算できる", () => {
  const p1 = { x: 0, y: 0, z: 0 };
  const p2 = { x: 3, y: 4, z: 12 }; // 3^2 + 4^2 + 12^2 = 9 + 16 + 144 = 169 = 13^2

  const result = calculateDistance(p1, p2);
  assert.equal(result.distance, 13);
  assert.equal(result.dx, 3);
  assert.equal(result.dy, 4);
  assert.equal(result.dz, 12);
});

test("calculateDistance: 同一地点の場合は距離0を返す", () => {
  const p1 = { x: 10.5, y: -2.3, z: 4.0 };
  const result = calculateDistance(p1, p1);
  assert.equal(result.distance, 0);
  assert.equal(result.dx, 0);
  assert.equal(result.dy, 0);
  assert.equal(result.dz, 0);
});

test("findNearestVertex: 面の3頂点から交差点に最も近い頂点へ正しくスナップする", () => {
  // 面の頂点群
  const vA = { x: 0, y: 0, z: 0 };
  const vB = { x: 10, y: 0, z: 0 };
  const vC = { x: 0, y: 10, z: 0 };
  const intersectionPoint = { x: 0.8, y: 0.5, z: 0 }; // vAに最も近い

  const snapped = findNearestVertex(intersectionPoint, [vA, vB, vC], 2.0);
  assert.equal(snapped.snapped, true);
  assert.equal(snapped.x, 0);
  assert.equal(snapped.y, 0);
  assert.equal(snapped.z, 0);
});

test("findNearestVertex: しきい値距離を超える場合はスナップせず交差点を返す", () => {
  const vA = { x: 0, y: 0, z: 0 };
  const vB = { x: 10, y: 0, z: 0 };
  const vC = { x: 0, y: 10, z: 0 };
  const intersectionPoint = { x: 5, y: 5, z: 0 }; // 各頂点から5以上離れている

  const snapped = findNearestVertex(intersectionPoint, [vA, vB, vC], 1.0);
  assert.equal(snapped.snapped, false);
  assert.equal(snapped.x, 5);
  assert.equal(snapped.y, 5);
  assert.equal(snapped.z, 0);
});

test("createMeasurement: 寸法ピン留めオブジェクトを正常に生成する", () => {
  const p1 = { x: 0, y: 0, z: 0 };
  const p2 = { x: 20, y: 0, z: 0 };

  const m = createMeasurement("m-1", p1, p2);
  assert.equal(m.id, "m-1");
  assert.equal(m.distance, 20);
  assert.equal(m.label, "20.00 mm");
  assert.equal(m.start.x, 0);
  assert.equal(m.end.x, 20);
});

test("createAnnotation: 注記オブジェクトを正常に生成・初期化する", () => {
  const pt = { x: 15, y: 25, z: 30 };
  const note = createAnnotation("note-1", pt, "ボスの肉厚確認", "#22c55e");

  assert.equal(note.id, "note-1");
  assert.equal(note.point.x, 15);
  assert.equal(note.text, "ボスの肉厚確認");
  assert.equal(note.color, "#22c55e");
  assert.equal(note.collapsed, false);
  assert.ok(note.offset && typeof note.offset.x === "number");
});

test("projectToScreen: カメラ射影行列により3D座標を2Dスクリーン座標へ変換する", () => {
  // カメラの透視投影の模擬（クリッピング空間 [-1, 1] から画面ピクセルへの変換）
  const point = { x: 0, y: 0, z: 0 };
  // 中心に投影されるダミー射影関数
  const projectFn = (p) => ({ x: 0, y: 0, z: 0.5 }); // NDC (0, 0, 0.5)

  const screen = projectToScreen(point, projectFn, 800, 600);
  assert.equal(screen.visible, true);
  assert.equal(screen.x, 400); // 800 / 2
  assert.equal(screen.y, 300); // 600 / 2
});

test("projectToScreen: カメラの背後にある場合は visible: false となる", () => {
  const point = { x: 0, y: 0, z: -100 };
  const projectFn = (p) => ({ x: 0, y: 0, z: 1.5 }); // NDC z > 1 はカメラ背後/クリップ外

  const screen = projectToScreen(point, projectFn, 800, 600);
  assert.equal(screen.visible, false);
});

test("fitCircleFrom3Points: 空間上の3点から円の中心・半径R・直径φを算出できる", () => {
  // 半径 R = 5, 直径 φ = 10 の円周上の3点 (XY平面上)
  // (5, 0), (0, 5), (-5, 0)
  const p1 = { x: 5, y: 0, z: 10 };
  const p2 = { x: 0, y: 5, z: 10 };
  const p3 = { x: -5, y: 0, z: 10 };

  const circle = fitCircleFrom3Points(p1, p2, p3);
  assert.ok(circle);
  assert.equal(Math.round(circle.radius), 5);
  assert.equal(Math.round(circle.diameter), 10);
  assert.equal(Math.round(circle.center.x), 0);
  assert.equal(Math.round(circle.center.y), 0);
  assert.equal(Math.round(circle.center.z), 10);
});

test("fitCircleFrom3Points: 同一直線上の3点の場合は null を返す", () => {
  const p1 = { x: 0, y: 0, z: 0 };
  const p2 = { x: 5, y: 5, z: 5 };
  const p3 = { x: 10, y: 10, z: 10 };

  const circle = fitCircleFrom3Points(p1, p2, p3);
  assert.equal(circle, null);
});

test("detectSmartDimension: 3点指定時は穴径(φ)をスマート自動認識する", () => {
  const p1 = { x: 6, y: 0, z: 0 };
  const p2 = { x: 0, y: 6, z: 0 };
  const p3 = { x: -6, y: 0, z: 0 };

  const smart = detectSmartDimension([p1, p2, p3]);
  assert.equal(smart.type, "diameter");
  assert.equal(smart.value, 12);
  assert.equal(smart.label, "φ12.00 mm");
  assert.deepEqual(smart.availableTypes, ["diameter", "radius", "distance"]);
});

test("detectSmartDimension: 45度面取り要素をスマート自動認識する", () => {
  // 面取り幅 C2 (dx=2, dy=2)
  const p1 = { x: 10, y: 2, z: 0 };
  const p2 = { x: 12, y: 0, z: 0 };

  const smart = detectSmartDimension([p1, p2], { isChamferFace: true });
  assert.equal(smart.type, "chamfer");
  assert.equal(smart.value, 2);
  assert.equal(smart.label, "C2.00 mm");
});

test("createSmartMeasurement: ドラッグ用オフセットと手動選択可能タイプを保持する", () => {
  const p1 = { x: 0, y: 0, z: 0 };
  const p2 = { x: 10, y: 0, z: 0 };

  const m = createSmartMeasurement("m-smart-1", [p1, p2]);
  assert.equal(m.id, "m-smart-1");
  assert.equal(m.type, "distance");
  assert.equal(m.label, "10.00 mm");
  assert.deepEqual(m.offset, { dx: 0, dy: 0 }); // 初期ドラッグオフセット
  assert.ok(Array.isArray(m.availableTypes));
});

