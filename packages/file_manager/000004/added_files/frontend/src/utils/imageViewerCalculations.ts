/**
 * 画像ビューワーのズーム・パン・アスペクト比・ミニマップ等の幾何計算ユーティリティ
 * - calculateZoomScale: ホイールやボタン操作によるスケール計算およびクランプ
 * - calculateZoomOffset: ポインター（カーソル）位置を中心としたズーム後のオフセット計算
 * - calculatePanOffset: ドラッグ操作によるオフセット加算
 * - calculateActualSizeScale: 実寸（100%等倍）表示用のスケール算出
 * - formatAspectRatio: 幅と高さからアスペクト比文字列の生成
 * - calculateMinimapViewport: 拡大時のミニマップ内ビューポート枠計算
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface ZoomScaleOptions {
  minScale?: number;
  maxScale?: number;
}

const DEFAULT_MIN_SCALE = 0.1;
const DEFAULT_MAX_SCALE = 30.0;

/**
 * ズームスケールを計算してクランプする
 * @param currentScale 現在のスケール
 * @param input ホイールのdeltaY（数値）またはボタンアクション ('in' | 'out')
 * @param options minScale, maxScale オプション
 */
export function calculateZoomScale(
  currentScale: number,
  input: number | "in" | "out",
  options: ZoomScaleOptions = {}
): number {
  const minScale = options.minScale ?? DEFAULT_MIN_SCALE;
  const maxScale = options.maxScale ?? DEFAULT_MAX_SCALE;

  let nextScale: number;

  if (input === "in") {
    nextScale = currentScale * 1.25;
  } else if (input === "out") {
    nextScale = currentScale / 1.25;
  } else {
    // マウスホイール deltaY
    // 連続的で自然な指数変化
    const factor = Math.exp(-input * 0.002);
    nextScale = currentScale * factor;
  }

  // クランプ
  return Math.min(Math.max(nextScale, minScale), maxScale);
}

/**
 * カーソル（ポインター）位置を中心としたズーム後のオフセットを計算する
 * カーソル直下の画像のピクセルが、ズーム後も同じカーソル位置に留まるように移動する
 */
export function calculateZoomOffset(params: {
  cursor: Point;
  containerSize: Size;
  currentOffset: Point;
  currentScale: number;
  nextScale: number;
}): Point {
  const { cursor, containerSize, currentOffset, currentScale, nextScale } = params;

  if (currentScale <= 0) return currentOffset;

  // コンテナ中心からのカーソルの相対変位
  const dx = cursor.x - containerSize.width / 2;
  const dy = cursor.y - containerSize.height / 2;

  // ズーム比率
  const ratio = nextScale / currentScale;

  // 新オフセット計算: dx - (dx - currentOffset.x) * ratio
  const nextX = dx - (dx - currentOffset.x) * ratio;
  const nextY = dy - (dy - currentOffset.y) * ratio;

  return { x: nextX, y: nextY };
}

/**
 * ドラッグ移動量から新しいパンオフセットを計算する
 */
export function calculatePanOffset(
  currentOffset: Point,
  delta: { dx: number; dy: number }
): Point {
  return {
    x: currentOffset.x + delta.dx,
    y: currentOffset.y + delta.dy,
  };
}

/**
 * 画像の自然解像度と現在のレンダリングサイズから、100%実寸表示に必要なスケールを計算する
 */
export function calculateActualSizeScale(
  naturalSize: Size,
  renderedFitSize: Size
): number {
  if (
    !naturalSize.width ||
    !naturalSize.height ||
    !renderedFitSize.width ||
    !renderedFitSize.height
  ) {
    return 1.0;
  }

  return naturalSize.width / renderedFitSize.width;
}

const STANDARD_RATIOS: Array<{ ratio: number; label: string }> = [
  { ratio: 1 / 1, label: "1:1" },
  { ratio: 4 / 3, label: "4:3" },
  { ratio: 3 / 4, label: "3:4" },
  { ratio: 16 / 9, label: "16:9" },
  { ratio: 9 / 16, label: "9:16" },
  { ratio: 3 / 2, label: "3:2" },
  { ratio: 2 / 3, label: "2:3" },
  { ratio: 16 / 10, label: "16:10" },
  { ratio: 10 / 16, label: "10:16" },
  { ratio: 5 / 4, label: "5:4" },
  { ratio: 4 / 5, label: "4:5" },
  { ratio: 5 / 3, label: "5:3" },
  { ratio: 3 / 5, label: "3:5" },
  { ratio: 21 / 9, label: "21:9" },
  { ratio: 9 / 21, label: "9:21" },
];

/**
 * 幅と高さからアスペクト比文字列（例: "16:9", "4:3", "1:1", "1.43:1"）を返す
 */
export function formatAspectRatio(width: number, height: number): string {
  if (!width || !height || width <= 0 || height <= 0) {
    return "";
  }

  const currentRatio = width / height;

  // 既知の標準比率と照合（誤差 0.015 以内）
  for (const item of STANDARD_RATIOS) {
    if (Math.abs(currentRatio - item.ratio) < 0.015) {
      return item.label;
    }
  }

  return `${currentRatio.toFixed(2)}:1`;
}

/**
 * ミニマップ内のビューポート表示矩形（パーセント値）を計算する
 */
export interface MinimapViewportRect {
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
}

export function calculateMinimapViewport(params: {
  viewportSize: Size;
  contentSize: Size;
  scale: number;
  offset: Point;
}): MinimapViewportRect {
  const { contentSize, scale, offset } = params;

  if (scale <= 1.0 || contentSize.width <= 0 || contentSize.height <= 0) {
    return {
      leftPct: 0,
      topPct: 0,
      widthPct: 100,
      heightPct: 100,
    };
  }

  const widthPct = Math.min((1 / scale) * 100, 100);
  const heightPct = Math.min((1 / scale) * 100, 100);

  // コンテンツ基準での中心シフト量
  const shiftXPct = (offset.x / (contentSize.width * scale)) * 100;
  const shiftYPct = (offset.y / (contentSize.height * scale)) * 100;

  const leftPct = 50 - widthPct / 2 - shiftXPct;
  const topPct = 50 - heightPct / 2 - shiftYPct;

  return {
    leftPct: Math.max(0, Math.min(100 - widthPct, leftPct)),
    topPct: Math.max(0, Math.min(100 - heightPct, topPct)),
    widthPct,
    heightPct,
  };
}

/**
 * ミニマップ内のクリック位置（0〜100%）から、メインビューでその位置を中心に表示するためのオフセットを計算する
 */
export function calculateOffsetFromMinimapClick(params: {
  clickPct: Point;
  contentSize: Size;
  scale: number;
}): Point {
  const { clickPct, contentSize, scale } = params;

  if (scale <= 1.0 || contentSize.width <= 0 || contentSize.height <= 0) {
    return { x: 0, y: 0 };
  }

  // 中央(50%)からのズレ（割合）
  const deltaXPct = clickPct.x - 50;
  const deltaYPct = clickPct.y - 50;

  // オフセット計算（逆方向に移動）
  const offsetX = -(deltaXPct / 100) * contentSize.width * scale;
  const offsetY = -(deltaYPct / 100) * contentSize.height * scale;

  return { x: offsetX, y: offsetY };
}
