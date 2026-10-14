import assert from "node:assert/strict";
import test from "node:test";

import { sortSearchResults } from "./searchResultSort.ts";
import type { SearchResult } from "./types";

/**
 * 並び替えテスト用の検索結果を、必要な項目だけ指定して作る。
 */
function item(fileId: number, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    file_id: fileId,
    target_path: "/docs",
    file_name: `file-${fileId}.md`,
    full_path: `/docs/file-${fileId}.md`,
    file_ext: ".md",
    created_at: "2026-01-01T00:00:00+09:00",
    mtime: "2026-01-01T00:00:00+09:00",
    click_count: 0,
    snippet: "",
    ...overrides,
  } as SearchResult;
}

function ids(items: readonly SearchResult[]): number[] {
  return items.map((entry) => entry.file_id);
}

test("既定順はハイブリッド融合スコアの高い順を最優先する", () => {
  const sorted = sortSearchResults(
    [
      item(1, { hybrid_score: 0.4, filename_match_level: 8, click_count: 99 }),
      item(2, { hybrid_score: 0.9 }),
      item(3, { hybrid_score: 0.6, has_obsidian_top_tag: true }),
    ],
    { sortBy: "default", sortOrder: "desc" },
  );

  assert.deepEqual(ids(sorted), [2, 3, 1]);
});

test("既定順はハイブリッドスコアを持つ結果を、持たない結果より先に並べる", () => {
  const sorted = sortSearchResults(
    [item(1, { filename_match_level: 8 }), item(2, { hybrid_score: 0.1 })],
    { sortBy: "default", sortOrder: "desc" },
  );

  assert.deepEqual(ids(sorted), [2, 1]);
});

test("既定順はスコアが無いとき、ファイル名一致・top タグ・検索語別クリック・関連度・利用価値・更新日時の順で比べる", () => {
  const sorted = sortSearchResults(
    [
      item(1, { mtime: "2026-03-01T00:00:00+09:00" }),
      item(2, { utility_score: 5 }),
      item(3, { relevance_bucket: 3 }),
      item(4, { query_click_score: 0.5 }),
      item(5, { has_obsidian_top_tag: true }),
      item(6, { filename_match_level: 2 }),
      item(7, { mtime: "2026-02-01T00:00:00+09:00" }),
    ],
    { sortBy: "default", sortOrder: "desc" },
  );

  assert.deepEqual(ids(sorted), [6, 5, 4, 3, 2, 1, 7]);
});

test("既定順は昇順指定でも順序を変えない", () => {
  const items = [item(1, { hybrid_score: 0.2 }), item(2, { hybrid_score: 0.8 })];

  assert.deepEqual(
    ids(sortSearchResults(items, { sortBy: "default", sortOrder: "asc" })),
    ids(sortSearchResults(items, { sortBy: "default", sortOrder: "desc" })),
  );
});

test("スコア・日付・アクセス数の並び替えは指定した向きで並べ、同値は file_id 順にする", () => {
  const items = [
    item(3, { vector_score: 0.5, click_count: 2, created_at: "2026-01-03T00:00:00+09:00" }),
    item(1, { vector_score: 0.9, click_count: 2, created_at: "2026-01-01T00:00:00+09:00" }),
    item(2, { click_count: 7, created_at: "2026-01-02T00:00:00+09:00" }),
  ];

  assert.deepEqual(ids(sortSearchResults(items, { sortBy: "vector_score", sortOrder: "desc" })), [1, 3, 2]);
  assert.deepEqual(ids(sortSearchResults(items, { sortBy: "vector_score", sortOrder: "asc" })), [2, 3, 1]);
  assert.deepEqual(ids(sortSearchResults(items, { sortBy: "click_count", sortOrder: "desc" })), [2, 1, 3]);
  assert.deepEqual(ids(sortSearchResults(items, { sortBy: "created", sortOrder: "asc" })), [1, 2, 3]);
});

test("並び替えは元の配列を変更しない", () => {
  const items = [item(2, { hybrid_score: 0.1 }), item(1, { hybrid_score: 0.9 })];

  sortSearchResults(items, { sortBy: "default", sortOrder: "desc" });

  assert.deepEqual(ids(items), [2, 1]);
});
