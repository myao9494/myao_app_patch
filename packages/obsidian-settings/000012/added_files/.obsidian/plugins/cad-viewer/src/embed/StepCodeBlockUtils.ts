/**
 * STEPコードブロックのYAML解析・生成・Markdown本文更新ユーティリティ
 * 
 * 1. コードブロック内のYAML文字列をパースし、パス、高さ、視点、カメラ座標、断面設定、注記一覧を抽出
 * 2. 設定オブジェクトから整形式のYAML文字列を生成（可読性と保守性を確保）
 * 3. Markdownテキスト内から対象パスの```stepブロックを特定し、新しい設定値で自動置換・更新
 * 4. 複数配置時の個別ブロック特定・更新（行番号およびoriginalSourceによる分離、一斉同期の防止）
 * 5. コードブロックの注記（AnnotationConfig）とビューアの注記データ（StoredAnnotation）の相互変換
 **/

import * as yaml from "js-yaml";
import type { StoredAnnotation } from "../annotations/AnnotationStore";

export interface CameraConfig {
  position: [number, number, number];
  target: [number, number, number];
  zoom?: number;
}

export interface SectionConfig {
  enabled: boolean;
  axis: "x" | "y" | "z";
  offset: number;
  flipped?: boolean;
}

export interface AnnotationConfig {
  id: string;
  x: number;
  y: number;
  z: number;
  text: string;
  color?: string;
  textColor?: string;
  fontSize?: number | string;
  part?: string;
  ox?: number;
  oy?: number;
  leader?: boolean;
  link?: string;
}

/** 色が未指定の注記に使う既定のカテゴリ色（黄色）。 */
const DEFAULT_ANNOTATION_COLOR = "#ffc531";

/**
 * コードブロック（YAML）の注記を、ビューアの注記レイヤーが扱う形式へ変換する。
 * 文字色（textColor）・文字サイズ（fontSize）を含め、コードブロックに保存した項目をすべて引き継ぐ。
 */
export function annotationConfigToStored(a: AnnotationConfig): StoredAnnotation {
  return {
    id: a.id,
    x: a.x,
    y: a.y,
    z: a.z,
    text: a.text,
    color: a.color ?? DEFAULT_ANNOTATION_COLOR,
    textColor: a.textColor,
    fontSize: a.fontSize,
    part: a.part ?? "",
    ox: a.ox,
    oy: a.oy,
    leader: a.leader,
    link: a.link,
  };
}

/**
 * ビューアの注記を、コードブロック（YAML）へ保存する形式へ変換する。
 * hoverOnly などコードブロックに保存しない項目は含めない。
 */
export function storedAnnotationToConfig(a: StoredAnnotation): AnnotationConfig {
  return {
    id: a.id,
    x: a.x,
    y: a.y,
    z: a.z,
    text: a.text,
    color: a.color,
    textColor: a.textColor,
    fontSize: a.fontSize,
    part: a.part,
    ox: a.ox,
    oy: a.oy,
    leader: a.leader,
    link: a.link,
  };
}

/**
 * ビューアから保存する設定（視点・断面・注記）へ、ビューアが扱わない埋め込み設定を引き継ぐ。
 * 固定ボタンや注記の自動保存でコードブロックを書き換えても、表示サイズ（width / height）と
 * メッシュ品質（quality）の指定を失わないようにする。
 */
export function carryOverEmbedSettings(
  current: StepEmbedConfig,
  next: StepEmbedConfig,
  defaultHeight?: number,
): StepEmbedConfig {
  const merged: StepEmbedConfig = { ...next };
  if (current.width !== undefined) merged.width = current.width;
  const height = current.height ?? defaultHeight;
  if (height !== undefined) merged.height = height;
  if (merged.quality === undefined && current.quality !== undefined) merged.quality = current.quality;
  return merged;
}

export interface StepEmbedConfig {
  path: string;
  width?: number;
  height?: number;
  view?: string;
  roll?: number;
  quality?: string | number;
  showAnnotations?: boolean;
  locked?: boolean;
  camera?: CameraConfig;
  section?: SectionConfig;
  annotations?: AnnotationConfig[];
}

export const MIN_EMBED_WIDTH = 250;
export const MIN_EMBED_HEIGHT = 200;

/**
 * リサイズドラッグ時の埋め込みサイズを最小・最大制限値内にクランプする
 */
