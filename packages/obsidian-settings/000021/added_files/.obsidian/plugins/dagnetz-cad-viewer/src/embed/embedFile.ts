/**
 * コードブロックが指す CAD ファイルと、メッシュの細かさの解決
 *
 * 1. `path:` の値（Wikilink の書き方、または Vault からのパス）をファイルへ解決する
 * 2. `quality:` の指定、なければ設定のファイルサイズ別の細かさからメッシュの細かさを決める
 * 3. ノートの埋め込み（StepEmbed）と印刷用の画像（printImage）で共通に使う
 **/

import { Plugin, TFile } from "obsidian";
import { HasStepSettings } from "../settings";
import { deflectionForSize, Profile, tiersForProfile } from "../viewer/params";

const EMBED_PROFILES = new Set<Profile>(["fastest", "balanced", "detailed"]);

export function resolveEmbedFile(plugin: Plugin, linktext: string, sourcePath: string): TFile | null {
  const dest = plugin.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
  if (dest instanceof TFile) return dest;
  const byPath = plugin.app.vault.getAbstractFileByPath(linktext);
  return byPath instanceof TFile ? byPath : null;
}

/**
 * Resolve the mesh coarseness for an embed: an explicit `quality:` override
 * (a profile name or a raw deflection number) wins, otherwise the global
 * size-based tiers apply.
 */
export function embedDeflection(
  plugin: HasStepSettings,
  quality: string | number | undefined,
  sizeBytes: number,
): number {
  if (typeof quality === "number") return quality;
  if (typeof quality === "string" && EMBED_PROFILES.has(quality as Profile)) {
    return deflectionForSize(sizeBytes, tiersForProfile(quality as Exclude<Profile, "custom">));
  }
  return deflectionForSize(sizeBytes, plugin.stepSettings.tiers);
}
