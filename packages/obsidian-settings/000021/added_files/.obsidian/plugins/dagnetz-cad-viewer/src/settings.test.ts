/**
 * 仕様: プラグイン設定と data.json の読み書きテスト
 *
 * data.json は「設定」「注記（annotations）」「寸法（measurements）」が同居する。
 * - 読み込み: 設定のキーだけを取り出し、注記・寸法を設定オブジェクトへ混ぜないこと
 * - 保存: 設定のキーだけを書き戻し、注記・寸法など他のストアの最新データを上書きしないこと
 */

import test from "node:test";
import assert from "node:assert";
import { DEFAULT_SETTINGS, pickStoredSettings, writeSettingsToPluginData } from "./settings";

test("pickStoredSettings: 設定のキーだけを取り出し、注記・寸法は含めないこと", () => {
  const stored = {
    cacheEnabled: false,
    cacheMaxMB: 123,
    annotations: { "a.step": [{ id: "annot-1" }] },
    measurements: { "a.step": [{ id: "m-1" }] },
  };

  assert.deepStrictEqual(pickStoredSettings(stored), { cacheEnabled: false, cacheMaxMB: 123 });
});

test("pickStoredSettings: 未保存（null）や不正な値では空の設定を返すこと", () => {
  assert.deepStrictEqual(pickStoredSettings(null), {});
  assert.deepStrictEqual(pickStoredSettings(undefined), {});
  assert.deepStrictEqual(pickStoredSettings("broken"), {});
});

test("writeSettingsToPluginData: 設定を書き戻しても、最新の注記・寸法を保持すること", () => {
  // 起動後に追加された注記・寸法を含む、保存時点の data.json
  const latest: Record<string, unknown> = {
    cacheEnabled: true,
    annotations: { "a.step": [{ id: "annot-1" }, { id: "annot-2" }] },
    measurements: { "a.step": [{ id: "m-1" }] },
  };
  const settings = { ...DEFAULT_SETTINGS, cacheEnabled: false, cacheMaxMB: 50 };

  writeSettingsToPluginData(latest, settings);

  assert.strictEqual(latest.cacheEnabled, false);
  assert.strictEqual(latest.cacheMaxMB, 50);
  assert.deepStrictEqual(latest.annotations, { "a.step": [{ id: "annot-1" }, { id: "annot-2" }] });
  assert.deepStrictEqual(latest.measurements, { "a.step": [{ id: "m-1" }] });
});

test("読み込んだ設定を書き戻しても、設定以外のキーが増減しないこと", () => {
  const stored: Record<string, unknown> = { annotations: { "a.step": [] } };
  const settings = { ...DEFAULT_SETTINGS, ...pickStoredSettings(stored) };

  assert.deepStrictEqual(Object.keys(settings).sort(), Object.keys(DEFAULT_SETTINGS).sort());

  writeSettingsToPluginData(stored, settings);
  assert.deepStrictEqual(
    Object.keys(stored).sort(),
    [...Object.keys(DEFAULT_SETTINGS), "annotations"].sort(),
  );
});
