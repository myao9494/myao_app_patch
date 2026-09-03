/**
 * Markdown形式リスト変換（チェックボックス／箇条書き）のテスト
 */
import { describe, expect, it } from "vitest";
import {
  formatItemsAsMarkdownChecklist,
  formatItemsAsMarkdownBulletList,
} from "./markdownChecklist";

describe("formatItemsAsMarkdownChecklist", () => {
  it("formats files and directories as markdown checkboxes without trailing slash", () => {
    expect(
      formatItemsAsMarkdownChecklist([
        { name: "docs", type: "directory" },
        { name: "memo.md", type: "file" },
      ])
    ).toBe("- [ ] docs\n- [ ] memo.md");
  });

  it("returns an empty string when there are no items", () => {
    expect(formatItemsAsMarkdownChecklist([])).toBe("");
  });
});

describe("formatItemsAsMarkdownBulletList", () => {
  it("formats files and directories as markdown bullets without trailing slash", () => {
    expect(
      formatItemsAsMarkdownBulletList([
        { name: "docs", type: "directory" },
        { name: "memo.md", type: "file" },
      ])
    ).toBe("- docs\n- memo.md");
  });

  it("returns an empty string when there are no items", () => {
    expect(formatItemsAsMarkdownBulletList([])).toBe("");
  });
});
