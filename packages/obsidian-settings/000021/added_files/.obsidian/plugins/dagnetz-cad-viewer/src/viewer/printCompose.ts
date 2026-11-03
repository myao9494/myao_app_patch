/**
 * 印刷用画像の合成
 *
 * 1. 白い背景の上に、モデル、注記と寸法の文字、座標軸を重ねて PNG にする
 * 2. 座標軸（X/Y/Z）は左下に描く。ビューアの ViewCube と同じくモデルの座標系で、90°回転にも追従する
 **/

import { LabelLayer } from "../ui/LabelLayer";
import { ViewerController } from "./ViewerController";
import { PRINT_MIN_PIXEL_RATIO, screenAxes } from "./printLayout";

const AXIS_MARGIN = 46;
const AXIS_LENGTH = 30;
const AXIS_LABEL_GAP = 11;

/** 座標軸を左下に描く（`h` は CSS px、`scale` は CSS px → canvas px）。 */
function drawAxes(
  ctx: CanvasRenderingContext2D,
  controller: ViewerController,
  h: number,
  scale: number,
): void {
  const axes = screenAxes(controller.getCamera().quaternion, controller.getModelQuaternion());
  const ox = AXIS_MARGIN * scale;
  const oy = (h - AXIS_MARGIN) * scale;
  ctx.save();
  ctx.lineWidth = 2 * scale;
  ctx.lineCap = "round";
  ctx.font = `bold ${Math.round(12 * scale)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const axis of axes) {
    ctx.strokeStyle = axis.color;
    ctx.fillStyle = axis.color;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox + axis.x * AXIS_LENGTH * scale, oy - axis.y * AXIS_LENGTH * scale);
    ctx.stroke();
    const labelDistance = (AXIS_LENGTH + AXIS_LABEL_GAP) * scale;
    ctx.fillText(axis.label, ox + axis.x * labelDistance, oy - axis.y * labelDistance);
  }
  ctx.restore();
}

/** 白い背景の上に、モデル・注記・座標軸を描いた PNG を作る（`w` `h` は CSS px）。 */
export function composePrintImage(
  controller: ViewerController,
  labelLayer: LabelLayer,
  w: number,
  h: number,
): string {
  const pixelRatio = Math.max(window.devicePixelRatio || 1, PRINT_MIN_PIXEL_RATIO);
  const model = controller.renderForPrint(pixelRatio);

  const canvas = activeDocument.createElement("canvas");
  canvas.width = Math.round(w * pixelRatio);
  canvas.height = Math.round(h * pixelRatio);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(model, 0, 0, canvas.width, canvas.height);
  labelLayer.drawForPrint(ctx, controller.getCamera(), w, h, pixelRatio);
  drawAxes(ctx, controller, h, pixelRatio);
  return canvas.toDataURL("image/png");
}
