/**
 * コードブロックの3D表示を、印刷用の画像（PNG）にする
 *
 * 1. HTML 出力・PDF 出力・印刷から呼ばれる（WebGL の canvas は HTML へ持ち出せないため画像にする）
 * 2. 画面外にビューアを1つ作り、コードブロックの視点・断面・注記を復元して描画する
 * 3. 大きさはコードブロックの幅・高さを踏襲する
 **/

import { Plugin } from "obsidian";
import { OcctLoader } from "./OcctLoader";
import { loadNonStepModel } from "./loadNonStepModel";
import { mountModel, mountViewer, MountOptions, ViewerHandle } from "./mountViewer";
import { cacheKey, CACHE_MIN_BYTES } from "./GeometryCache";
import { hasRenderableMeshes } from "./StepToThree";
import { paramsForDeflection } from "./params";
import { printSize } from "./printLayout";
import { embedDeflection, resolveEmbedFile } from "../embed/embedFile";
import { parseStepCodeBlock } from "../embed/StepCodeBlockUtils";
import { HasStepSettings } from "../settings";

export interface PrintImage {
  dataUrl: string;
  width: number;
  height: number;
}

type PrintPlugin = Plugin & HasStepSettings;

/** 埋め込みと同じ手順でファイルを読み、ビューアを `host` に作る。 */
async function mountForPrint(
  plugin: PrintPlugin,
  host: HTMLElement,
  source: string,
  sourcePath: string,
): Promise<ViewerHandle> {
  const config = parseStepCodeBlock(source);
  const file = resolveEmbedFile(plugin, config.path, sourcePath);
  if (!file) throw new Error(`CAD file not found: ${config.path}`);

  const options: MountOptions = {
    plugin,
    filePath: file.path,
    showAnnotations: config.showAnnotations,
    initialView: config.view,
    initialRoll: config.roll,
    initialCamera: config.camera,
    initialSection: config.section,
    initialAnnotations: config.annotations,
    healFaces: plugin.stepSettings.healFaces,
  };

  const deflection = embedDeflection(plugin, config.quality, file.stat.size);
  const model = await loadNonStepModel(plugin.app, file, deflection);
  if (model) return mountModel(host, model, options);

  const settings = plugin.stepSettings;
  if (settings.cacheEnabled && file.stat.size >= CACHE_MIN_BYTES) {
    const key = cacheKey(file.path, file.stat.mtime, file.stat.size, deflection);
    const cached = await plugin.geometryCache.get(key);
    if (cached && hasRenderableMeshes(cached)) return mountViewer(host, cached, options);
  }

  const bytes = new Uint8Array(await plugin.app.vault.readBinary(file));
  const { result } = await OcctLoader.parseStep(bytes, paramsForDeflection(deflection));
  if (!hasRenderableMeshes(result)) throw new Error(`No usable geometry: ${file.path}`);
  return mountViewer(host, result, options);
}

/** ```step / ```cad コードブロックの中身から、印刷用の画像を作る。 */
export async function renderPrintImage(
  plugin: PrintPlugin,
  source: string,
  sourcePath: string,
): Promise<PrintImage> {
  const size = printSize(parseStepCodeBlock(source));

  // 埋め込みと同じ大きさで描くため、実際の大きさを持つ要素を画面外に置く
  const host = activeDocument.body.createDiv({ cls: "step-viewer-embed step-viewer-print-host" });
  host.style.position = "fixed";
  host.style.left = "-100000px";
  host.style.top = "0";
  host.style.width = `${size.width}px`;
  host.style.height = `${size.height}px`;

  let viewer: ViewerHandle | null = null;
  try {
    viewer = await mountForPrint(plugin, host, source, sourcePath);
    return { dataUrl: await viewer.capturePrintImage(), ...size };
  } finally {
    viewer?.dispose();
    host.remove();
  }
}
