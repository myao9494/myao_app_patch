/**
 * 3D中実ハッチング断面 (Section Plane) ユーティリティ仕様。
 * CADモデル（STEP）を任意の軸 (X/Y/Z) で切断し、
 * Three.js のクリッピング平面およびステンシルバッファ技法 (Stencil Buffer Cap) を用いて、
 * ソリッドの切り口が空洞化せず中身が詰まった中実断面として描画する。
 * - 45度斜線ハッチングテクスチャの動的Canvas生成（完全オフライン）
 * - ステンシル演算による自動中実キャップ生成 (BackFace / FrontFace Stencil)
 * - 軸切替 (X/Y/Z)、切断位置スライダー、反転 (Flip) 制御
 */

import * as THREE from "three";

/**
 * CAD標準の45度斜線ハッチングテクスチャをCanvasから生成する（完全オフライン）
 * @returns {THREE.CanvasTexture}
 */
export function createHatchTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  // 背景: 落ち着いたスレートダーク
  ctx.fillStyle = "#1e293b";
  ctx.fillRect(0, 0, size, size);

  // 45度斜線ストライプ
  ctx.strokeStyle = "#64748b";
  ctx.lineWidth = 2.5;

  const step = 8;
  for (let x = -size; x <= size * 2; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + size, size);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(15, 15);
  return texture;
}

/**
 * 指定された軸・位置・反転状態から切断平面 (THREE.Plane) を作成する
 * @param {"x" | "y" | "z"} axis - 切断軸
 * @param {number} position - 切断面の位置 (mm)
 * @param {boolean} flipped - 反転フラグ
 * @returns {THREE.Plane}
 */
export function createClippingPlane(axis = "x", position = 0, flipped = false) {
  let normal = new THREE.Vector3(1, 0, 0);
  if (axis === "y") normal = new THREE.Vector3(0, 1, 0);
  if (axis === "z") normal = new THREE.Vector3(0, 0, 1);

  if (flipped) {
    normal.negate();
    normal.x = normal.x === 0 ? 0 : normal.x;
    normal.y = normal.y === 0 ? 0 : normal.y;
    normal.z = normal.z === 0 ? 0 : normal.z;
    return new THREE.Plane(normal, position);
  }
  return new THREE.Plane(normal, -position);
}

/**
 * シーン内のメッシュに対して中実断面ステンシルキャップ群を構築する
 * @param {THREE.Scene} scene - 対象シーン
 * @param {THREE.Plane} clippingPlane - 切断平面
 * @param {THREE.Box3} boundingBox - モデルのバウンディングボックス
 * @param {THREE.Texture} hatchTexture - ハッチングテクスチャ
 * @returns {THREE.Group} ステンシルキャップおよび平面を含むグループ
 */
export function createSectionStencilGroup(scene, clippingPlane, boundingBox, hatchTexture) {
  const sectionGroup = new THREE.Group();
  sectionGroup.name = "section-stencil-group";

  // 切断面を覆うキャップ平面のサイズ
  const boxSize = boundingBox.getSize(new THREE.Vector3());
  const size = Math.max(boxSize.x, boxSize.y, boxSize.z, 50) * 2.5;
  const planeGeom = new THREE.PlaneGeometry(size, size);

  // キャップ平面マテリアル (ハッチング適用、ステンシル ≠ 0 の中実断面のみ描画)
  const capMat = new THREE.MeshBasicMaterial({
    map: hatchTexture,
    side: THREE.DoubleSide,
    depthWrite: true,
    depthTest: true,
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  });

  const capMesh = new THREE.Mesh(planeGeom, capMat);
  capMesh.name = "section-cap-plane";
  capMesh.renderOrder = 3;
  capMesh.frustumCulled = false;

  // モデルのバウンディングボックス中心を切断面へ垂直射影した位置へ配置
  const center = boundingBox.getCenter(new THREE.Vector3());
  const dist = clippingPlane.normal.dot(center) + clippingPlane.constant;
  const projCenter = center.clone().sub(clippingPlane.normal.clone().multiplyScalar(dist));

  capMesh.position.copy(projCenter);
  capMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), clippingPlane.normal);
  capMesh.updateMatrixWorld();

  capMesh.onBeforeRender = () => {
    // スライダー操作時に動的に位置・法線を同期
    const c = boundingBox.getCenter(new THREE.Vector3());
    const d = clippingPlane.normal.dot(c) + clippingPlane.constant;
    const p = c.clone().sub(clippingPlane.normal.clone().multiplyScalar(d));
    capMesh.position.copy(p);
    capMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), clippingPlane.normal);
  };
  sectionGroup.add(capMesh);

  // 対象メッシュを探索してステンシルパス用メッシュを作成
  scene.traverse((obj) => {
    if (obj.isMesh && obj.visible && obj.name !== "cad-edges" && obj.name !== "section-cap-plane") {
      // 1. バック面ステンシル (クリッピング平面奥の裏面をすべてインクリメント)
      const backMat = new THREE.MeshBasicMaterial({
        side: THREE.BackSide,
        clippingPlanes: [clippingPlane],
        depthWrite: false,
        depthTest: false,
        colorWrite: false,
        stencilWrite: true,
        stencilRef: 0,
        stencilFunc: THREE.AlwaysStencilFunc,
        stencilFail: THREE.IncrementWrapStencilOp,
        stencilZFail: THREE.IncrementWrapStencilOp,
        stencilZPass: THREE.IncrementWrapStencilOp,
      });
      const backMesh = new THREE.Mesh(obj.geometry, backMat);
      backMesh.position.copy(obj.position);
      backMesh.quaternion.copy(obj.quaternion);
      backMesh.scale.copy(obj.scale);
      backMesh.renderOrder = 1;
      sectionGroup.add(backMesh);

      // 2. フロント面ステンシル (クリッピング平面奥の表面をすべてデクリメント)
      const frontMat = new THREE.MeshBasicMaterial({
        side: THREE.FrontSide,
        clippingPlanes: [clippingPlane],
        depthWrite: false,
        depthTest: false,
        colorWrite: false,
        stencilWrite: true,
        stencilRef: 0,
        stencilFunc: THREE.AlwaysStencilFunc,
        stencilFail: THREE.DecrementWrapStencilOp,
        stencilZFail: THREE.DecrementWrapStencilOp,
        stencilZPass: THREE.DecrementWrapStencilOp,
      });
      const frontMesh = new THREE.Mesh(obj.geometry, frontMat);
      frontMesh.position.copy(obj.position);
      frontMesh.quaternion.copy(obj.quaternion);
      frontMesh.scale.copy(obj.scale);
      frontMesh.renderOrder = 2;
      sectionGroup.add(frontMesh);
    }
  });

  return sectionGroup;
}
