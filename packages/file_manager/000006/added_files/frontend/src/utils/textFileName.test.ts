/**
 * テキストファイル作成時のファイル名・拡張子結合のテスト
 */
import { describe, expect, it } from "vitest";
import { buildExcalidrawFileName, buildMarkdownFileName, buildTextFileName } from "./textFileName";

describe("buildTextFileName", () => {
  it("adds the selected extension", () => {
    expect(buildTextFileName("memo", "md")).toBe("memo.md");
  });

  it("does not duplicate the selected extension", () => {
    expect(buildTextFileName("memo.txt", "txt")).toBe("memo.txt");
  });

  it("normalizes a leading dot in the extension", () => {
    expect(buildTextFileName("settings", ".json")).toBe("settings.json");
  });
});

describe("buildMarkdownFileName", () => {
  it(".md がなければ付け、あればそのまま", () => {
    expect(buildMarkdownFileName(" note ")).toBe("note.md");
    expect(buildMarkdownFileName("note.md")).toBe("note.md");
  });
});

describe("buildExcalidrawFileName", () => {
  it("obsidian 以外では .excalidraw を付ける", () => {
    expect(buildExcalidrawFileName("drawing", false)).toBe("drawing.excalidraw");
    expect(buildExcalidrawFileName("drawing.excalidraw", false)).toBe("drawing.excalidraw");
  });

  it("obsidian 配下では .excalidraw.md にする（.excalidraw まで入力されていれば .md だけ足す）", () => {
    expect(buildExcalidrawFileName("drawing", true)).toBe("drawing.excalidraw.md");
    expect(buildExcalidrawFileName("drawing.excalidraw", true)).toBe("drawing.excalidraw.md");
    expect(buildExcalidrawFileName("drawing.excalidraw.md", true)).toBe("drawing.excalidraw.md");
  });
});
