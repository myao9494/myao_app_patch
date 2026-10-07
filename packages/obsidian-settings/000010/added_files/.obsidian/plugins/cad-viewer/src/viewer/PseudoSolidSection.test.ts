/**
 * 擬似ソリッド断面生成機能のテスト仕様
 * 
 * 1. クリッピング平面とメッシュの交差から切断ループ（交線）を算出
 * 2. 抽出されたループから閉じたキャップポリゴン（BufferGeometry）を生成
 * 3. オープンシェル（非Watertight）形状であっても空洞にならず断面キャップが生成されること
 **/

import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildSectionCapGeometry } from "./PseudoSolidSection";

test("ボックスメッシュをZ平面で切断した際、四角形の断面キャップポリゴンが生成されること", () => {
  const geom = new THREE.BoxGeometry(2, 2, 2);
  const mesh = new THREE.Mesh(geom);
  // Z=0 の平面で切断（法線 (0, 0, 1), constant = 0）
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

  const capGeom = buildSectionCapGeometry([mesh], plane);
  assert.ok(capGeom !== null, "キャップジオメトリが生成されること");
  assert.ok(capGeom.getAttribute("position").count >= 6, "四角形（最低2三角形=6頂点）が生成されること");
});

test("オープンシェル（上下が開いた中空シリンダーシェル）を切断した際にも断面キャップが生成されること", () => {
  // 上下が開いたオープンシェル（非watertight）シリンダー
  const geom = new THREE.CylinderGeometry(1, 1, 2, 16, 1, true);
  const mesh = new THREE.Mesh(geom);
  // Y=0 の平面で切断（法線 (0, 1, 0), constant = 0）
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  const capGeom = buildSectionCapGeometry([mesh], plane);
  assert.ok(capGeom !== null, "オープンシェルでもキャップジオメトリが生成されること");
  assert.ok(capGeom.getAttribute("position").count > 0, "交差ポリゴンの頂点が存在すること");
});
