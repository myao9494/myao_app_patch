/**
 * 仕様: CAD Viewer の機能をまたぐ統合テスト
 *
 * 個々のモジュールの単体テストでは見つからない、機能のつなぎ目の不具合を検出する。
 * ノートの本文と data.json はテスト内で用意し、保管庫の実データには依存しない。
 *
 * 1. ドロップ → コードブロック挿入 → 読み込み
 * 2. 固定（ロック）: 視点・断面・注記の保存と、width / height / quality の引き継ぎ
 * 3. 注記: コードブロック ↔ ビューアの相互変換、自動保存の判定とタイミング
 * 4. 複数配置: 同じファイル・別ファイルのブロックが互いに影響しない
 * 5. リサイズ: 最小・最大サイズの制限と、対象ブロックだけへの保存
 * 6. ファイルの移動・改名: コードブロックのパスと data.json の付け替え
 * 7. 擬似ソリッド断面: 閉じた形・開いた形・傾いた断面・交差しない断面
 * 8. 寸法測定: 円と直線の優先順位、遠いクリックの無視
 * 9. 設定の保存が注記・寸法を壊さない
 * 10. HTML / PDF 出力の大きさ・文字色・折り返し
 **/

import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  annotationConfigToStored,
  carryOverEmbedSettings,
  clampEmbedSize,
  moveCadFileData,
  parseStepCodeBlock,
  replaceCadPathInMarkdown,
  serializeStepCodeBlock,
  storedAnnotationToConfig,
  updateStepBlockInMarkdown,
  MIN_EMBED_HEIGHT,
  MIN_EMBED_WIDTH,
  type AnnotationConfig,
  type StepEmbedConfig,
} from "./embed/StepCodeBlockUtils";
import {
  AnnotationAutoSaver,
  ANNOTATION_AUTOSAVE_DELAY_MS,
  shouldAutoSaveAnnotations,
  type AutoSaveTimers,
} from "./embed/annotationAutoSave";
import { buildCadCodeBlock, extractCadPathFromDropData, isCadFile } from "./dropHandler";
import { buildSectionCapGeometry } from "./viewer/PseudoSolidSection";
import { pickGeometryMeasurement, type CircleFeatureData } from "./viewer/edgeMeasurement";
import { printSize, readablePrintColor, wrapPrintText } from "./viewer/printLayout";
import { DEFAULT_SETTINGS, pickStoredSettings, writeSettingsToPluginData } from "./settings";

// ---------------------------------------------------------------------------
// テスト用の補助
// ---------------------------------------------------------------------------

const CBES = "01_data/2026/10/06/CBES (50kg to 2000kg).step";
const BRACKET = "01_data/2026/10/06/bracket.stl";

/** ノート本文から ```step / ```cad ブロックの中身を順に取り出す */
function extractBlocks(markdown: string): StepEmbedConfig[] {
  const blocks: StepEmbedConfig[] = [];
  const re = /^```(?:step|cad)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
  for (let m = re.exec(markdown); m; m = re.exec(markdown)) blocks.push(parseStepCodeBlock(m[1]));
  return blocks;
}

/** 行番号（0始まり）で、ブロックの開始行と終了行を探す。ctx.getSectionInfo の代わり */
function findBlockLines(markdown: string, index: number): { lineStart: number; lineEnd: number } {
  const lines = markdown.split("\n");
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^```(step|cad)\s*$/.test(lines[i])) continue;
    found++;
    if (found !== index) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === "```") return { lineStart: i, lineEnd: j };
    }
  }
  throw new Error(`ブロック ${index} が見つかりません`);
}

function sampleAnnotation(overrides: Partial<AnnotationConfig> = {}): AnnotationConfig {
  return {
    id: "annot-1",
    x: 23.62,
    y: -30.6,
    z: 17.33,
    text: "ロードセル受圧部",
    color: "#ffc531",
    textColor: "#000000",
    fontSize: 16,
    part: "Component1",
    ox: 140,
    oy: -96,
    leader: true,
    ...overrides,
  };
}

function sampleLockedConfig(path = CBES): StepEmbedConfig {
  return {
    path,
    height: 800,
    view: "custom",
    locked: true,
    camera: { position: [150.2, 80.5, -120.3], target: [10, 5, 0], zoom: 1.25 },
    section: { enabled: true, axis: "z", offset: 0.45, flipped: false },
    annotations: [sampleAnnotation()],
  };
}

