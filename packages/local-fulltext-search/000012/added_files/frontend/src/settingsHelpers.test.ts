import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveRelativeDateInputValue,
  resolveTodayDateInputValue,
  toLocalDateTimeInputValue,
  toSchedulerStartAtIso,
} from "./dateInput.ts";
import {
  BASE_CONTENT_EXTENSIONS,
  DEFAULT_INDEX_EXTENSIONS,
  buildAvailableExtensions,
  normalizeCustomExtensions,
  normalizeIndexExtensions,
  parseExtensionText,
} from "./indexExtensions.ts";
import { isPathCoveredByTarget, normalizeComparablePath } from "./searchTargetCoverage.ts";
import {
  normalizeExcludeKeywords,
  normalizeGanttParent,
  normalizeHiddenIndexedTargets,
  normalizeSynonymGroups,
} from "./settingsNormalization.ts";
import type { SearchTargetFolder } from "./types";

test("日付ショートカットは UTC ではなくローカルの年月日を返す", () => {
  // ローカル時刻の深夜 0 時台（日本時間では UTC の前日にあたる時間帯）でも当日を返す
  const earlyMorning = new Date(2026, 9, 11, 0, 30, 0);

  assert.equal(resolveTodayDateInputValue(earlyMorning), "2026-10-11");
  assert.equal(resolveRelativeDateInputValue(7, earlyMorning), "2026-10-04");
  assert.equal(resolveRelativeDateInputValue(11, earlyMorning), "2026-09-30");
  assert.equal(earlyMorning.getDate(), 11, "引数の Date を変更しない");
});

test("スケジューラーの日時は datetime-local の値と ISO 文字列を往復できる", () => {
  const iso = new Date(2026, 4, 5, 6, 7, 0).toISOString();

  assert.equal(toLocalDateTimeInputValue(iso), "2026-05-05T06:07");
  assert.equal(toSchedulerStartAtIso("2026-05-05T06:07"), iso);
  assert.equal(toLocalDateTimeInputValue(null), "");
});

test("除外キーワードと非表示キーワードは空行・前後空白・重複を取り除く", () => {
  assert.equal(normalizeExcludeKeywords("  node_modules \r\n\n.git\nnode_modules\n"), "node_modules\n.git");
  assert.equal(normalizeHiddenIndexedTargets("a\n\n a \nb"), "a\nb");
  assert.equal(normalizeExcludeKeywords(""), "");
});

test("類似語リストは用語の重複を大文字小文字を無視して除き、解説を保持する", () => {
  const normalized = normalizeSynonymGroups(
    ["PC, パソコン，pc : 個人向け端末", "", "スマホ,スマートフォン", " ： 用語なし", "AI：人工知能の略"].join("\n"),
  );

  assert.equal(normalized, ["PC,パソコン:個人向け端末", "スマホ,スマートフォン", "AI:人工知能の略"].join("\n"));
  assert.equal(normalizeSynonymGroups(null), "");
});

test("gantt parent ID は 0 以上の整数だけを受け付ける", () => {
  assert.equal(normalizeGanttParent(" 239 "), 239);
  assert.equal(normalizeGanttParent(12), 12);
  assert.equal(normalizeGanttParent("-1"), 0);
  assert.equal(normalizeGanttParent("1.5"), 0);
  assert.equal(normalizeGanttParent("abc"), 0);
  assert.equal(normalizeGanttParent(undefined), 0);
});

test("標準の対象拡張子に XLSM・Excalidraw・DIO・XML とメール・画像を含める", () => {
  for (const extension of [".xlsm", ".excalidraw", ".excalidraw.md", ".dio", ".dio.svg", ".xml", ".msg"]) {
    assert.ok(BASE_CONTENT_EXTENSIONS.includes(extension), `${extension} は本文抽出対象`);
  }
  for (const extension of [".png", ".jpg", ".svg", ".mp3"]) {
    assert.ok(DEFAULT_INDEX_EXTENSIONS.includes(extension), `${extension} は既定のインデックス対象`);
    assert.ok(!BASE_CONTENT_EXTENSIONS.includes(extension), `${extension} はファイル名のみ検索`);
  }
});

test("拡張子一覧はドットを補い、重複を除き、表示順を保つ", () => {
  assert.deepEqual(normalizeCustomExtensions([" py", ".PY", ".dat", ""]), [".py", ".dat"]);
  assert.deepEqual(parseExtensionText(".py, dat\n.py  .cae"), [".py", ".dat", ".cae"]);

  const available = buildAvailableExtensions([".py", ".md"], [".cae"]);
  assert.deepEqual(available.slice(0, BASE_CONTENT_EXTENSIONS.length), [...BASE_CONTENT_EXTENSIONS]);
  assert.deepEqual(available.slice(-2), [".py", ".cae"]);
  assert.equal(available.filter((extension) => extension === ".md").length, 1);
  assert.deepEqual(buildAvailableExtensions([], []), DEFAULT_INDEX_EXTENSIONS);

  assert.deepEqual(normalizeIndexExtensions(["png", ".md", ".unknown", ".md"], available), [".md", ".png"]);
});

test("検索対象フォルダの包含判定は区切り文字と末尾スラッシュの違いを吸収する", () => {
  const targets = [
    { full_path: "C:\\work\\docs\\" },
    { full_path: "/Users/me/vault" },
  ] as SearchTargetFolder[];

  assert.equal(normalizeComparablePath("C:\\work\\docs\\"), "C:/work/docs");
  assert.equal(normalizeComparablePath("/"), "/");
  assert.equal(isPathCoveredByTarget("C:/work/docs/sub/a.md", targets), true);
  assert.equal(isPathCoveredByTarget("C:/work/docs", targets), true);
  assert.equal(isPathCoveredByTarget("C:/work/docs2/a.md", targets), false);
  assert.equal(isPathCoveredByTarget("/Users/me/vault/notes", targets), true);
  assert.equal(isPathCoveredByTarget("/Users/me", targets), false);
  assert.equal(isPathCoveredByTarget("  ", targets), false);
});
