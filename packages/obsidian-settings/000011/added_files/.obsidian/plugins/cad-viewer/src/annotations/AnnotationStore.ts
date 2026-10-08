/**
 * 3Dモデル注記（アノテーション）永続化ストア仕様
 * 
 * - STEPファイルパスをキーとして各注記の3D座標・テキスト・色・文字色・フォントサイズ等を保存
 * - data.jsonへの安全なアトミック保存
 **/

import { Plugin } from "obsidian";
import { updatePluginData } from "./pluginData";

export interface StoredAnnotation {
  id: string;
  x: number;
  y: number;
  z: number; // anchor in model-local coordinates
  text: string;
  part?: string;
  /** Show the note only on mouse-over (collapsed to a dot otherwise). */
  hoverOnly?: boolean;
  /** Render the note off to the side with a leader line back to the anchor. */
  leader?: boolean;
  /** Leader offset from the anchor, in screen pixels (only used when leader). */
  ox?: number;
  oy?: number;
  /** Category colour (hex, e.g. "#e5484d"). Defaults to the first category. */
  color?: string;
  /** Text color (hex e.g. "#000000"). */
  textColor?: string;
  /** Font size in px or label (e.g. 14, 16, 20). */
  fontSize?: number | string;
  /** Optional Obsidian link target (wikilink text) opened from the note. */
  link?: string;
}

interface DataShape {
  annotations?: Record<string, StoredAnnotation[]>;
}

/**
 * Persists model annotations in the plugin's data.json, keyed by the STEP
 * file's vault path. Because the key is the file path, annotations are shared
 * between the full view and any note embed of the same model.
 *
 * We deliberately do not touch the .step file itself (design doc §1: no STEP
 * editing; the mesh is only an approximation of the real geometry).
 */
export class AnnotationStore {
  constructor(private plugin: Plugin) {}

  async get(path: string): Promise<StoredAnnotation[]> {
    const data = (await this.plugin.loadData()) as DataShape | null;
    return data?.annotations?.[path] ?? [];
  }

  async set(path: string, list: StoredAnnotation[]): Promise<void> {
    await updatePluginData(this.plugin, (raw) => {
      const data = raw as DataShape;
      data.annotations = data.annotations ?? {};
      if (list.length) data.annotations[path] = list;
      else delete data.annotations[path];
    });
  }
}