/** 時間を手動で進められるタイマー（AnnotationAutoSaver に渡す） */
function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: AutoSaveTimers = {
    set(fn, ms) {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    get pendingCount() {
      return pending.size;
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now && pending.has(id)) {
          pending.delete(id);
          t.fn();
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 1. ドロップ → コードブロック挿入 → 読み込み
// ---------------------------------------------------------------------------

test("ドロップ: 対応する5種類の拡張子だけをCADファイルと判定すること（大文字小文字は区別しない）", () => {
  for (const name of ["a.step", "a.STP", "a.FCStd", "a.obj", "a.stl"]) {
    assert.equal(isCadFile(name), true, name);
  }
  for (const name of ["a.png", "a.md", "a.step.bak", "step", ""]) {
    assert.equal(isCadFile(name), false, name);
  }
});

test("ドロップ: Obsidian が挿入するリンク記法からCADファイルのパスを取り出せること", () => {
  assert.equal(extractCadPathFromDropData(`[[${CBES}]]`), CBES);
  assert.equal(extractCadPathFromDropData(`![[${CBES}]]`), CBES);
  assert.equal(extractCadPathFromDropData(`[[${CBES}|別名]]`), CBES);
  assert.equal(extractCadPathFromDropData(CBES), CBES);
  assert.equal(extractCadPathFromDropData("[[画像.png]]"), null);
  assert.equal(extractCadPathFromDropData(""), null);
});

test("ドロップ: 生成したコードブロックをノートに入れて読み戻すと、既定の高さ・視点になること", () => {
  const note = `# 図面\n\n${buildCadCodeBlock(CBES, 800, "iso")}\n本文\n`;
  const blocks = extractBlocks(note);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { path: CBES, height: 800, view: "iso" });
});

test("ドロップ: 括弧やコロンを含む名前でも、コードブロックを読み戻すと同じパスになること", () => {
  for (const path of [CBES, "01_data/note: メモ.step", "01_data/#1 部品.stp", "- 先頭がハイフン.obj"]) {
    const [block] = extractBlocks(buildCadCodeBlock(path));
    assert.equal(block.path, path);
  }
});

test("ドロップ: ```cad でも ```step と同じ設定として読み込めること", () => {
  const note = "```cad\npath: a.step\nheight: 500\nview: front\n```\n";
  assert.deepEqual(extractBlocks(note), [{ path: "a.step", height: 500, view: "front" }]);
});

test("読み込み: 古い書き方（パスだけ、[[リンク]]）も読めること", () => {
  assert.equal(parseStepCodeBlock("a.step").path, "a.step");
  assert.equal(parseStepCodeBlock("[[a.step]]").path, "a.step");
  assert.equal(parseStepCodeBlock("path: [[a.step]]\nheight: 300").path, "a.step");
  assert.equal(parseStepCodeBlock("").path, "");
});

// ---------------------------------------------------------------------------
// 2. 固定（ロック）
// ---------------------------------------------------------------------------

test("固定: 視点・断面・注記・ロック状態をノートへ保存し、そのまま復元できること", () => {
  const original = `# 検討\n\n${buildCadCodeBlock(CBES)}\n以上\n`;
  const config = sampleLockedConfig();

  const updated = updateStepBlockInMarkdown(original, CBES, config);
  const [restored] = extractBlocks(updated);

  assert.equal(restored.locked, true);
  assert.equal(restored.view, "custom");
  assert.deepEqual(restored.camera?.position, [150.2, 80.5, -120.3]);
  assert.deepEqual(restored.camera?.target, [10, 5, 0]);
  assert.equal(restored.camera?.zoom, 1.25);
  assert.deepEqual(restored.section, { enabled: true, axis: "z", offset: 0.45, flipped: false });
  assert.deepEqual(restored.annotations, [sampleAnnotation()]);
  // ブロックの外の本文は変わらない
  assert.ok(updated.startsWith("# 検討\n\n```step\n"));
  assert.ok(updated.endsWith("```\n\n以上\n"));
});

test("固定: 保存を繰り返しても内容が変わらないこと（読み込み → 保存 → 読み込みが同じ）", () => {
  const config = sampleLockedConfig();
  const first = serializeStepCodeBlock(config);
  const second = serializeStepCodeBlock(parseStepCodeBlock(first));
  assert.equal(second, first);
});

test("固定: カメラの細かな状態（投影・モデルの回転）と傾けた断面も復元できること", () => {
  const config: StepEmbedConfig = {
    path: CBES,
    view: "custom",
    locked: true,
    camera: {
      position: [1, 2, 3],
      target: [0, 0, 0],
      zoom: 1,
      viewHeight: 120.5,
      perspective: true,
      modelPosition: [1, 2, 3],
      modelRotation: [0, 0.707107, 0, 0.707107],
    },
    section: {
      enabled: true,
      axis: "x",
      offset: 0.3,
      flipped: true,
      point: [5, 6, 7],
      tilt: [0.1, 0.2, 0.3, 0.927362],
    },
  };
  const restored = parseStepCodeBlock(serializeStepCodeBlock(config));
  assert.equal(restored.camera?.perspective, true);
  assert.equal(restored.camera?.viewHeight, 120.5);
  assert.deepEqual(restored.camera?.modelPosition, [1, 2, 3]);
  assert.deepEqual(restored.camera?.modelRotation, [0, 0.707107, 0, 0.707107]);
  assert.deepEqual(restored.section?.point, [5, 6, 7]);
  assert.deepEqual(restored.section?.tilt, [0.1, 0.2, 0.3, 0.927362]);
  assert.equal(restored.section?.flipped, true);
});

test("固定: ビューアからの保存でも、width / height / quality を失わないこと", () => {
  const current: StepEmbedConfig = { path: CBES, width: 640, height: 480, quality: "high", view: "iso" };
  const fromViewer: StepEmbedConfig = { path: CBES, view: "custom", locked: true };

  const merged = carryOverEmbedSettings(current, fromViewer);
  const note = updateStepBlockInMarkdown(buildCadCodeBlock(CBES), CBES, merged);
  const [restored] = extractBlocks(note);

  assert.equal(restored.width, 640);
  assert.equal(restored.height, 480);
  assert.equal(restored.quality, "high");
  assert.equal(restored.locked, true);
});

test("固定: annotations: false（注記を隠す指定）は、注記があっても保存後に残ること", () => {
  const current: StepEmbedConfig = { path: CBES, showAnnotations: false };
  const merged = carryOverEmbedSettings(current, { path: CBES, view: "custom", annotations: [sampleAnnotation()] });
  const yamlText = serializeStepCodeBlock(merged);
  assert.match(yamlText, /^annotations: false$/m);
  assert.doesNotMatch(yamlText, /ロードセル/);
  assert.equal(parseStepCodeBlock(yamlText).showAnnotations, false);
});

test("固定: 高さの指定が無いブロックには、既定の高さだけを補うこと", () => {
  const merged = carryOverEmbedSettings({ path: CBES }, { path: CBES, view: "custom" }, 800);
  assert.equal(merged.height, 800);
  assert.equal(merged.width, undefined);
});

// ---------------------------------------------------------------------------
// 3. 注記
// ---------------------------------------------------------------------------

test("注記: コードブロック → ビューア → コードブロックで、全項目が失われないこと", () => {
  const original = sampleAnnotation({ link: "[[関連ノート]]", fontSize: "XL" });
  const roundTrip = storedAnnotationToConfig(annotationConfigToStored(original));
  assert.deepEqual(roundTrip, original);
});

test("注記: 色・パーツ名が未指定でもビューアで扱える既定値が入ること", () => {
  const stored = annotationConfigToStored({ id: "a", x: 0, y: 0, z: 0, text: "メモ" });
  assert.equal(stored.color, "#ffc531");
  assert.equal(stored.part, "");
});

test("注記: 複数の注記を保存すると順序・文字色・文字サイズ・引出線が保たれること", () => {
  const annotations = [
    sampleAnnotation({ id: "a1", text: "1つ目", textColor: "#ff0000", fontSize: 14 }),
    sampleAnnotation({ id: "a2", text: "2つ目\n二行目", textColor: "#0000ff", fontSize: 20, leader: false }),
    sampleAnnotation({ id: "a3", text: "引用符 \"と\" コロン: を含む", ox: -12.5, oy: 30 }),
  ];
  const restored = parseStepCodeBlock(serializeStepCodeBlock({ path: CBES, annotations }));
  assert.deepEqual(restored.annotations, annotations);
});

test("注記: 座標は小数第2位、引出線のずれは小数第1位に丸めて保存すること", () => {
  const [restored] = parseStepCodeBlock(
    serializeStepCodeBlock({
      path: CBES,
      annotations: [sampleAnnotation({ x: 1.23456, y: -9.87654, z: 0.004, ox: 10.26, oy: -3.04 })],
    }),
  ).annotations!;
  assert.equal(restored.x, 1.23);
  assert.equal(restored.y, -9.88);
  assert.equal(restored.z, 0);
  assert.equal(restored.ox, 10.3);
  assert.equal(restored.oy, -3);
});

test("自動保存: 固定も注記の保存もしていない埋め込みと、保存先の無いビューは対象外。固定か保存済みの注記があれば対象になること", () => {
  assert.equal(shouldAutoSaveAnnotations({ canSave: true, locked: false, codeBlockAnnotationCount: 0 }), false);
  assert.equal(shouldAutoSaveAnnotations({ canSave: false, locked: true, codeBlockAnnotationCount: 3 }), false);
  assert.equal(shouldAutoSaveAnnotations({ canSave: true, locked: true, codeBlockAnnotationCount: 0 }), true);
  assert.equal(shouldAutoSaveAnnotations({ canSave: true, locked: false, codeBlockAnnotationCount: 1 }), true);
});

test("自動保存: 連続した注記の編集が、最後の変更から0.6秒後に1回だけノートへ反映されること", () => {
  const fake = createFakeTimers();
  let note = buildCadCodeBlock(CBES);
  let saveCount = 0;
  const live = [sampleAnnotation({ text: "v0" })];

  const saver = new AnnotationAutoSaver({
    isEditing: () => false,
    save: () => {
      saveCount++;
      note = updateStepBlockInMarkdown(note, CBES, { path: CBES, view: "custom", locked: true, annotations: live });
    },
    timers: fake.timers,
  });

  live[0] = { ...live[0], text: "v1" };
  saver.notifyChanged();
  fake.advance(ANNOTATION_AUTOSAVE_DELAY_MS - 100);
  live[0] = { ...live[0], text: "v2" };
  saver.notifyChanged();
  fake.advance(ANNOTATION_AUTOSAVE_DELAY_MS - 100);
  assert.equal(saveCount, 0, "最後の変更から待ち時間が経つまでは保存しない");

  fake.advance(100);
  assert.equal(saveCount, 1);
  assert.equal(extractBlocks(note)[0].annotations?.[0].text, "v2");
  assert.equal(fake.pendingCount, 0);
});

test("自動保存: テキスト編集中は保存せず、編集を終えたら保存すること。破棄時は即座に保存すること", () => {
  const fake = createFakeTimers();
  let editing = true;
  let saveCount = 0;
  const saver = new AnnotationAutoSaver({
    isEditing: () => editing,
    save: () => {
      saveCount++;
    },
    timers: fake.timers,
  });

  saver.notifyChanged();
  fake.advance(ANNOTATION_AUTOSAVE_DELAY_MS * 3);
  assert.equal(saveCount, 0, "編集中は保存しない");
  assert.equal(saver.hasPending(), true);

  editing = false;
  fake.advance(ANNOTATION_AUTOSAVE_DELAY_MS);
  assert.equal(saveCount, 1);

  // ビューア破棄: 保留中の変更をその場で保存し、タイマーを残さない
  saver.notifyChanged();
  saver.flush();
  assert.equal(saveCount, 2);
  assert.equal(fake.pendingCount, 0);
});

// ---------------------------------------------------------------------------
// 4. 複数配置
// ---------------------------------------------------------------------------

function buildMultiBlockNote(): string {
  return [
    "# 複数配置",
    "",
    "```step",
    `path: ${CBES}`,
    "height: 800",
    "view: iso",
    "```",
    "",
    "途中の本文",
    "",
    "```step",
    `path: ${CBES}`,
    "height: 400",
    "view: front",
    "```",
    "",
    "```cad",
    `path: ${BRACKET}`,
    "height: 600",
    "view: top",
    "```",
    "",
  ].join("\n");
}

test("複数配置: 同じファイルの2つ目のブロックだけを、行番号で指定して更新できること", () => {
  const note = buildMultiBlockNote();
  const target = findBlockLines(note, 1);
  const updated = updateStepBlockInMarkdown(note, CBES, sampleLockedConfig(), target);

  const [first, second, third] = extractBlocks(updated);
  assert.deepEqual(first, { path: CBES, height: 800, view: "iso" });
  assert.equal(second.locked, true);
  assert.equal(second.annotations?.length, 1);
  assert.deepEqual(third, { path: BRACKET, height: 600, view: "top" });
});

test("複数配置: 行番号が無くても originalSource で、同じファイルの別ブロックを取り違えないこと", () => {
  const note = buildMultiBlockNote();
  const updated = updateStepBlockInMarkdown(
    note,
    CBES,
    { path: CBES, height: 400, view: "front", width: 500 },
    { originalSource: `path: ${CBES}\nheight: 400\nview: front` },
  );
  const [first, second] = extractBlocks(updated);
  assert.equal(first.width, undefined);
  assert.equal(second.width, 500);
});

test("複数配置: 別ファイルのブロック（```cad）を更新しても、他のブロックの記述が1文字も変わらないこと", () => {
  const note = buildMultiBlockNote();
  const target = findBlockLines(note, 2);
  const updated = updateStepBlockInMarkdown(note, BRACKET, { path: BRACKET, height: 650, view: "top" }, target);

  const before = note.split("\n");
  const after = updated.split("\n");
  for (let i = 0; i < target.lineStart; i++) assert.equal(after[i], before[i], `行 ${i}`);
  assert.equal(after[target.lineStart], "```cad", "ブロックの種類（cad）を保つこと");
  assert.match(updated, /height: 650/);
  assert.equal(extractBlocks(updated).length, 3);
});

test("複数配置: 行番号がずれて別の内容を指していても、ブロックでない行は書き換えないこと", () => {
  const note = buildMultiBlockNote();
  // 本文の行を指す不正な範囲。originalSource・パスでの探索にフォールバックする
  const updated = updateStepBlockInMarkdown(note, BRACKET, { path: BRACKET, height: 650, view: "top" }, {
    lineStart: 6,
    lineEnd: 7,
  });
  assert.ok(updated.includes("途中の本文"));
  assert.equal(extractBlocks(updated).length, 3);
  assert.equal(extractBlocks(updated)[2].height, 650);
  assert.equal(extractBlocks(updated)[0].height, 800);
});

test("複数配置: リストやコールアウトの中のブロックも、字下げと > を保って更新できること", () => {
  const list = `- 項目\n  \`\`\`step\n  path: ${CBES}\n  height: 800\n  \`\`\`\n`;
  const updatedList = updateStepBlockInMarkdown(list, CBES, { path: CBES, height: 300, view: "iso" });
  assert.match(updatedList, /^ {2}```step$/m);
  assert.match(updatedList, /^ {2}height: 300$/m);

  const callout = `> [!note]\n> \`\`\`step\n> path: ${CBES}\n> height: 800\n> \`\`\`\n`;
  const updatedCallout = updateStepBlockInMarkdown(callout, CBES, { path: CBES, height: 300, view: "iso" });
  assert.match(updatedCallout, /^> ```step$/m);
  assert.match(updatedCallout, /^> height: 300$/m);
});

test("複数配置: Windows の改行（CRLF）のノートでもブロックを更新できること", () => {
  const note = buildCadCodeBlock(CBES).replace(/\n/g, "\r\n");
  const updated = updateStepBlockInMarkdown(note, CBES, { path: CBES, height: 321, view: "iso" });
  assert.equal(extractBlocks(updated.replace(/\r/g, ""))[0].height, 321);
});

// ---------------------------------------------------------------------------
// 5. リサイズ
// ---------------------------------------------------------------------------

test("リサイズ: 小さすぎる・大きすぎるサイズは最小値・親要素の幅に収まること", () => {
  assert.deepEqual(clampEmbedSize(10, 10), { width: MIN_EMBED_WIDTH, height: MIN_EMBED_HEIGHT });
  assert.deepEqual(clampEmbedSize(2000, 900, 700), { width: 700, height: 900 });
  assert.deepEqual(clampEmbedSize(400.6, 300.4), { width: 401, height: 300 });
  // 親要素の幅が最小幅以下のときは、最小幅を優先する（潰さない）
  assert.equal(clampEmbedSize(100, 300, 200).width, MIN_EMBED_WIDTH);
});

test("リサイズ: 確定したサイズを、対象のブロックの width / height へだけ保存すること", () => {
  const note = buildMultiBlockNote();
  const size = clampEmbedSize(520, 330, 900);
  const target = findBlockLines(note, 0);
  const updated = updateStepBlockInMarkdown(note, CBES, { path: CBES, view: "iso", ...size }, target);

  const [first, second] = extractBlocks(updated);
  assert.equal(first.width, 520);
  assert.equal(first.height, 330);
  assert.equal(second.width, undefined);
  assert.equal(second.height, 400);
});

test("リサイズ: 固定済みのブロックをリサイズしても、視点・断面・注記・ロックが残ること", () => {
  const locked = updateStepBlockInMarkdown(buildCadCodeBlock(CBES), CBES, sampleLockedConfig());
  const [current] = extractBlocks(locked);
  const resized = updateStepBlockInMarkdown(locked, CBES, { ...current, ...clampEmbedSize(600, 500) });
  const [after] = extractBlocks(resized);

  assert.equal(after.width, 600);
  assert.equal(after.height, 500);
  assert.equal(after.locked, true);
  assert.deepEqual(after.camera?.position, current.camera?.position);
  assert.deepEqual(after.section, current.section);
  assert.deepEqual(after.annotations, current.annotations);
});

// ---------------------------------------------------------------------------
// 6. ファイルの移動・改名
// ---------------------------------------------------------------------------

test("移動: コードブロックのパスだけを書き換え、本文やほかの言語のコードブロックは変えないこと", () => {
  const moved = "02_archive/CBES.step";
  const note = [
    `本文に ${CBES} と書いてある`,
    "",
    "```step",
    `path: ${CBES}`,
    "height: 800",
    "```",
    "",
    "```python",
    `path: ${CBES}`,
    "```",
    "",
    "```cad",
    `path: ${BRACKET}`,
    "```",
    "",
  ].join("\n");

  const updated = replaceCadPathInMarkdown(note, CBES, moved);

  const lines = updated.split("\n");
  assert.equal(lines[0], `本文に ${CBES} と書いてある`);
  assert.equal(lines[3], `path: ${moved}`);
  assert.equal(lines[8], `path: ${CBES}`, "python のブロックは変えない");
  assert.equal(lines[12], `path: ${BRACKET}`, "別のファイルは変えない");
});

test("移動: 移動後のノートを読み込むと、新しいパスと他の設定が保たれていること", () => {
  const locked = updateStepBlockInMarkdown(buildCadCodeBlock(CBES), CBES, sampleLockedConfig());
  const moved = replaceCadPathInMarkdown(locked, CBES, "新フォルダ/#2 CBES.step");
  const [restored] = extractBlocks(moved);
  assert.equal(restored.path, "新フォルダ/#2 CBES.step");
  assert.equal(restored.locked, true);
  assert.equal(restored.annotations?.length, 1);
});

test("移動: ファイル名だけで書かれたブロックも、新しいパスへ付け替えられること", () => {
  const note = "```step\npath: bracket.stl\nheight: 300\n```\n";
  const updated = replaceCadPathInMarkdown(note, BRACKET, "02_archive/bracket.stl");
  assert.equal(extractBlocks(updated)[0].path, "02_archive/bracket.stl");
});

test("移動: data.json の注記・寸法が新しいパスへ移り、他のファイルのデータと設定は残ること", () => {
  const data: Record<string, unknown> = {
    cacheEnabled: false,
    annotations: { [CBES]: [{ id: "a1" }], [BRACKET]: [{ id: "b1" }] },
    measurements: { [CBES]: [{ id: "m1" }] },
  };
  moveCadFileData(data, CBES, "02_archive/CBES.step");

  assert.deepEqual(data.annotations, { "02_archive/CBES.step": [{ id: "a1" }], [BRACKET]: [{ id: "b1" }] });
  assert.deepEqual(data.measurements, { "02_archive/CBES.step": [{ id: "m1" }] });
  assert.equal(data.cacheEnabled, false);
});

test("移動: 注記も寸法も無いファイルを移動しても、data.json にキーを増やさないこと", () => {
  const data: Record<string, unknown> = { annotations: {} };
  moveCadFileData(data, CBES, "x.step");
  assert.deepEqual(data, { annotations: {} });
});

// ---------------------------------------------------------------------------
// 7. 擬似ソリッド断面
// ---------------------------------------------------------------------------

/** キャップの全頂点が平面上にあるか */
function allVerticesOnPlane(geom: THREE.BufferGeometry, plane: THREE.Plane, tolerance = 1e-4): boolean {
  const pos = geom.getAttribute("position");
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (Math.abs(plane.distanceToPoint(v)) > tolerance) return false;
  }
  return true;
}

/** キャップの面積（三角形の面積の合計） */
function capArea(geom: THREE.BufferGeometry): number {
  const pos = geom.getAttribute("position");
  const idx = geom.getIndex();
  const count = idx ? idx.count : pos.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let area = 0;
  for (let i = 0; i < count; i += 3) {
    const [ia, ib, ic] = idx ? [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)] : [i, i + 1, i + 2];
    a.fromBufferAttribute(pos, ia);
    b.fromBufferAttribute(pos, ib);
    c.fromBufferAttribute(pos, ic);
    area += new THREE.Triangle(a, b, c).getArea();
  }
  return area;
}

test("断面: 一辺2のボックスを中央で切ると、断面は面積4の四角形になり、頂点はすべて切断面上にあること", () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const cap = buildSectionCapGeometry([mesh], plane);

  assert.ok(cap);
  assert.ok(allVerticesOnPlane(cap, plane));
  assert.ok(Math.abs(capArea(cap) - 4) < 1e-3, `面積 ${capArea(cap)}`);
});

