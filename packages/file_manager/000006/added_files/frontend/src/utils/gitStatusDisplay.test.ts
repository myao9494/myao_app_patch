import { describe, expect, it } from "vitest";
import { getGitStatusLabel, getGitStatusTitle, getGitSyncAction, type FolderGitStatus } from "./gitStatusDisplay";

const status = (overrides: Partial<FolderGitStatus> = {}): FolderGitStatus => ({
  changedFiles: [],
  hasMoreChanges: false,
  aheadCount: 0,
  behindCount: 0,
  ...overrides,
});

describe("getGitStatusLabel", () => {
  it("labels clean, changed, ahead, behind and diverged folders", () => {
    expect(getGitStatusLabel(undefined)).toBe("-");
    expect(getGitStatusLabel(status())).toBe("-");
    expect(getGitStatusLabel(status({ changedFiles: ["a.ts"] }))).toBe("G");
    expect(getGitStatusLabel(status({ hasMoreChanges: true }))).toBe("G");
    expect(getGitStatusLabel(status({ aheadCount: 1 }))).toBe("Push");
    expect(getGitStatusLabel(status({ behindCount: 2 }))).toBe("Pull");
    expect(getGitStatusLabel(status({ aheadCount: 1, behindCount: 2, changedFiles: ["x"] }))).toBe("C");
  });
});

describe("getGitSyncAction", () => {
  it("returns push / pull / sync, or null to open VS Code", () => {
    expect(getGitSyncAction(status({ changedFiles: ["a"] }))).toBeNull();
    expect(getGitSyncAction(status({ aheadCount: 1 }))).toBe("push");
    expect(getGitSyncAction(status({ behindCount: 1 }))).toBe("pull");
    expect(getGitSyncAction(status({ aheadCount: 1, behindCount: 1 }))).toBe("sync");
  });
});

describe("getGitStatusTitle", () => {
  it("lists counts, changed files and the click action", () => {
    expect(getGitStatusTitle(status({ aheadCount: 2, changedFiles: ["a.ts", "b.ts"], hasMoreChanges: true }))).toBe(
      "未Push: 2件\n\n変更ファイル:\na.ts\nb.ts\n…\n\nクリックしてターミナル用Gitコマンドをコピー",
    );
    expect(getGitStatusTitle(status({ changedFiles: ["a.ts"] }))).toBe("変更ファイル:\na.ts\n\nクリックしてVS Codeで開く");
    expect(getGitStatusTitle(undefined)).toBe("");
  });
});
