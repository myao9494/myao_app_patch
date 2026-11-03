import {
  Profile,
  QualityTier,
  DEFAULT_PROFILE,
  tiersForProfile,
} from "./viewer/params";
import { GeometryCache } from "./viewer/GeometryCache";

/** Persisted plugin settings. */
export interface StepViewerSettings {
  /** Selected performance profile, or "custom" when the tiers were hand-edited. */
  profile: Profile;
  /** Size→coarseness tiers actually used to pick mesh quality (source of truth). */
  tiers: QualityTier[];
  /** Cache parsed geometry so reopening a model is near-instant. */
  cacheEnabled: boolean;
  /** Cache size cap in MB (LRU-evicted). */
  cacheMaxMB: number;
  /**
   * Reconstruct planar faces the STEP reader failed to tessellate (parts that
   * would otherwise render as hollow, see-through "frames"). Only touches those
   * already-broken meshes; well-formed geometry is never modified.
   */
  healFaces: boolean;
}

export const DEFAULT_SETTINGS: StepViewerSettings = {
  profile: DEFAULT_PROFILE,
  tiers: tiersForProfile(DEFAULT_PROFILE),
  cacheEnabled: true,
  cacheMaxMB: 500,
  healFaces: true,
};

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof StepViewerSettings)[];

/**
 * data.json から設定のキーだけを取り出す。
 * data.json には注記（annotations）・寸法（measurements）も同居しているため、
 * それらを設定オブジェクトへ混ぜない（混ぜると保存時に古い内容で上書きしてしまう）。
 */
export function pickStoredSettings(data: unknown): Partial<StepViewerSettings> {
  if (!data || typeof data !== "object") return {};
  const source = data as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked as Partial<StepViewerSettings>;
}

/**
 * 最新の data.json の内容へ、設定のキーだけを書き戻す。
 * 注記・寸法など他のストアが管理するキーには触れない。
 */
export function writeSettingsToPluginData(
  data: Record<string, unknown>,
  settings: StepViewerSettings,
): void {
  for (const key of SETTING_KEYS) data[key] = settings[key];
}

/**
 * A plugin that carries STEP Viewer settings + the shared geometry cache (used
 * by the views/embeds). The property is `stepSettings`, not `settings`: Obsidian
 * 1.13 introduced an official `Plugin.settings`, and reusing that name collides.
 */
export interface HasStepSettings {
  stepSettings: StepViewerSettings;
  geometryCache: GeometryCache;
}
