/**
 * メッシュから求める形状の計算（WebGL やシーンに依存しない、計算だけの関数）
 *
 * 1. 円形のエッジ（穴の縁・円筒の端）の検出と、円の当てはめ（detectCircles / fitCircle）
 * 2. 3点を通る円（circleFrom3Points）
 * 3. 体積と表面積の概算（volumeAndArea）
 * 4. 寸法の表示用の整形（formatMm / num）と、小さな補助（mid / easeInOut / meshColor）
 **/

import * as THREE from "three";

/** A circular edge loop (hole rim / round boss), in the mesh's local space. */
export interface CircleFeature {
  center: THREE.Vector3;
  radius: number;
  normal: THREE.Vector3;
}

/**
 * Detect circular edge loops in a LineSegments position buffer (the feature
 * edges we already build for display). A hole's rim comes back as a closed
 * chain of short segments whose vertices are co-planar and equidistant from a
 * centre — we weld endpoints, split into connected components where every
 * vertex has degree 2 (simple cycles), then keep the ones that fit a circle.
 */
export function detectCircles(pos: THREE.BufferAttribute): CircleFeature[] {
  // Weld coincident endpoints so the rim reads as one connected loop.
  const map = new Map<string, number>();
  const verts: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  const idxOf = (i: number): number => {
    v.fromBufferAttribute(pos, i);
    const k = `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
    let j = map.get(k);
    if (j === undefined) {
      j = verts.length;
      verts.push(v.clone());
      map.set(k, j);
    }
    return j;
  };
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  };
  for (let i = 0; i + 1 < pos.count; i += 2) link(idxOf(i), idxOf(i + 1));

  const circles: CircleFeature[] = [];
  const seen = new Set<number>();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    // Gather the connected component; a clean loop has every vertex degree 2.
    const comp: number[] = [];
    const stack = [start];
    seen.add(start);
    let simpleCycle = true;
    while (stack.length) {
      const u = stack.pop()!;
      comp.push(u);
      const ns = adj.get(u)!;
      if (ns.length !== 2) simpleCycle = false;
      for (const w of ns) if (!seen.has(w)) { seen.add(w); stack.push(w); }
    }
    if (!simpleCycle || comp.length < 8) continue; // need a real ring

    const circle = fitCircle(verts, adj, start, comp.length);
    if (circle) circles.push(circle);
  }
  return circles;
}

/**
 * Walk the degree-2 loop starting at `start` and, if it closes cleanly, fit a
 * circle to it: near-constant radius from the centroid and near-planar. Returns
 * null when the loop isn't circular (a rectangle, an irregular contour, …).
 */
export function fitCircle(
  verts: THREE.Vector3[],
  adj: Map<number, number[]>,
  start: number,
  size: number,
): CircleFeature | null {
  // Order the loop by walking the adjacency (each vertex has exactly 2 links).
  const order: number[] = [];
  let prev = -1;
  let cur = start;
  for (let i = 0; i < size; i++) {
    order.push(cur);
    const ns = adj.get(cur)!;
    const nxt = ns[0] === prev ? ns[1] : ns[0];
    prev = cur;
    cur = nxt;
  }
  if (cur !== start) return null; // didn't return to the start → not one cycle

  const center = new THREE.Vector3();
  for (const i of order) center.add(verts[i]);
  center.divideScalar(order.length);

  // Newell's method for the loop's plane normal.
  const normal = new THREE.Vector3();
  for (let i = 0; i < order.length; i++) {
    const a = verts[order[i]];
    const b = verts[order[(i + 1) % order.length]];
    normal.x += (a.y - b.y) * (a.z + b.z);
    normal.y += (a.z - b.z) * (a.x + b.x);
    normal.z += (a.x - b.x) * (a.y + b.y);
  }
  if (normal.lengthSq() < 1e-12) return null;
  normal.normalize();

  // Mean radius, then reject if the radius varies too much (not round) or if
  // any vertex sits well off the plane (not planar).
  let rSum = 0;
  for (const i of order) rSum += verts[i].distanceTo(center);
  const r = rSum / order.length;
  if (r < 1e-4) return null;
  for (const i of order) {
    const d = verts[i].distanceTo(center);
    if (Math.abs(d - r) > 0.15 * r) return null; // radius spread > 15%
    if (Math.abs(verts[i].clone().sub(center).dot(normal)) > 0.05 * r) return null;
  }
  return { center, radius: r, normal };
}

/** Format a millimeter distance, switching to metres for large values. */
export function formatMm(mm: number): string {
  if (mm >= 1000) return `${(mm / 1000).toFixed(3)} m`;
  return `${mm.toFixed(2)} mm`;
}

/** Compact unit-less millimetre number for the per-axis components. */
export function num(mm: number): string {
  return mm >= 100 ? mm.toFixed(0) : mm.toFixed(1);
}

export function mid(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  return a.clone().add(b).multiplyScalar(0.5);
}

/**
 * Approximate solid volume and surface area from a triangle mesh: area is the
 * summed triangle areas; volume is the summed signed tetrahedron volumes (from
 * the origin), whose absolute value is the enclosed volume for a closed shell.
 * Both are approximate — the mesh is a tessellation of the true B-rep.
 */
export function volumeAndArea(geom: THREE.BufferGeometry): { volume: number; area: number } {
  const pos = geom.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos) return { volume: 0, area: 0 };
  const index = geom.getIndex();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();
  let vol = 0;
  let area = 0;
  const tri = (i: number, j: number, k: number): void => {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, j);
    c.fromBufferAttribute(pos, k);
    vol += a.dot(cross.copy(b).cross(c)) / 6;
    ab.copy(b).sub(a);
    ac.copy(c).sub(a);
    area += cross.copy(ab).cross(ac).length() / 2;
  };
  const count = index ? index.count : pos.count;
  for (let t = 0; t < count; t += 3) {
    if (index) tri(index.getX(t), index.getX(t + 1), index.getX(t + 2));
    else tri(t, t + 1, t + 2);
  }
  return { volume: Math.abs(vol), area };
}

/** A part's single surface colour as #rrggbb, or undefined for multi-material. */
export function meshColor(mesh: THREE.Mesh): string | undefined {
  const mat = mesh.material;
  if (Array.isArray(mat)) return undefined; // per-face colours; no single value
  const c = (mat as THREE.MeshStandardMaterial).color;
  return c ? `#${c.getHexString()}` : undefined;
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Circumscribed circle of three points in 3D (centre + radius), or null if the
 * points are (near-)collinear. Used to estimate a hole's radius/diameter from
 * three picks on its edge.
 */
export function circleFrom3Points(
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  p3: THREE.Vector3,
): { center: THREE.Vector3; radius: number } | null {
  const v1 = p2.clone().sub(p1);
  const v2 = p3.clone().sub(p1);
  const cross = v1.clone().cross(v2);
  const crossLenSq = cross.lengthSq();
  if (crossLenSq < 1e-12) return null; // collinear

  const v1Sq = v1.lengthSq();
  const v2Sq = v2.lengthSq();
  // Centre = p1 + (‖v1‖²·(v2×n) + ‖v2‖²·(n×v1)) / (2‖n‖²), n = v1×v2.
  const term = v2
    .clone()
    .multiplyScalar(v1Sq)
    .sub(v1.clone().multiplyScalar(v2Sq))
    .cross(cross)
    .divideScalar(2 * crossLenSq);
  const center = p1.clone().add(term);
  const radius = center.distanceTo(p1);
  return { center, radius };
}
