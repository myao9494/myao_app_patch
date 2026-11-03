/**
 * Markdown内の3D表示（Dagnetz CAD Viewer の ```step / ```cad）を画像にするときの、DOM・WebGLに依存しない計算。
 * - Git差分の一覧では、ノートの3D表示を表示モード "cad-view:<key>" として扱う
 *   （key はコードブロックの name。無ければ「#出現順」。HEADと作業ツリーの対応づけもこの key で行う）
 * - 画像の大きさ・注記の文字・折り返し・カメラの合わせ方はプラグインの印刷用画像（printLayout / LabelLayer）に合わせる
 */

export const CAD_VIEW_MODE_PREFIX = "cad-view:";
/** 幅の指定が無い埋め込みの幅・高さ（プラグインの PRINT_DEFAULT_WIDTH / HEIGHT）。 */
export const CAD_VIEW_DEFAULT_SIZE = { width: 700, height: 400 };
/** 印刷用画像と同じく、最低2倍の解像度で描く。 */
export const CAD_VIEW_PIXEL_RATIO = 2;
export const LABEL_MAX_WIDTH = 308;
export const LABEL_PADDING = 6;
export const LABEL_LINE_HEIGHT = 1.4;

const FONT_SIZES = { small: 12, medium: 14, large: 18, xlarge: 24 };
const DEFAULT_FONT_PX = 14;
const DEFAULT_TEXT_COLOR = "#111111";
const MAX_TEXT_LUMINANCE = 0.6; // これより明るい文字色は白い背景で読めない
const VIEW_DIRECTIONS = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
  iso: [1, 0.8, 1],
};

export function cadViewMode(key) {
  return `${CAD_VIEW_MODE_PREFIX}${key}`;
}

/** 表示モードが3D表示なら、その key を返す。それ以外は null。 */
export function cadViewKey(mode) {
  if (typeof mode !== "string" || !mode.startsWith(CAD_VIEW_MODE_PREFIX)) return null;
  return mode.slice(CAD_VIEW_MODE_PREFIX.length) || null;
}

/** 一覧などに出す名前。name があればそれ、無ければ出現順の番号。 */
export function cadViewTitle(view) {
  return view.name ? `3D表示「${view.name}」` : `3D表示 ${view.index + 1}`;
}

export function cadViewLabel(view) {
  return `${cadViewTitle(view)}${view.model ? `（${view.model}）` : ""}`;
}

/** key だけからの表示名（name が無いブロックの key は「#出現順」）。 */
export function cadViewTitleFromKey(key) {
  return key.startsWith("#") ? `3D表示 ${key.slice(1)}` : `3D表示「${key}」`;
}

export function cadViewSize(config) {
  return {
    width: config?.width ?? CAD_VIEW_DEFAULT_SIZE.width,
    height: config?.height ?? CAD_VIEW_DEFAULT_SIZE.height,
  };
}

/** 注記の文字サイズ（small / medium / large / xlarge、数値、"16px"）を px にする。 */
export function annotationFontPx(fontSize) {
  if (fontSize === undefined || fontSize === null || fontSize === "") return DEFAULT_FONT_PX;
  if (typeof fontSize === "number") return fontSize > 0 ? fontSize : DEFAULT_FONT_PX;
  const preset = FONT_SIZES[String(fontSize).trim()];
  if (preset) return preset;
  const px = parseFloat(fontSize);
  return px > 0 ? px : DEFAULT_FONT_PX;
}

/** 白い背景で読めない明るい文字色は、既定の黒に置き換える。 */
export function readablePrintColor(color) {
  if (!color) return DEFAULT_TEXT_COLOR;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim());
  if (!match) return String(color);
  const hex = match[1].length === 3 ? match[1].replace(/./g, "$&$&") : match[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > MAX_TEXT_LUMINANCE ? DEFAULT_TEXT_COLOR : String(color);
}