test("断面: 位置をずらしても（オフセット）、その位置の断面になること", () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  // z = 0.5 の面（法線 +Z、constant = -0.5）
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.5);
  const cap = buildSectionCapGeometry([mesh], plane);
  assert.ok(cap);
  assert.ok(allVerticesOnPlane(cap, plane));
  assert.ok(Math.abs(capArea(cap) - 4) < 1e-3);
});

test("断面: 傾けた断面でも、頂点がすべて切断面上にあること", () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4));
  const normal = new THREE.Vector3(1, 1, 1).normalize();
  const plane = new THREE.Plane(normal, 0);
  const cap = buildSectionCapGeometry([mesh], plane);
  assert.ok(cap);
  assert.ok(allVerticesOnPlane(cap, plane));
  assert.ok(capArea(cap) > 0);
});

test("断面: 開いた円筒（厚みの無いシェル）でも、円の面積に近い断面で塞がれること", () => {
  const radius = 20;
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 50, 64, 1, true));
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const cap = buildSectionCapGeometry([mesh], plane);

  assert.ok(cap);
  const circle = Math.PI * radius * radius;
  assert.ok(Math.abs(capArea(cap) - circle) / circle < 0.02, `面積 ${capArea(cap)} / 円 ${circle}`);
});

test("断面: 複数のメッシュ（部品）が切断面と交わるとき、それぞれを塞ぐこと", () => {
  const left = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  left.position.set(-5, 0, 0);
  const right = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  right.position.set(5, 0, 0);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const cap = buildSectionCapGeometry([left, right], plane);

  assert.ok(cap);
  assert.ok(Math.abs(capArea(cap) - 8) < 1e-2, `面積 ${capArea(cap)}`);
});