export function clampEmbedSize(
  targetWidth: number,
  targetHeight: number,
  maxWidth?: number,
): { width: number; height: number } {
  let w = Math.max(MIN_EMBED_WIDTH, Math.round(targetWidth));
  if (maxWidth !== undefined && maxWidth > MIN_EMBED_WIDTH) {
    w = Math.min(w, Math.round(maxWidth));
  }
  const h = Math.max(MIN_EMBED_HEIGHT, Math.round(targetHeight));
  return { width: w, height: h };
}

/**
 * コードブロック内のテキストをパースしてStepEmbedConfigオブジェクトを生成する
 */
export function parseStepCodeBlock(source: string): StepEmbedConfig {
  const trimmed = source.trim();
  if (!trimmed) {
    return { path: "" };
  }

  // まずYAMLとしてのパースを試行
  try {
    const parsed = yaml.load(trimmed) as any;
    if (parsed && typeof parsed === "object") {
      const config: StepEmbedConfig = {
        path: stripLink(String(parsed.path || "")),
      };

      if (parsed.width !== undefined) {
        const w = parseInt(String(parsed.width), 10);
        if (!Number.isNaN(w)) config.width = w;
      }
      if (parsed.height !== undefined) {
        const h = parseInt(String(parsed.height), 10);
        if (!Number.isNaN(h)) config.height = h;
      }
      if (parsed.view !== undefined) config.view = String(parsed.view);
      if (parsed.roll !== undefined) config.roll = parseInt(String(parsed.roll), 10);
      if (parsed.quality !== undefined) config.quality = parsed.quality;
      if (parsed.locked !== undefined) config.locked = !!parsed.locked;
      if (parsed.annotations !== undefined) {
        if (Array.isArray(parsed.annotations)) {
          config.annotations = parsed.annotations;
        } else if (typeof parsed.annotations === "boolean") {
          config.showAnnotations = parsed.annotations;
        }
      }
      if (parsed.camera && typeof parsed.camera === "object") {
        config.camera = {
          position: parsed.camera.position,
          target: parsed.camera.target,
          zoom: parsed.camera.zoom,
        };
      }
      if (parsed.section && typeof parsed.section === "object") {
        config.section = {
          enabled: !!parsed.section.enabled,
          axis: parsed.section.axis || "z",
          offset: typeof parsed.section.offset === "number" ? parsed.section.offset : 0.5,
          flipped: !!parsed.section.flipped,
        };
      }
      if (config.path) {
        return config;
      }
    }
  } catch (e) {
    // YAMLパース失敗時はフォールバック行パースへ進む
  }

  // フォールバック: 行ベースのパース（従来の形式との完全な後方互換性）
  const out: StepEmbedConfig = { path: "" };
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\w+)\s*:\s*(.+)$/.exec(line);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === "path") out.path = stripLink(val);
      else if (key === "width") {
        const w = parseInt(val, 10);
        if (!Number.isNaN(w)) out.width = w;
      } else if (key === "height") {
        const n = parseInt(val, 10);
        if (!Number.isNaN(n)) out.height = n;
      } else if (key === "view") out.view = val;
      else if (key === "roll") out.roll = parseInt(val, 10);
      else if (key === "locked") out.locked = val.toLowerCase() === "true";
    } else if (!out.path) {
      out.path = stripLink(line);
    }
  }
  return out;
}

/**
 * StepEmbedConfigオブジェクトをYAML形式の文字列にシリアライズする
 */