/** 注記の本文（Markdown）を、ビューアに表示される文字に近い形にする。 */
export function annotationCaption(text) {
  return String(text ?? "")
    .replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/!?\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|~~|`)(.+?)\1/g, "$2")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\s+$/, "");
}

/** 改行を保ったまま、maxWidth に収まるよう1文字単位で折り返す（プラグインの wrapPrintText と同じ）。 */
export function wrapPrintText(text, maxWidth, measure) {
  const lines = [];
  for (const paragraph of String(text).replace(/\s+$/, "").split("\n")) {
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

/**
 * 注記の札の位置（中心）。引出線があれば錨から ox / oy だけずらし、文字が切れないよう画像の中に収める。
 */
export function placeLabel(anchor, annotation, box, size) {
  const offset = annotation.leader ? { x: annotation.ox ?? 140, y: annotation.oy ?? -96 } : null;
  const x = anchor.x + (offset?.x ?? 0);
  const y = anchor.y + (offset?.y ?? 0);
  return {
    cx: Math.max(box.width / 2, Math.min(size.width - box.width / 2, x)),
    cy: Math.max(box.height / 2, Math.min(size.height - box.height / 2, y)),
    leader: Boolean(offset),
  };
}

/** 視点の名前（front / iso など）の向き。カメラの指定が無いブロックで使う。 */
export function viewDirection(view) {
  return VIEW_DIRECTIONS[view] ?? null;
}

/**
 * プラグインの fitCameraToObject と同じく、モデル全体が入る視野・カメラ位置を求める。
 * box は {min: [x, y, z], max: [x, y, z]}。
 */
export function fitCamera(box, aspect, perspective, fovDegrees = 45, offset = 1.3) {
  const size = box.max.map((value, i) => value - box.min[i]);
  const center = box.max.map((value, i) => (value + box.min[i]) / 2);
  const maxDim = Math.max(...size) || 1;
  const direction = normalize([1, 0.8, 1]);
  if (perspective) {
    const distance = (maxDim / 2 / Math.tan((fovDegrees * Math.PI) / 360)) * offset;
    return {
      center,
      position: center.map((value, i) => value + direction[i] * distance),
      near: Math.max(distance / 1000, 0.001),
      far: distance * 1000,
    };
  }
  const halfHeight = (maxDim / 2) * offset;
  const distance = maxDim * 3 + 1;
  return {
    center,
    position: center.map((value, i) => value + direction[i] * distance),
    halfHeight,
    halfWidth: halfHeight * aspect,
    near: 0.001,
    far: distance * 100,
  };
}

/**
 * 平行投影の拡大率。viewHeight（見えている高さ）があればそれを優先し、視野の大きさが違っても同じ表示にする。
 */
export function orthoZoom(camera, halfHeight) {
  if (camera?.viewHeight > 0) return (halfHeight * 2) / camera.viewHeight;
  return camera?.zoom > 0 ? camera.zoom : 1;
}

/** 断面の位置と向き。傾けた断面（point / tilt）が無ければ、軸の範囲の offset 割合の位置で切る。 */
export function sectionPlaneSpec(section, box) {
  if (!section?.enabled) return null;
  const axisIndex = { x: 0, y: 1, z: 2 }[section.axis] ?? 2;
  let normal = [0, 0, 0];
  let point;
  if (section.point && section.tilt) {
    normal = rotateByQuaternion([0, 0, 1], section.tilt);
    point = section.point;
  } else {
    normal[axisIndex] = 1;
    point = box.max.map((value, i) => (value + box.min[i]) / 2);
    const lo = box.min[axisIndex];
    point[axisIndex] = lo + (box.max[axisIndex] - lo) * (section.offset ?? 0.5);
  }
  normal = normalize(normal);
  if (section.flipped) normal = normal.map((value) => -value);
  // 距離 = n·p + constant が0以上の側を残す（Three.js のクリッピング平面と同じ）
  return { normal, constant: -dot(normal, point) };
}

function normalize(vector) {
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function rotateByQuaternion(vector, [x, y, z, w]) {
  const [vx, vy, vz] = vector;
  const ix = w * vx + y * vz - z * vy;
  const iy = w * vy + z * vx - x * vz;
  const iz = w * vz + x * vy - y * vx;
  const iw = -x * vx - y * vy - z * vz;
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}
