/**
 * 印刷用画像のレイアウト計算（DOM・WebGL に依存しない部分）
 *
 * 1. コードブロックの幅・高さから画像の大きさを決める（幅の指定が無いときはノートの本文幅）
 * 2. 白い背景で読めない文字色を、読める色へ置き換える
 * 3. 注記の文字を、ビューアの注記カードと同じ幅で折り返す
 * 4. モデルの座標軸（X/Y/Z）が画面上で向く方向を求める
 **/

import * as THREE from "three";

/** 幅の指定が無い埋め込みの幅（Obsidian の読みやすい行幅）。 */
export const PRINT_DEFAULT_WIDTH = 700;
export const PRINT_DEFAULT_HEIGHT = 400;
/** 画面の解像度が低くても、印刷で粗くならないよう最低2倍で描く。 */
export const PRINT_MIN_PIXEL_RATIO = 2;

const DEFAULT_TEXT_COLOR = "#111111";
/** これより明るい文字色は白い背景で読めない。 */
const MAX_TEXT_LUMINANCE = 0.6;

const AXES = [
  { label: "X", color: "#e5484d", dir: new THREE.Vector3(1, 0, 0) },
  { label: "Y", color: "#30a46c", dir: new THREE.Vector3(0, 1, 0) },
  { label: "Z", color: "#3b82f6", dir: new THREE.Vector3(0, 0, 1) },
];

export interface PrintSize {
  width: number;
  height: number;
}

export interface ScreenAxis {
  label: string;
  color: string;
  /** 画面上の向き（右が +x、上が +y。長さは 0〜1）。 */
  x: number;
  y: number;
  /** 手前へ向く大きさ。奥の軸から順に描くために使う。 */
  depth: number;
}

export function printSize(config: { width?: number; height?: number }): PrintSize {
  return {
    width: config.width ?? PRINT_DEFAULT_WIDTH,
    height: config.height ?? PRINT_DEFAULT_HEIGHT,
  };
}

/** `#rgb` / `#rrggbb` の明るさ（0〜1）。それ以外の書き方は null。 */
function hexLuminance(color: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function readablePrintColor(color: string | undefined): string {
  if (!color) return DEFAULT_TEXT_COLOR;
  const luminance = hexLuminance(color);
  return luminance !== null && luminance > MAX_TEXT_LUMINANCE ? DEFAULT_TEXT_COLOR : color;
}

/** 改行を保ったまま、`maxWidth` に収まるよう1文字単位で折り返す（ビューアの word-break: break-word 相当）。 */
export function wrapPrintText(
  text: string,
  maxWidth: number,
  measure: (line: string) => number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\s+$/, "").split("\n")) {
    let line = "";
    for (const ch of paragraph) {
      if (line && measure(line + ch) > maxWidth) {
        lines.push(line);
        line = "";
      }
      line += ch;
    }
    lines.push(line);
  }
  return lines;
}

/** モデルの X/Y/Z 軸が画面上で向く方向を、奥の軸から順に返す。 */
export function screenAxes(
  cameraQuaternion: THREE.Quaternion,
  modelQuaternion: THREE.Quaternion,
): ScreenAxis[] {
  const toCamera = cameraQuaternion.clone().invert();
  return AXES.map(({ label, color, dir }) => {
    const v = dir.clone().applyQuaternion(modelQuaternion).applyQuaternion(toCamera);
    return { label, color, x: v.x, y: v.y, depth: v.z };
  }).sort((a, b) => a.depth - b.depth);
}