export function serializeStepCodeBlock(config: StepEmbedConfig): string {
  const obj: Record<string, any> = {
    path: config.path,
  };

  if (config.width !== undefined) obj.width = config.width;
  obj.height = config.height ?? 800;
  obj.view = config.view ?? "iso";

  if (config.roll !== undefined) obj.roll = config.roll;
  if (config.quality !== undefined) obj.quality = config.quality;
  if (config.locked !== undefined) obj.locked = config.locked;
  if (config.showAnnotations !== undefined && !config.annotations) {
    obj.annotations = config.showAnnotations;
  }



  if (config.camera) {
    obj.camera = {
      position: config.camera.position.map((v) => Number(v.toFixed(2))),
      target: config.camera.target.map((v) => Number(v.toFixed(2))),
    };
    if (config.camera.zoom !== undefined) {
      obj.camera.zoom = Number(config.camera.zoom.toFixed(2));
    }
  }

  if (config.section) {
    obj.section = {
      enabled: config.section.enabled,
      axis: config.section.axis,
      offset: Number(config.section.offset.toFixed(2)),
      flipped: !!config.section.flipped,
    };
  }

  if (config.annotations && config.annotations.length > 0) {
    obj.annotations = config.annotations.map((a) => ({
      id: a.id,
      x: Number(a.x.toFixed(2)),
      y: Number(a.y.toFixed(2)),
      z: Number(a.z.toFixed(2)),
      text: a.text,
      ...(a.color ? { color: a.color } : {}),
      ...(a.textColor ? { textColor: a.textColor } : {}),
      ...(a.fontSize !== undefined ? { fontSize: a.fontSize } : {}),
      ...(a.part ? { part: a.part } : {}),
      ...(a.ox !== undefined ? { ox: Number(a.ox.toFixed(1)) } : {}),
      ...(a.oy !== undefined ? { oy: Number(a.oy.toFixed(1)) } : {}),
      ...(a.leader !== undefined ? { leader: a.leader } : {}),
      ...(a.link ? { link: a.link } : {}),
    }));
  }

  return yaml.dump(obj, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
  }).trim();
}

/**
 * コードブロック更新時のブロック特定オプション
 */
export interface UpdateBlockOptions {
  /** 元のコードブロック文字列（中身） */
  originalSource?: string;
  /** Obsidianのctx.getSectionInfoから取得した行開始番号 (0-indexed) */
  lineStart?: number;
  /** Obsidianのctx.getSectionInfoから取得した行終了番号 (0-indexed) */
  lineEnd?: number;
}

/**
 * Markdownテキスト内の該当する```stepコードブロックを置換・更新する
 * 同一ノート内に複数のブロックがある場合でも、指定された特定のブロックのみを個別に更新する
 */
export function updateStepBlockInMarkdown(
  markdown: string,
  targetPath: string,
  newConfig: StepEmbedConfig,
  options?: UpdateBlockOptions,
): string {
  const normalizedTarget = normalizePath(targetPath);
  const newBlockYaml = serializeStepCodeBlock(newConfig);

  // 1. 行番号（lineStart, lineEnd）が指定されている場合: 該当行範囲をピンポイント置換
  if (
    options &&
    typeof options.lineStart === "number" &&
    typeof options.lineEnd === "number" &&
    options.lineStart >= 0 &&
    options.lineEnd >= options.lineStart
  ) {
    const lines = markdown.split("\n");
    if (options.lineEnd < lines.length) {
      const headerLine = lines[options.lineStart].trim();
      const footerLine = lines[options.lineEnd].trim();
      if (/^```(step|cad)/.test(headerLine) && footerLine === "```") {
        const tag = headerLine.replace(/^```/, "").trim() || "step";
        const replacementLines = [`\`\`\`${tag}`, newBlockYaml, "```"];
        lines.splice(
          options.lineStart,
          options.lineEnd - options.lineStart + 1,
          ...replacementLines,
        );
        return lines.join("\n");
      }
    }
  }

  // 2. originalSource が指定されている場合: 元の内容と完全一致する「1箇所のみ」を置換
  if (options?.originalSource) {
    const trimmedOriginal = options.originalSource.trim();
    const regex = /```(step|cad)\s*\n([\s\S]*?)```/g;
    let replaced = false;

    return markdown.replace(regex, (match, tag, blockContent) => {
      if (replaced) return match;
      if (blockContent.trim() === trimmedOriginal) {
        replaced = true;
        return `\`\`\`${tag}\n${newBlockYaml}\n\`\`\``;
      }
      return match;
    });
  }

  // 3. フォールバック: targetPath に一致する「最初の1箇所のみ」を置換（全ブロックの一斉書き換えを防止）
  const regex = /```(step|cad)\s*\n([\s\S]*?)```/g;
  let replaced = false;

  return markdown.replace(regex, (match, tag, blockContent) => {
    if (replaced) return match;
    const current = parseStepCodeBlock(blockContent);
    if (normalizePath(current.path) === normalizedTarget || !current.path) {
      replaced = true;
      return `\`\`\`${tag}\n${newBlockYaml}\n\`\`\``;
    }
    return match;
  });
}

function stripLink(v: string): string {
  return v.replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
}

function normalizePath(p: string): string {
  return stripLink(p).replace(/\\/g, "/").trim();
}
