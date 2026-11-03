/**
 * 位置合わせの範囲指定（人が画像上で囲んだ「ここを合わせる」範囲）の共通処理。
 * - 範囲は補正前の元画像のピクセル座標で持つ（補正後のキャンバスとは原点が違うことがある）
 * - Git差分ではファイルごとに保持する（Markdown内のExcalidraw図は本文と別の表示として扱う）
 */

const MIN_REGION_SIDE = 16; // Backend が受け付ける範囲の最小辺（px）

/** ドラッグの始点・終点（画像ピクセル座標）から範囲を作る。小さすぎれば null を返す。 */
export function regionFromDrag(start, end, imageSize) {
  const clampX = (value) => Math.max(0, Math.min(imageSize.width, value));
  const clampY = (value) => Math.max(0, Math.min(imageSize.height, value));
  const x = Math.round(Math.min(clampX(start.x), clampX(end.x)));
  const y = Math.round(Math.min(clampY(start.y), clampY(end.y)));
  const width = Math.round(Math.abs(clampX(end.x) - clampX(start.x)));
  const height = Math.round(Math.abs(clampY(end.y) - clampY(start.y)));
  if (width < MIN_REGION_SIDE || height < MIN_REGION_SIDE) return null;
  return { x, y, width, height, label: "指定した範囲" };
}

/** Git差分の範囲指定を保持するキー（report のカードからも同じキーで引く）。 */
export function gitAnchorKey(path, view) {
  return `${path}#${view}`;
}

/** 範囲指定を /api/git/diff のリクエスト項目へ変換する。 */
export function anchorPayload(anchor) {
  if (!anchor?.region) return {};
  return {
    anchor_region: anchor.region,
    ...(anchor.regionB ? { anchor_region_b: anchor.regionB } : {}),
  };
}
