/**
 * ファイルの履歴（git/gitHistory.js）の単体テスト。
 * - 段は古い順のコミットに、最後の「HEAD → 作業ツリー」（一覧の項目そのもの）を足したもの
 * - Markdown の段は、そのコミットにある Excalidraw図・3D表示をサブ項目に展開する
 * - 開いたときは、いちばん新しいコミットの本体を選ぶ
 * - 過去の段は範囲・メモのキーを「パス@コミット」にして、作業ツリーのものと混ぜない
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  formatCommitDate,
  gitFileTargets,
  gitHistorySteps,
  gitHistoryTargets,
  gitRevisionPath,
  initialHistoryIndex,
  isHistoricalStep,
  newSideTitle,
  oldSideTitle,
} from "../src/git/gitHistory.js";

const file = {
  path: "notes/a.md",
  head_path: "notes/a.md",
  kind: "text",
  change_type: "modified",
  has_head: true,
  has_current: true,
  diffable: true,
  embedded_excalidraw: false,
  cad_views: [],
};

const commits = [
  { commit: "a".repeat(40), short: "aaaaaaa", parent: null, subject: "add", date: "2026-11-01T09:05:00+09:00", change_type: "added", path: "a.md", head_path: "a.md", old_rev: null, new_rev: "a".repeat(40), has_head: false, has_current: true },
  { commit: "b".repeat(40), short: "bbbbbbb", parent: "a".repeat(40), subject: "edit", date: "2026-11-02T10:00:00+09:00", change_type: "renamed", path: "notes/a.md", head_path: "a.md", old_rev: "a".repeat(40), new_rev: "b".repeat(40), has_head: true, has_current: true, embedded_excalidraw: true, cad_views: [{ key: "part", name: "part" }] },
];

test("steps are commits oldest first, then the working-tree change", () => {
  const steps = gitHistorySteps(file, commits);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].commit.short, "aaaaaaa");
  assert.equal(steps[0].diffable, false);
  assert.equal(steps[1].head_path, "a.md");
  assert.equal(steps[1].kind, "text");
  assert.equal(steps[2].commit, null);
  assert.equal(steps[2].path, file.path);
  assert.equal(isHistoricalStep(steps[1]), true);
  assert.equal(isHistoricalStep(steps[2]), false);
});

test("markdown steps expand embedded drawings and 3D views", () => {
  const targets = gitHistoryTargets(gitHistorySteps(file, commits));
  assert.deepEqual(targets.map((target) => target.mode), ["text", "text", "excalidraw", "cad-view:part", "text"]);
  assert.deepEqual(gitFileTargets({ ...file, kind: "3d" }).map((target) => target.mode), ["3d"]);
});

test("opens at the newest commit's main view", () => {
  const targets = gitHistoryTargets(gitHistorySteps(file, commits));
  assert.equal(initialHistoryIndex(targets), 1);
  assert.equal(initialHistoryIndex(gitHistoryTargets(gitHistorySteps(file, []))), 0);
});

test("past steps use their own keys and labels", () => {
  const [added, edit, worktree] = gitHistorySteps(file, commits);
  assert.equal(oldSideTitle(added), "変更前（なし）");
  assert.equal(gitRevisionPath(edit), `notes/a.md@${"b".repeat(40)}`);
  assert.equal(gitRevisionPath(worktree), "notes/a.md");
  assert.equal(oldSideTitle(edit), "変更前（aaaaaaa）");
  assert.equal(newSideTitle(edit), "変更後（bbbbbbb）");
  assert.equal(oldSideTitle(worktree), "変更前（HEAD）");
  assert.equal(newSideTitle(worktree), "変更後（作業ツリー）");
  assert.equal(formatCommitDate("2026-11-02T10:00:00+09:00"), "2026-11-02 10:00");
});
