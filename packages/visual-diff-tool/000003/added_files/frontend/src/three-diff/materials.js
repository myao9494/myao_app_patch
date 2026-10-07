/**
 * 3Dメッシュ差分 シェーダーマテリアル仕様。
 * MeshStandardMaterial を onBeforeCompile で拡張し、
 * 頂点距離 (diffDistance) としきい値 (uThreshold) に応じたピクセル単位の色分けを行う。
 * - 変更なし部分: グレー (#94a3b8)
 * - 削除部分 (旧): 赤 (#ef4444)
 * - 追加部分 (新): 緑 (#22c55e)
 * - 重ね表示時、旧メッシュの変更なし部分を discard して Z-fighting を完全防止。
 * しきい値変更時は uniform を直接更新し、GPUバッファの再送なしで即時反映する。
 */

import * as THREE from "three";

export const COLOR_UNCHANGED = 0x94a3b8; // グレー
export const COLOR_ADDED = 0x22c55e;     // 緑
export const COLOR_DELETED = 0xef4444;   // 赤

export function createDiffMaterial({
  side = "new",
  threshold = 0.1,
  discardMatching = false,
  wireframe = false,
  opacity = 1.0,
}) {
  const diffColorHex = side === "new" ? COLOR_ADDED : COLOR_DELETED;
  const isTransparent = opacity < 0.999 || discardMatching;

  const material = new THREE.MeshStandardMaterial({
    roughness: 0.65,
    metalness: 0.08,
    side: THREE.DoubleSide,
    wireframe: wireframe,
    transparent: isTransparent,
    opacity: opacity,
  });

  material.userData.uniforms = {
    uThreshold: { value: threshold },
    uDiffColor: { value: new THREE.Color(diffColorHex) },
    uBaseColor: { value: new THREE.Color(COLOR_UNCHANGED) },
    uDiscardMatching: { value: discardMatching ? 1.0 : 0.0 },
    uCustomOpacity: { value: opacity },
  };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uThreshold = material.userData.uniforms.uThreshold;
    shader.uniforms.uDiffColor = material.userData.uniforms.uDiffColor;
    shader.uniforms.uBaseColor = material.userData.uniforms.uBaseColor;
    shader.uniforms.uDiscardMatching = material.userData.uniforms.uDiscardMatching;
    shader.uniforms.uCustomOpacity = material.userData.uniforms.uCustomOpacity;

    shader.vertexShader = `
      attribute float diffDistance;
      varying float vDiffDistance;
      ${shader.vertexShader}
    `.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
       vDiffDistance = diffDistance;`
    );

    shader.fragmentShader = `
      uniform float uThreshold;
      uniform vec3 uDiffColor;
      uniform vec3 uBaseColor;
      uniform float uDiscardMatching;
      uniform float uCustomOpacity;
      varying float vDiffDistance;
      ${shader.fragmentShader}
    `.replace(
      "#include <color_fragment>",
      `#include <color_fragment>
       float fw = fwidth(vDiffDistance);
       float edgeWidth = max(fw * 0.75, uThreshold * 0.015);
       float t = smoothstep(uThreshold - edgeWidth, uThreshold + edgeWidth, vDiffDistance);
       if (uDiscardMatching > 0.5 && t < 0.05) {
         discard;
       }
       vec3 diffRgb = mix(uBaseColor, uDiffColor, t);
       diffuseColor.rgb = diffRgb;
       diffuseColor.a *= uCustomOpacity * (uDiscardMatching > 0.5 ? clamp(t * 1.5, 0.0, 1.0) : 1.0);`
    );
  };

  return material;
}

export function updateMaterialUniforms(material, { threshold, discardMatching, opacity, wireframe }) {
  if (!material || !material.userData.uniforms) return;
  if (typeof threshold === "number") {
    material.userData.uniforms.uThreshold.value = threshold;
  }
  if (typeof discardMatching === "boolean") {
    material.userData.uniforms.uDiscardMatching.value = discardMatching ? 1.0 : 0.0;
  }
  if (typeof opacity === "number") {
    material.userData.uniforms.uCustomOpacity.value = opacity;
    material.opacity = opacity;
    material.transparent = opacity < 0.999 || material.userData.uniforms.uDiscardMatching.value > 0.5;
  }
  if (typeof wireframe === "boolean") {
    material.wireframe = wireframe;
  }
}
