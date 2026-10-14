/**
 * Markdown形式リスト変換（チェックボックス／箇条書き／リンク付き）のテスト
 */
import { describe, expect, it } from "vitest";
import {
  formatItemsAsMarkdownChecklist,
  formatItemsAsMarkdownBulletList,
  formatItemsAsMarkdownLinkList,
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

describe("formatItemsAsMarkdownLinkList", () => {
  it("formats files and directories as obsidian markdown links with full path file URI", () => {
    expect(
      formatItemsAsMarkdownLinkList([
        { name: "docs", path: "/Users/mine/docs" },
        { name: "memo.md", path: "/Users/mine/memo.md" },
      ])
    ).toBe("- [docs](file:///Users/mine/docs)\n- [memo.md](file:///Users/mine/memo.md)");
  });

  it("wraps file URI in angle brackets when path contains spaces or parentheses", () => {
    expect(
      formatItemsAsMarkdownLinkList([
        { name: "my memo.md", path: "/Users/mine/my memo.md" },
        { name: "report (final).pdf", path: "C:/Users/mine/report (final).pdf" },
      ])
    ).toBe("- [my memo.md](<file:///Users/mine/my memo.md>)\n- [report (final).pdf](<file:///C:/Users/mine/report (final).pdf>)");
  });

  it("escapes square brackets in item name for safe markdown rendering", () => {
    expect(
      formatItemsAsMarkdownLinkList([
        { name: "[2026] note.md", path: "/Users/mine/[2026] note.md" },
      ])
    ).toBe("- [\\[2026\\] note.md](<file:///Users/mine/[2026] note.md>)");
  });

  it("returns an empty string when there are no items", () => {
    expect(formatItemsAsMarkdownLinkList([])).toBe("");
  });
});

