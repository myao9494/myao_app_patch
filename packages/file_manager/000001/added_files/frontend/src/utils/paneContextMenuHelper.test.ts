/**
 * ペイン右クリックメニュー表示判定のテスト
 */
import { describe, expect, it } from "vitest";
import { shouldShowPaneContextMenu } from "./paneContextMenuHelper";

describe("shouldShowPaneContextMenu", () => {
  it("returns false for tbody tr elements (file or folder rows)", () => {
    const mockElement = {
      closest: (selector: string) => (selector === "tbody tr" ? {} : null),
    };
    expect(shouldShowPaneContextMenu(mockElement as any)).toBe(false);
  });

  it("returns true for thead tr elements (table header rows)", () => {
    const mockElement = {
      closest: (selector: string) => (selector === "thead tr" ? {} : null),
    };
    expect(shouldShowPaneContextMenu(mockElement as any)).toBe(true);
  });

  it("returns true for table header th elements", () => {
    const mockElement = {
      closest: (selector: string) => null,
    };
    expect(shouldShowPaneContextMenu(mockElement as any)).toBe(true);
  });

  it("returns false for null target", () => {
    expect(shouldShowPaneContextMenu(null)).toBe(false);
  });
});
