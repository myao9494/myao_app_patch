/**
 * 3D CAD幾何形状（エッジ・円）ワンクリック寸法測定のテスト仕様
 * 
 * 1. 直線エッジ近傍のクリックで直線寸法（始点・終点・長さ）が自動検出されること
 * 2. 円形エッジ（穴・円筒リム）近傍のクリックで直径寸法（中心・半径・直径・端点ペア・⌀表記ラベル）が自動検出されること
 * 3. 閾値より遠い位置のクリックではnullが返り、誤検出しないこと
 * 4. 円と直線が近接している場合、円の直径測定が優先されること
 **/

import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  findNearestCircle,
  findNearestEdge,
  pickGeometryMeasurement,
  type CircleFeatureData,
} from "./edgeMeasurement";

test("直線エッジ近傍のクリックで直線寸法が自動測定されること", () => {
  // 始点 (0, 0, 0) から 終点 (50, 0, 0) の線分
  const positions = new Float32Array([
    0, 0, 0,
    50, 0, 0,
  ]);
  const attr = new THREE.BufferAttribute(positions, 3);

  // 線分の中央付近 (25, 1, 0) をクリック（閾値 2.0 以内）
  const pickPoint = new THREE.Vector3(25, 1, 0);
  const result = findNearestEdge(pickPoint, attr, 2.0);

  assert.ok(result, "エッジが検出されること");
  assert.equal(result.type, "distance");
  assert.equal(result.distance, 50);
  assert.equal(result.a.x, 0);
  assert.equal(result.b.x, 50);
  assert.equal(result.label, "50.00 mm");
});

test("直線エッジから遠いクリックではnullが返ること", () => {
  const positions = new Float32Array([
    0, 0, 0,
    50, 0, 0,
  ]);
  const attr = new THREE.BufferAttribute(positions, 3);

  // 遠い位置 (25, 10, 0) をクリック（閾値 2.0）
  const pickPoint = new THREE.Vector3(25, 10, 0);
  const result = findNearestEdge(pickPoint, attr, 2.0);

  assert.equal(result, null);
});

test("円形エッジ（穴）近傍のクリックで直径寸法が自動測定されること", () => {
  const circles: CircleFeatureData[] = [
    {
      center: new THREE.Vector3(0, 0, 0),
      radius: 10, // 半径10mm (直径20mm)
      normal: new THREE.Vector3(0, 0, 1),
    },
  ];

  // 円周上の点 (10, 0.5, 0) 付近をクリック
  const pickPoint = new THREE.Vector3(10, 0.5, 0);
  const result = findNearestCircle(pickPoint, circles, 2.0);

  assert.ok(result, "円が検出されること");
  assert.equal(result.type, "diameter");
  assert.equal(result.radius, 10);
  assert.equal(result.diameter, 20);
  assert.ok(result.label.includes("⌀ 20.00 mm") || result.label.includes("⌀20.00 mm"));
  // 直径をなす端点ペアの距離が直径と一致すること
  assert.ok(Math.abs(result.a.distanceTo(result.b) - 20) < 1e-4);
});

test("pickGeometryMeasurementで円が優先して検出されること", () => {
  const circles: CircleFeatureData[] = [
    {
      center: new THREE.Vector3(10, 10, 0),
      radius: 5, // 直径10mm
      normal: new THREE.Vector3(0, 0, 1),
    },
  ];

  // 円周上と交わるような直線エッジ
  const positions = new Float32Array([
    15, 0, 0,
    15, 20, 0,
  ]);
  const attr = new THREE.BufferAttribute(positions, 3);

  // 円のリム付近 (15, 10, 0) をクリック
  const pickPoint = new THREE.Vector3(15, 10, 0);
  const result = pickGeometryMeasurement(pickPoint, circles, attr, 2.0);

  assert.ok(result);
  assert.equal(result.type, "diameter", "円の直径測定が優先されること");
  assert.equal(result.diameter, 10);
});
