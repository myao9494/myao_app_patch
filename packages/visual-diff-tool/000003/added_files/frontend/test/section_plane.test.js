/**
 * 3D断面平面 (Section Plane) 計算ユーティリティの単体テスト仕様。
 * - 切断平面 (THREE.Plane) の法線および定数 (constant) の正確な算出
 * - X / Y / Z 軸の切断ベクトルと反転 (Flip) 判定
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createClippingPlane } from "../src/three-diff/sectionPlane.js";

test("createClippingPlane: X軸切断平面を正しく生成する", () => {
  const plane = createClippingPlane("x", 25.0, false);
  assert.equal(plane.normal.x, 1);
  assert.equal(plane.normal.y, 0);
  assert.equal(plane.normal.z, 0);
  assert.equal(plane.constant, -25.0);
});

test("createClippingPlane: Y軸切断かつ反転時の平面を正しく生成する", () => {
  const plane = createClippingPlane("y", 10.0, true);
  assert.equal(plane.normal.x, 0);
  assert.equal(plane.normal.y, -1);
  assert.equal(plane.normal.z, 0);
  assert.equal(plane.constant, 10.0);
});

test("createClippingPlane: Z軸切断平面を正しく生成する", () => {
  const plane = createClippingPlane("z", -5.0, false);
  assert.equal(plane.normal.x, 0);
  assert.equal(plane.normal.y, 0);
  assert.equal(plane.normal.z, 1);
  assert.equal(plane.constant, 5.0);
});