test("断面: メッシュの位置（ワールド行列）を反映して切ること", () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  mesh.position.set(0, 0, 10);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -10);
  const cap = buildSectionCapGeometry([mesh], plane);
  assert.ok(cap);
  assert.ok(allVerticesOnPlane(cap, plane));
});

test("断面: モデルと交わらない位置では、キャップを作らず null を返すこと", () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -100);
  assert.equal(buildSectionCapGeometry([mesh], plane), null);
});

test("断面: メッシュが空でも例外にならず null を返すこと", () => {
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  assert.equal(buildSectionCapGeometry([], plane), null);
  assert.equal(buildSectionCapGeometry([new THREE.Mesh(new THREE.BufferGeometry())], plane), null);
});

// ---------------------------------------------------------------------------
// 8. 寸法測定
// ---------------------------------------------------------------------------

test("寸法: 円のリムをクリックすると直径、直線をクリックすると長さが測定されること", () => {
  const circles: CircleFeatureData[] = [
    { center: new THREE.Vector3(0, 0, 0), radius: 10, normal: new THREE.Vector3(0, 0, 1) },
  ];
  const line = new THREE.BufferAttribute(new Float32Array([40, 0, 0, 90, 0, 0]), 3);

  const onCircle = pickGeometryMeasurement(new THREE.Vector3(10, 0.5, 0), circles, line, 2);
  assert.equal(onCircle?.type, "diameter");
  assert.equal(onCircle?.type === "diameter" ? onCircle.diameter : null, 20);

  const onLine = pickGeometryMeasurement(new THREE.Vector3(65, 1, 0), circles, line, 2);
  assert.equal(onLine?.type, "distance");
  assert.equal(onLine?.type === "distance" ? onLine.distance : null, 50);
});

