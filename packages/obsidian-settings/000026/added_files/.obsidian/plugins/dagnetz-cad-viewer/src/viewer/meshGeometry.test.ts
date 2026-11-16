/**
 * 仕様: メッシュから求める形状の計算（meshGeometry.ts）のテスト
 *
 * 1. circleFrom3Points: 3点を通る円の中心と半径を求め、一直線上の3点では null を返すこと
 * 2. detectCircles: 輪になったエッジのうち、円だけを検出すること（四角い輪、開いた線は検出しない）
 * 3. volumeAndArea: 閉じたメッシュの体積と表面積を求めること（インデックスの有無によらない）
 * 4. formatMm / num / easeInOut / mid: 表示用の整形と補助
 **/

import { test, describe } from "node:test";
import * as assert from "node:assert";
import * as THREE from "three";
import {
  circleFrom3Points,
  detectCircles,
  easeInOut,
  formatMm,
  mid,
  num,
  volumeAndArea,
} from "./meshGeometry";

const near = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≒ ${expected}`);

/** 点の並びを、線分（LineSegments）の頂点の並びにする（最後の点から最初の点へ閉じる）。 */
function loopSegments(points: THREE.Vector3[], closed = true): THREE.BufferAttribute {
  const values: number[] = [];
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    values.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  return new THREE.BufferAttribute(new Float32Array(values), 3);
}

function circlePoints(center: THREE.Vector3, radius: number, segments: number): THREE.Vector3[] {
  return Array.from({ length: segments }, (_, i) => {
    const angle = (i / segments) * Math.PI * 2;
    return new THREE.Vector3(center.x + radius * Math.cos(angle), center.y + radius * Math.sin(angle), center.z);
  });
}

describe("circleFrom3Points", () => {
  test("3点を通る円の中心と半径を求める", () => {
    const circle = circleFrom3Points(
      new THREE.Vector3(12, 20, 5),
      new THREE.Vector3(10, 22, 5),
      new THREE.Vector3(8, 20, 5),
    );
    assert.ok(circle);
    near(circle.radius, 2);
    near(circle.center.distanceTo(new THREE.Vector3(10, 20, 5)), 0);
  });

  test("一直線上の3点では null を返す", () => {
    assert.strictEqual(
      circleFrom3Points(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1), new THREE.Vector3(2, 2, 2)),
      null,
    );
  });
});

describe("detectCircles", () => {
  test("円形の輪を検出し、中心・半径・面の向きを求める", () => {
    const circles = detectCircles(loopSegments(circlePoints(new THREE.Vector3(3, 4, 5), 2.5, 24)));
    assert.strictEqual(circles.length, 1);
    near(circles[0].radius, 2.5, 1e-3);
    near(circles[0].center.distanceTo(new THREE.Vector3(3, 4, 5)), 0, 1e-3);
    near(Math.abs(circles[0].normal.z), 1, 1e-6);
  });

  test("離れた2つの円を別々に検出する", () => {
    const first = loopSegments(circlePoints(new THREE.Vector3(0, 0, 0), 1, 16));
    const second = loopSegments(circlePoints(new THREE.Vector3(10, 0, 0), 3, 16));
    const merged = new THREE.BufferAttribute(
      new Float32Array([...(first.array as Float32Array), ...(second.array as Float32Array)]),
      3,
    );
    const radii = detectCircles(merged).map((circle) => circle.radius).sort((a, b) => a - b);
    assert.strictEqual(radii.length, 2);
    near(radii[0], 1, 1e-3);
    near(radii[1], 3, 1e-3);
  });

  test("四角い輪、頂点の少ない輪、開いた線は検出しない", () => {
    const square: THREE.Vector3[] = [];
    for (let i = 0; i < 4; i++) square.push(new THREE.Vector3(i, 0, 0));
    for (let i = 0; i < 4; i++) square.push(new THREE.Vector3(4, i, 0));
    for (let i = 0; i < 4; i++) square.push(new THREE.Vector3(4 - i, 4, 0));
    for (let i = 0; i < 4; i++) square.push(new THREE.Vector3(0, 4 - i, 0));
    assert.deepStrictEqual(detectCircles(loopSegments(square)), []);
    assert.deepStrictEqual(detectCircles(loopSegments(circlePoints(new THREE.Vector3(), 1, 6))), []);
    assert.deepStrictEqual(detectCircles(loopSegments(circlePoints(new THREE.Vector3(), 1, 24), false)), []);
  });
});

describe("volumeAndArea", () => {
  test("直方体の体積と表面積を求める（インデックスあり）", () => {
    const { volume, area } = volumeAndArea(new THREE.BoxGeometry(2, 3, 4));
    near(volume, 24, 1e-4);
    near(area, 52, 1e-4);
  });

  test("インデックスの無いメッシュでも同じ結果になる", () => {
    const { volume, area } = volumeAndArea(new THREE.BoxGeometry(2, 3, 4).toNonIndexed());
    near(volume, 24, 1e-4);
    near(area, 52, 1e-4);
  });

  test("頂点の無い形状は 0 を返す", () => {
    assert.deepStrictEqual(volumeAndArea(new THREE.BufferGeometry()), { volume: 0, area: 0 });
  });
});

describe("表示用の整形と補助", () => {
  test("formatMm: 1000mm 以上はメートルで表す", () => {
    assert.strictEqual(formatMm(12.345), "12.35 mm");
    assert.strictEqual(formatMm(999.994), "999.99 mm");
    assert.strictEqual(formatMm(1000), "1.000 m");
    assert.strictEqual(formatMm(2500.4), "2.500 m");
  });

  test("num: 100 以上は整数、それ未満は小数1桁", () => {
    assert.strictEqual(num(123.4), "123");
    assert.strictEqual(num(12.34), "12.3");
  });

  test("easeInOut: 0 → 1 へなめらかに進み、中間は 0.5", () => {
    assert.strictEqual(easeInOut(0), 0);
    assert.strictEqual(easeInOut(0.5), 0.5);
    assert.strictEqual(easeInOut(1), 1);
    assert.ok(easeInOut(0.25) < 0.25 && easeInOut(0.75) > 0.75);
  });

  test("mid: 2点の中点を返し、元の点を変えない", () => {
    const a = new THREE.Vector3(0, 0, 0);
    const b = new THREE.Vector3(2, 4, 6);
    assert.deepStrictEqual(mid(a, b).toArray(), [1, 2, 3]);
    assert.deepStrictEqual(a.toArray(), [0, 0, 0]);
  });
});
