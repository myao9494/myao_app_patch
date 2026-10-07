/**
 * 擬似ソリッド断面生成機能
 * 
 * 1. クリッピング平面（THREE.Plane）と3Dメッシュの交差ライン（交線）を幾何計算により抽出
 * 2. 抽出された線分を接続して閉曲線ループ（輪郭）を形成
 * 3. 各ループを切断面の2D局所座標系に射影し、三角形分割を行って断面キャップポリゴンを生成
 * 4. 斜線ハッチング用マテリアルおよびUV座標を付与し、オープンシェルや非完全多様体でもソリッド断面として描画
 **/

import * as THREE from "three";

/**
 * メッシュ配列とクリッピング平面から、切断面を塞ぐキャップジオメトリ（BufferGeometry）を生成する
 */
export function buildSectionCapGeometry(
  meshes: THREE.Mesh[],
  plane: THREE.Plane,
): THREE.BufferGeometry | null {
  const segments: { p1: THREE.Vector3; p2: THREE.Vector3 }[] = [];

  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();

  // 各メッシュの三角形と平面の交差線分を抽出
  for (const mesh of meshes) {
    if (!mesh.geometry) continue;
    const geom = mesh.geometry;
    const pos = geom.getAttribute("position");
    const idx = geom.getIndex();
    if (!pos) continue;

    mesh.updateMatrixWorld(true);
    const matrixWorld = mesh.matrixWorld;

    const triCount = idx ? idx.count / 3 : pos.count / 3;

    for (let t = 0; t < triCount; t++) {
      let iA = t * 3;
      let iB = t * 3 + 1;
      let iC = t * 3 + 2;

      if (idx) {
        iA = idx.getX(iA);
        iB = idx.getX(iB);
        iC = idx.getX(iC);
      }

      vA.fromBufferAttribute(pos, iA).applyMatrix4(matrixWorld);
      vB.fromBufferAttribute(pos, iB).applyMatrix4(matrixWorld);
      vC.fromBufferAttribute(pos, iC).applyMatrix4(matrixWorld);

      intersectTriangleWithPlane(vA, vB, vC, plane, segments);
    }
  }

  if (segments.length === 0) {
    return null;
  }

  // セグメントを閉ループに結合
  const loops = connectSegmentsIntoLoops(segments);
  if (loops.length === 0) {
    return null;
  }

  // 平面の基底ベクトル (u, v) を計算
  const normal = plane.normal.clone().normalize();
  let u = new THREE.Vector3(0, 1, 0).cross(normal);
  if (u.lengthSq() < 1e-4) {
    u = new THREE.Vector3(1, 0, 0).cross(normal);
  }
  u.normalize();
  const v = normal.clone().cross(u).normalize();

  const vertices: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];

  // 各ループを三角形分割
  for (const loop of loops) {
    if (loop.length < 3) continue;

    // 重心を計算
    const center = new THREE.Vector3();
    for (const pt of loop) center.add(pt);
    center.divideScalar(loop.length);

    // 扇状分割（Triangle Fan）
    for (let i = 0; i < loop.length; i++) {
      const p1 = loop[i];
      const p2 = loop[(i + 1) % loop.length];

      // 3頂点: center, p1, p2
      const tri = [center, p1, p2];

      // 法線向きの整合（plane.normalと合わせる）
      const edge1 = p1.clone().sub(center);
      const edge2 = p2.clone().sub(center);
      const cross = edge1.cross(edge2);
      if (cross.dot(normal) < 0) {
        tri[1] = p2;
        tri[2] = p1;
      }

      for (const p of tri) {
        vertices.push(p.x, p.y, p.z);
        normals.push(normal.x, normal.y, normal.z);
        // 切断面上のUV
        uvs.push(p.dot(u), p.dot(v));
      }
    }
  }

  if (vertices.length === 0) {
    return null;
  }

  const resultGeom = new THREE.BufferGeometry();
  resultGeom.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  resultGeom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  resultGeom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));

  return resultGeom;
}

