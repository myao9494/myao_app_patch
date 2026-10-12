/**
 * インデックス済みフォルダ・検索対象フォルダ一覧の絞り込みのテスト。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { filterIndexedTargets, filterSearchTargets } from "./indexedTargetFilter.ts";
import type { IndexedTarget, SearchTargetFolder } from "./types.ts";

function indexedTarget(fullPath: string, indexedFileCount: number): IndexedTarget {
  return { full_path: fullPath, source_type: "local", last_indexed_at: null, indexed_file_count: indexedFileCount };
}

function searchTarget(fullPath: string, isEnabled = true): SearchTargetFolder {
  return { full_path: fullPath, source_type: "local", is_enabled: isEnabled, last_indexed_at: null, indexed_file_count: 0 };
}

test("インデックス済みフォルダはファイル数の多い順、同数ならパスの昇順に並ぶ", () => {
  const targets = [indexedTarget("/docs/b", 3), indexedTarget("/docs/c", 10), indexedTarget("/docs/a", 3)];

  assert.deepEqual(
    filterIndexedTargets(targets, "", "").map((item) => item.full_path),
    ["/docs/c", "/docs/a", "/docs/b"],
  );
});

test("「含む」キーワードは大文字小文字を区別せず、パスに含むものだけを残す", () => {
  const targets = [indexedTarget("/docs/Project/notes", 1), indexedTarget("/docs/archive", 1)];

  assert.deepEqual(
    filterIndexedTargets(targets, "  project ", "").map((item) => item.full_path),
    ["/docs/Project/notes"],
  );
});

test("「含まない」キーワードは 1 行に 1 つ指定でき、どれかを含むパスを隠す", () => {
  const targets = [indexedTarget("/docs/keep", 1), indexedTarget("/docs/Old/a", 1), indexedTarget("/docs/tmp/b", 1)];

  assert.deepEqual(
    filterIndexedTargets(targets, "", "old\n\nTMP").map((item) => item.full_path),
    ["/docs/keep"],
  );
});

test("絞り込みは元の配列を並べ替えない", () => {
  const targets = [indexedTarget("/docs/b", 1), indexedTarget("/docs/a", 5)];

  filterIndexedTargets(targets, "", "");

  assert.deepEqual(targets.map((item) => item.full_path), ["/docs/b", "/docs/a"]);
});

test("検索対象フォルダは「含む」キーワードだけで絞り込み、登録順を保つ", () => {
  const targets = [searchTarget("/work/Beta"), searchTarget("/work/alpha", false), searchTarget("/home/beta2")];

  assert.deepEqual(filterSearchTargets(targets, "BETA").map((item) => item.full_path), ["/work/Beta", "/home/beta2"]);
  assert.deepEqual(filterSearchTargets(targets, "   "), targets);
});
