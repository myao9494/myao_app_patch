/**
 * エディタ起動設定の正規化テスト
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  normalizeMarkdownOpenMode,
  normalizeTextFileOpenMode,
} from "./editorPreferences";

describe("editorPreferences", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses web editor as the default mode for text files", () => {
    expect(normalizeTextFileOpenMode(null)).toBe("web");
  });

  it("uses web editor as the default mode for markdown files", () => {
    expect(normalizeMarkdownOpenMode(null)).toBe("web");
  });

  it("keeps a valid text file mode", () => {
    expect(normalizeTextFileOpenMode("vscode")).toBe("vscode");
  });

  it("keeps a valid markdown mode", () => {
    expect(normalizeMarkdownOpenMode("external")).toBe("external");
    expect(normalizeMarkdownOpenMode("obsidian_or_web")).toBe("obsidian_or_web");
  });

  it("migrates legacy markdown modes to external", () => {
    expect(normalizeMarkdownOpenMode("obsidian")).toBe("external");
    expect(normalizeMarkdownOpenMode("vscode")).toBe("external");
    expect(normalizeMarkdownOpenMode("obsidian_web")).toBe("obsidian_or_web");
  });

  it("falls back to web editor for invalid values", () => {
    expect(normalizeTextFileOpenMode("unknown")).toBe("web");
    expect(normalizeMarkdownOpenMode("unknown")).toBe("web");
  });
});