/**
 * 1つの三角形と平面の交差線分を求める
 */
function intersectTriangleWithPlane(
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  plane: THREE.Plane,
  out: { p1: THREE.Vector3; p2: THREE.Vector3 }[],
): void {
  const dA = plane.distanceToPoint(a);
  const dB = plane.distanceToPoint(b);
  const dC = plane.distanceToPoint(c);

  const pts: THREE.Vector3[] = [];

  // 各辺の交点を計算
  if ((dA > 0 && dB < 0) || (dA < 0 && dB > 0)) {
    const t = dA / (dA - dB);
    pts.push(a.clone().lerp(b, t));
  }
  if ((dB > 0 && dC < 0) || (dB < 0 && dC > 0)) {
    const t = dB / (dB - dC);
    pts.push(b.clone().lerp(c, t));
  }
  if ((dC > 0 && dA < 0) || (dC < 0 && dA > 0)) {
    const t = dC / (dC - dA);
    pts.push(c.clone().lerp(a, t));
  }

  if (pts.length === 2) {
    out.push({ p1: pts[0], p2: pts[1] });
  }
}

/**
 * 線分配列から端点を接続して連続するループ配列を生成する
 */
function connectSegmentsIntoLoops(
  segments: { p1: THREE.Vector3; p2: THREE.Vector3 }[],
): THREE.Vector3[][] {
  const eps = 1e-3;
  const remaining = [...segments];
  const loops: THREE.Vector3[][] = [];

  while (remaining.length > 0) {
    const startSeg = remaining.pop()!;
    const currentLoop: THREE.Vector3[] = [startSeg.p1.clone(), startSeg.p2.clone()];

    let searching = true;
    while (searching) {
      searching = false;
      const last = currentLoop[currentLoop.length - 1];

      // 最初に戻ってループが閉じたか確認
      if (currentLoop.length >= 3 && last.distanceTo(currentLoop[0]) < eps) {
        currentLoop.pop(); // 終点重複を除去
        break;
      }

      // 次に繋がるセグメントを探索
      for (let i = 0; i < remaining.length; i++) {
        const seg = remaining[i];
        if (last.distanceTo(seg.p1) < eps) {
          currentLoop.push(seg.p2.clone());
          remaining.splice(i, 1);
          searching = true;
          break;
        } else if (last.distanceTo(seg.p2) < eps) {
          currentLoop.push(seg.p1.clone());
          remaining.splice(i, 1);
          searching = true;
          break;
        }
      }
    }

    // 閉じていない場合でも、端点同士を接続して閉ループ化（擬似ソリッド化）
    if (currentLoop.length >= 2) {
      // 始点と終点が異なる場合、端点を結んで閉じる
      loops.push(currentLoop);
    }
  }

  return loops;
}

/**
 * 断面ハッチング（斜線パターン）用マテリアルを作成する
 */
export function createPseudoSolidHatchMaterial(): THREE.MeshStandardMaterial {
  const canvas = activeDocument?.createElement("canvas") ?? createOffscreenCanvas(64, 64);
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#e0e0e0";
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = "#404040";
  ctx.lineWidth = 4;

  // 45度の斜線ハッチング
  for (let i = -64; i < 64; i += 16) {
    ctx.beginPath();
    ctx.moveTo(i, 64);
    ctx.lineTo(i + 64, 0);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(0.1, 0.1);

  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: texture,
    side: THREE.DoubleSide,
    roughness: 0.8,
    metalness: 0.1,
  });
}

function createOffscreenCanvas(w: number, h: number): HTMLCanvasElement {
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  return {
    width: w,
    height: h,
    getContext: () => ({
      fillStyle: "",
      fillRect: () => {},
      strokeStyle: "",
      lineWidth: 0,
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
    }),
  } as unknown as HTMLCanvasElement;
}