test("寸法: どちらからも遠い場所のクリックは測定しないこと", () => {
  const circles: CircleFeatureData[] = [
    { center: new THREE.Vector3(0, 0, 0), radius: 10, normal: new THREE.Vector3(0, 0, 1) },
  ];
  const line = new THREE.BufferAttribute(new Float32Array([40, 0, 0, 90, 0, 0]), 3);
  assert.equal(pickGeometryMeasurement(new THREE.Vector3(0, 0, 0), circles, line, 2), null);
  assert.equal(pickGeometryMeasurement(new THREE.Vector3(0, 0, 0), [], undefined, 2), null);
});

test("寸法: メッシュを移動していても、ワールド座標で測定されること", () => {
  const line = new THREE.BufferAttribute(new Float32Array([0, 0, 0, 50, 0, 0]), 3);
  const matrix = new THREE.Matrix4().makeTranslation(100, 0, 0);
  const hit = pickGeometryMeasurement(new THREE.Vector3(125, 0.5, 0), [], line, 2, matrix);
  assert.equal(hit?.type, "distance");
  assert.equal(hit?.type === "distance" ? hit.distance : null, 50);
  // 移動前の位置をクリックしても当たらない
  assert.equal(pickGeometryMeasurement(new THREE.Vector3(25, 0.5, 0), [], line, 2, matrix), null);
});

