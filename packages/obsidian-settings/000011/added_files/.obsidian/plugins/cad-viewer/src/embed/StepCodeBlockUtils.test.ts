/**
 * STEPコードブロックのYAML解析・生成・Markdown本文置換機能のテスト仕様
 * 
 * 1. 従来のフラット構文および新規YAML構文（camera, section, annotations）の相互互換パース
 * 2. 設定オブジェクトからYAMLコードブロック文字列へのシリアライズ
 * 3. Markdownテキスト内の対象```stepコードブロックの自動更新・置換
 * 4. 同一ノート内に複数配置されたコードブロックの個別特定・単独更新（他ブロックへの波及防止）
 **/

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseStepCodeBlock,
  serializeStepCodeBlock,
  updateStepBlockInMarkdown,
  StepEmbedConfig,
} from "./StepCodeBlockUtils";

test("従来のシンプルなコードブロック構文を正しくパースできること", () => {
  const input = `
path: 01_data/2026/10/06/CBES (50kg to 2000kg).step
height: 800
view: iso
`;
  const result = parseStepCodeBlock(input);
  assert.equal(result.path, "01_data/2026/10/06/CBES (50kg to 2000kg).step");
  assert.equal(result.height, 800);
  assert.equal(result.view, "iso");
});

test("camera, section, annotationsを含む拡張YAML構文をパースできること", () => {
  const input = `
path: 01_data/2026/10/06/CBES (50kg to 2000kg).step
height: 600
view: custom
camera:
  position: [100.5, 50.2, -30.0]
  target: [0, 10, 0]
  zoom: 1.5
section:
  enabled: true
  axis: z
  offset: 0.4
  flipped: false
annotations:
  - id: annot-1
    x: 10
    y: 20
    z: 30
    text: "テスト注記"
    color: "#ffc531"
`;
  const result = parseStepCodeBlock(input);
  assert.equal(result.path, "01_data/2026/10/06/CBES (50kg to 2000kg).step");
  assert.equal(result.height, 600);
  assert.equal(result.view, "custom");
  assert.deepEqual(result.camera?.position, [100.5, 50.2, -30.0]);
  assert.deepEqual(result.camera?.target, [0, 10, 0]);
  assert.equal(result.camera?.zoom, 1.5);
  assert.equal(result.section?.enabled, true);
  assert.equal(result.section?.axis, "z");
  assert.equal(result.section?.offset, 0.4);
  assert.equal(result.annotations?.length, 1);
  assert.equal(result.annotations?.[0].text, "テスト注記");
});

test("StepEmbedConfigからYAMLコードブロック文字列を正しくシリアライズできること", () => {
  const config: StepEmbedConfig = {
    path: "01_data/2026/10/06/CBES.step",
    height: 800,
    view: "custom",
    camera: {
      position: [12, 34, 56],
      target: [0, 0, 0],
      zoom: 1.0,
    },
    section: {
      enabled: true,
      axis: "x",
      offset: 0.5,
      flipped: false,
    },
    annotations: [
      {
        id: "a1",
        x: 1,
        y: 2,
        z: 3,
        text: "メモ",
        color: "#3b82f6",
      },
    ],
  };

  const yamlStr = serializeStepCodeBlock(config);
  assert.match(yamlStr, /path: 01_data\/2026\/10\/06\/CBES\.step/);
  assert.match(yamlStr, /height: 800/);
  assert.match(yamlStr, /view: custom/);
  assert.match(yamlStr, /camera:/);
  assert.match(yamlStr, /section:/);
  assert.match(yamlStr, /annotations:/);

  // ラウンドトリップ検証
  const roundtrip = parseStepCodeBlock(yamlStr);
  assert.deepEqual(roundtrip, config);
});

