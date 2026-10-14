/**
 * 除外キーワードによる絞り込み（filterUtils）のテスト。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { isExcludedByKeywords } from "./filterUtils.ts";

const excludeKeywords = "node_modules\n.git\ngantt_diff_summary\nold";

test("ファイル名に除外キーワードを含むファイルは除外する", () => {
  assert.equal(isExcludedByKeywords("/work/data/gantt_diff_summary.json", "gantt_diff_summary.json", excludeKeywords), true);
  assert.equal(
    isExcludedByKeywords("/work/data/2026_gantt_diff_summary_v1.md", "2026_gantt_diff_summary_v1.md", excludeKeywords),
    true,
  );
  assert.equal(
    isExcludedByKeywords("/work/data/my_gantt_diff_summary_notes.txt", "my_gantt_diff_summary_notes.txt", excludeKeywords),
    true,
  );
});

test("除外キーワードに該当しないファイルは除外しない", () => {
  assert.equal(isExcludedByKeywords("/work/notes/normal_project.md", "normal_project.md", excludeKeywords), false);
});

test("短い英数字のキーワードは語の区切りで判定し、別の単語の一部には一致させない", () => {
  assert.equal(isExcludedByKeywords("/work/notes/older.md", "older.md", excludeKeywords), false);
  assert.equal(isExcludedByKeywords("/work/notes/old.md", "old.md", excludeKeywords), true);
  assert.equal(isExcludedByKeywords("/work/notes/old_data.txt", "old_data.txt", excludeKeywords), true);
});