// ---------------------------------------------------------------------------
// 9. 設定の保存
// ---------------------------------------------------------------------------

test("設定: 設定を変更して保存しても、コードブロック以外の保存先（注記・寸法）を壊さないこと", () => {
  // 起動後に注記と寸法が増えた data.json
  const data: Record<string, unknown> = {
    cacheEnabled: true,
    annotations: { [CBES]: [{ id: "a1" }, { id: "a2" }] },
    measurements: { [CBES]: [{ id: "m1" }] },
  };
  const loaded = { ...DEFAULT_SETTINGS, ...pickStoredSettings(data) };
  const changed = { ...loaded, cacheEnabled: false };

  moveCadFileData(data, CBES, "new.step"); // 別の操作で付け替え済み
  writeSettingsToPluginData(data, changed);

  assert.equal(data.cacheEnabled, false);
  assert.deepEqual(data.annotations, { "new.step": [{ id: "a1" }, { id: "a2" }] });
  assert.deepEqual(data.measurements, { "new.step": [{ id: "m1" }] });
});

// ---------------------------------------------------------------------------
// 10. HTML / PDF 出力
// ---------------------------------------------------------------------------

test("出力: コードブロックの width / height を踏襲し、幅が無いときは既定の幅にすること", () => {
  const [block] = extractBlocks("```step\npath: a.step\nwidth: 520\nheight: 330\n```\n");
  assert.deepEqual(printSize(block), { width: 520, height: 330 });
  assert.equal(printSize({ height: 500 }).width, 700);
  assert.equal(printSize({}).height > 0, true);
});

test("出力: 白い背景で読めない文字色（白・黄色・未指定）は濃い色にし、読める色は保つこと", () => {
  const dark = readablePrintColor(undefined);
  assert.equal(readablePrintColor("#ffffff"), dark);
  assert.equal(readablePrintColor("#ffc531"), dark);
  assert.equal(readablePrintColor("#d00000"), "#d00000");
  assert.equal(readablePrintColor("#000"), "#000");
  // 注記の既定の文字色（黒）は保たれる
  assert.equal(readablePrintColor(sampleAnnotation().textColor), "#000000");
});

test("出力: 注記の全文が失われないよう、折り返しても元の文字がすべて残ること", () => {
  const text = "ロードセル受圧部\n第二行は少し長い文章になっています。\n\n最後";
  const lines = wrapPrintText(text, 100, (line) => line.length * 10);
  assert.ok(lines.every((line) => line.length * 10 <= 100));
  assert.equal(lines.join(""), text.replace(/\n/g, ""));
  assert.ok(lines.includes(""), "途中の空行は残す");
});