test("Markdownテキスト内の該当する```stepコードブロックを置換・更新できること", () => {
  const markdown = `
# ノートのタイトル

一部のテキスト。

\`\`\`step
path: 01_data/2026/10/06/CBES (50kg to 2000kg).step
height: 800
view: iso
\`\`\`

後ろのテキスト。
`;

  const newConfig: StepEmbedConfig = {
    path: "01_data/2026/10/06/CBES (50kg to 2000kg).step",
    height: 800,
    view: "custom",
    camera: {
      position: [10, 20, 30],
      target: [0, 0, 0],
      zoom: 1,
    },
    section: {
      enabled: true,
      axis: "z",
      offset: 0.5,
      flipped: false,
    },
  };

  const updatedMarkdown = updateStepBlockInMarkdown(
    markdown,
    "01_data/2026/10/06/CBES (50kg to 2000kg).step",
    newConfig,
  );

  assert.match(updatedMarkdown, /# ノートのタイトル/);
  assert.match(updatedMarkdown, /後ろのテキスト。/);
  assert.match(updatedMarkdown, /view: custom/);
  assert.match(updatedMarkdown, /camera:/);
  assert.match(updatedMarkdown, /section:/);
});

test("locked: trueを含むコードブロックをパースおよびシリアライズできること", () => {
  const input = `
path: models/sample.step
height: 800
view: iso
locked: true
`;
  const parsed = parseStepCodeBlock(input);
  assert.equal(parsed.path, "models/sample.step");
  assert.equal(parsed.locked, true);

  const serialized = serializeStepCodeBlock(parsed);
  assert.match(serialized, /locked: true/);
});

test("widthとheightを含むコードブロックをパースおよびシリアライズできること", () => {
  const input = `
path: models/sample.step
width: 650
height: 500
view: iso
`;
  const parsed = parseStepCodeBlock(input);
  assert.equal(parsed.path, "models/sample.step");
  assert.equal(parsed.width, 650);
  assert.equal(parsed.height, 500);

  const serialized = serializeStepCodeBlock(parsed);
  assert.match(serialized, /width: 650/);
  assert.match(serialized, /height: 500/);
});

test("clampEmbedSizeで最小幅・最小高さ・最大幅の制限が正しく適用されること", () => {
  const { clampEmbedSize } = require("./StepCodeBlockUtils");
  // 最小サイズ未満の場合は最小値にクランプされる
  const small = clampEmbedSize(100, 80);
  assert.equal(small.width, 250);
  assert.equal(small.height, 200);

  // 正常範囲内のサイズはそのまま維持される
  const normal = clampEmbedSize(600, 450);
  assert.equal(normal.width, 600);
  assert.equal(normal.height, 450);

  // 親要素の最大幅を超える場合は最大幅にクランプされる
  const wide = clampEmbedSize(900, 500, 800);
  assert.equal(wide.width, 800);
  assert.equal(wide.height, 500);
});

test("複数配置されたコードブロックのうち、指定したコードブロックのみが個別に更新されること", () => {
  const markdown = `
# 複数のSTEPモデル

\`\`\`step
path: models/bracket_A.step
width: 500
height: 400
view: iso
\`\`\`

中間のテキスト

\`\`\`step
path: models/bracket_B.step
width: 600
height: 450
view: top
\`\`\`
`;

  const newConfigA: StepEmbedConfig = {
    path: "models/bracket_A.step",
    width: 700,
    height: 550,
    view: "iso",
  };

  const currentSourceA = `path: models/bracket_A.step\nwidth: 500\nheight: 400\nview: iso`;

  const updated = updateStepBlockInMarkdown(
    markdown,
    "models/bracket_A.step",
    newConfigA,
    { originalSource: currentSourceA },
  );

  // bracket_A は 700 / 550 に更新されていること
  assert.match(updated, /path: models\/bracket_A\.step[\s\S]*?width: 700[\s\S]*?height: 550/);
  // bracket_B は 600 / 450 のままであること（同期・変更されていないこと！）
  assert.match(updated, /path: models\/bracket_B\.step[\s\S]*?width: 600[\s\S]*?height: 450/);
});

test("同一ファイルが複数配置されている場合でも、対象ブロックのみが個別に更新されること", () => {
  const source1 = `path: models/same.step\nwidth: 400\nheight: 300\nview: front`;
  const source2 = `path: models/same.step\nwidth: 800\nheight: 600\nview: top`;

  const markdown = `
\`\`\`step
${source1}
\`\`\`

\`\`\`step
${source2}
\`\`\`
`;

  // 2つ目のブロックだけを更新する
  const newConfig2: StepEmbedConfig = {
    path: "models/same.step",
    width: 850,
    height: 650,
    view: "top",
  };

  const updated = updateStepBlockInMarkdown(
    markdown,
    "models/same.step",
    newConfig2,
    { originalSource: source2 },
  );

  // 1つ目のブロックは 400 / 300 のまま維持されていること
  assert.match(updated, /width: 400[\s\S]*?height: 300[\s\S]*?view: front/);
  // 2つ目のブロックのみ 850 / 650 に更新されていること
  assert.match(updated, /width: 850[\s\S]*?height: 650[\s\S]*?view: top/);
});

test("行番号（sectionInfo）が指定された場合、その行のブロックのみが確実に更新されること", () => {
  const markdown = [
    "# タイトル",
    "```step",
    "path: models/same.step",
    "width: 300",
    "height: 300",
    "```",
    "文章",
    "```step",
    "path: models/same.step",
    "width: 300",
    "height: 300",
    "```",
  ].join("\n");

  const newConfig: StepEmbedConfig = {
    path: "models/same.step",
    width: 777,
    height: 888,
  };

  // 2つ目のブロック（lineStart: 7, lineEnd: 11）を更新
  const updated = updateStepBlockInMarkdown(
    markdown,
    "models/same.step",
    newConfig,
    { lineStart: 7, lineEnd: 11 },
  );

  const lines = updated.split("\n");
  // 1つ目のブロックは width: 300 のまま
  assert.ok(lines.slice(1, 6).join("\n").includes("width: 300"));
  // 2つ目のブロックは width: 777 に更新されていること
  assert.ok(lines.slice(7).join("\n").includes("width: 777"));
});

test("textColorとfontSizeを含む注記のパースおよびシリアライズができること", () => {
  const yamlSource = `
path: models/bracket.step
annotations:
  - id: annot-color-size
    x: 10
    y: 20
    z: 30
    text: "重要確認事項"
    color: "#ffc531"
    textColor: "#000000"
    fontSize: 16
    leader: true
`;

  const parsed = parseStepCodeBlock(yamlSource);
  assert.ok(parsed.annotations);
  assert.equal(parsed.annotations.length, 1);
  const annot = parsed.annotations[0];
  assert.equal(annot.text, "重要確認事項");
  assert.equal(annot.textColor, "#000000");
  assert.equal(annot.fontSize, 16);

  const serialized = serializeStepCodeBlock(parsed);
  assert.match(serialized, /textColor:\s*["']?#000000["']?/);
  assert.match(serialized, /fontSize:\s*16/);
});



