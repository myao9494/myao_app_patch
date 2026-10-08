/**
 * 3D CAD幾何形状（エッジ・円）ワンクリック寸法測定モジュール仕様
 * 
 * 1. 直線エッジ（LineSegments）の最近傍検出と両端点・長さ寸法の自動生成
 * 2. 円形エッジ（CircleFeature: 穴・円筒リム）の検出と直径（⌀）・半径寸法の自動生成
 * 3. 2点または3点の個別クリックを不要にし、線や円をクリックするだけの直感的なCAD寸法測定を実現
 **/

import * as THREE from "three";

export interface CircleFeatureData {
  center: THREE.Vector3;
  radius: number;
  normal: THREE.Vector3;
}

export interface LinearMeasurement {
  type: "distance";
  a: THREE.Vector3;
  b: THREE.Vector3;
  distance: number;
  label: string;
}

export interface CircleMeasurement {
  type: "diameter";
  center: THREE.Vector3;
  radius: number;
  diameter: number;
  a: THREE.Vector3;
  b: THREE.Vector3;
  label: string;
}

export type GeometryMeasurement = LinearMeasurement | CircleMeasurement;

/**
 * クリック点 p 近傍の直線エッジを検出し、始点・終点と長さ寸法を返す
 */
export function findNearestEdge(
  p: THREE.Vector3,
  edgePositions: THREE.BufferAttribute | undefined,
  threshold: number,
  meshMatrix?: THREE.Matrix4,
): LinearMeasurement | null {
  if (!edgePositions || edgePositions.count < 2) return null;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const closest = new THREE.Vector3();
  const seg = new THREE.Line3();

  let bestA: THREE.Vector3 | null = null;
  let bestB: THREE.Vector3 | null = null;
  let bestDist = Infinity;

  for (let i = 0; i + 1 < edgePositions.count; i += 2) {
    a.fromBufferAttribute(edgePositions, i);
    b.fromBufferAttribute(edgePositions, i + 1);
    if (meshMatrix) {
      a.applyMatrix4(meshMatrix);
      b.applyMatrix4(meshMatrix);
    }

    seg.set(a, b);
    seg.closestPointToPoint(p, true, closest);
    const d = closest.distanceTo(p);

    if (d <= threshold && d < bestDist) {
      // 非常に短い線分（微小セグメント）は除外
      const len = a.distanceTo(b);
      if (len > 1e-4) {
        bestDist = d;
        bestA = a.clone();
        bestB = b.clone();
      }
    }
  }

  if (!bestA || !bestB) return null;

  const length = bestA.distanceTo(bestB);
  return {
    type: "distance",
    a: bestA,
    b: bestB,
    distance: Number(length.toFixed(2)),
    label: `${length.toFixed(2)} mm`,
  };
}

/**
 * クリック点 p 近傍の円形エッジ（穴・円筒リム）を検出し、直径寸法を返す
 */
export function findNearestCircle(
  p: THREE.Vector3,
  circles: CircleFeatureData[],
  threshold: number,
  meshMatrix?: THREE.Matrix4,
): CircleMeasurement | null {
  if (!circles || circles.length === 0) return null;

  const cw = new THREE.Vector3();
  const nw = new THREE.Vector3();
  const proj = new THREE.Vector3();
  const plane = new THREE.Plane();

  let bestCircle: CircleFeatureData | null = null;
  let bestScore = Infinity;
  let bestCenter = new THREE.Vector3();
  let bestNormal = new THREE.Vector3();
  let bestRadius = 0;

  for (const c of circles) {
    cw.copy(c.center);
    nw.copy(c.normal);
    let scale = 1;
    if (meshMatrix) {
      cw.applyMatrix4(meshMatrix);
      nw.transformDirection(meshMatrix).normalize();
      const sx = new THREE.Vector3().setFromMatrixColumn(meshMatrix, 0).length();
      scale = sx || 1;
    }
    const r = c.radius * scale;

    plane.setFromNormalAndCoplanarPoint(nw, cw);
    const planeDist = Math.abs(plane.distanceToPoint(p));
    if (planeDist > threshold * 1.5) continue;

    plane.projectPoint(p, proj);
    const rimDist = Math.abs(proj.distanceTo(cw) - r); // 円周リムからの距離
    if (rimDist > threshold) continue;

    const score = planeDist + rimDist;
    if (score < bestScore) {
      bestScore = score;
      bestCircle = c;
      bestCenter.copy(cw);
      bestNormal.copy(nw);
      bestRadius = r;
    }
  }

  if (!bestCircle || bestRadius <= 1e-4) return null;

  // 直径をなす端点ペア a, b を計算
  let refAxis = new THREE.Vector3(0, 1, 0);
  if (Math.abs(bestNormal.dot(refAxis)) > 0.9) {
    refAxis = new THREE.Vector3(1, 0, 0);
  }
  const u = new THREE.Vector3().crossVectors(bestNormal, refAxis).normalize();
  const a = bestCenter.clone().addScaledVector(u, bestRadius);
  const b = bestCenter.clone().addScaledVector(u, -bestRadius);

  const diameter = bestRadius * 2;
  return {
    type: "diameter",
    center: bestCenter,
    radius: Number(bestRadius.toFixed(2)),
    diameter: Number(diameter.toFixed(2)),
    a,
    b,
    label: `⌀ ${diameter.toFixed(2)} mm`,
  };
}

/**
 * クリック点 p に対して円形エッジまたは直線エッジを優先度順に検出し、寸法結果を返す
 */
export function pickGeometryMeasurement(
  p: THREE.Vector3,
  circles: CircleFeatureData[],
  edgePositions: THREE.BufferAttribute | undefined,
  threshold: number,
  meshMatrix?: THREE.Matrix4,
): GeometryMeasurement | null {
  // 円形エッジを優先判定（円周は直線セグメントの集合でもあるため）
  const circleResult = findNearestCircle(p, circles, threshold, meshMatrix);
  if (circleResult) return circleResult;

  // 直線エッジを判定
  const edgeResult = findNearestEdge(p, edgePositions, threshold, meshMatrix);
  if (edgeResult) return edgeResult;

  return null;
}
