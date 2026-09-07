/**
 * 画像ユーティリティ関数のテスト
 * - 画像ファイル判定 (isImageFile)
 * - 画像URL生成 (getImageViewUrl)
 * - フォルダ内画像一覧・インデックス取得 (getImageSiblings)
 */
import { describe, it, expect } from "vitest";
import { isImageFile, getImageViewUrl, getImageSiblings, formatFileSize, IMAGE_EXTENSIONS } from "./imageUtils";
import type { FileItem } from "../types/file";

describe("imageUtils", () => {
  describe("isImageFile", () => {
    it("一般的な画像拡張子を正しく判定すること", () => {
      expect(isImageFile("photo.png")).toBe(true);
      expect(isImageFile("photo.PNG")).toBe(true);
      expect(isImageFile("photo.jpg")).toBe(true);
      expect(isImageFile("photo.jpeg")).toBe(true);
      expect(isImageFile("photo.gif")).toBe(true);
      expect(isImageFile("photo.webp")).toBe(true);
      expect(isImageFile("photo.svg")).toBe(true);
      expect(isImageFile("photo.bmp")).toBe(true);
      expect(isImageFile("photo.ico")).toBe(true);
      expect(isImageFile("photo.avif")).toBe(true);
    });

    it("非画像ファイルに対してfalseを返すこと", () => {
      expect(isImageFile("document.pdf")).toBe(false);
      expect(isImageFile("notes.md")).toBe(false);
      expect(isImageFile("script.py")).toBe(false);
      expect(isImageFile("archive.zip")).toBe(false);
      expect(isImageFile("noextension")).toBe(false);
    });
  });

  describe("getImageViewUrl", () => {
    it("正しいAPIエンドポイントURLを生成すること", () => {
      const url = getImageViewUrl("/path/to/image.png");
      expect(url).toContain("/api/view-image?path=");
      expect(url).toContain(encodeURIComponent("/path/to/image.png"));
    });

    it("日本語パスを正しくエンコードすること", () => {
      const url = getImageViewUrl("/写真/サンプル.jpg");
      expect(url).toContain(encodeURIComponent("/写真/サンプル.jpg"));
    });
  });

  describe("getImageSiblings", () => {
    const mockItems: FileItem[] = [
      { name: "doc.pdf", path: "/folder/doc.pdf", type: "file", size: 100, modified: "2026-01-01" },
      { name: "img1.png", path: "/folder/img1.png", type: "file", size: 200, modified: "2026-01-01" },
      { name: "subfolder", path: "/folder/subfolder", type: "directory", size: 0, modified: "2026-01-01" },
      { name: "img2.jpg", path: "/folder/img2.jpg", type: "file", size: 300, modified: "2026-01-01" },
      { name: "img3.svg", path: "/folder/img3.svg", type: "file", size: 400, modified: "2026-01-01" },
    ];

    it("フォルダ内の画像ファイルのみを抽出し、現在の画像のインデックスを特定すること", () => {
      const result = getImageSiblings(mockItems, "/folder/img2.jpg");
      expect(result.images).toHaveLength(3);
      expect(result.images.map((i) => i.name)).toEqual(["img1.png", "img2.jpg", "img3.svg"]);
      expect(result.currentIndex).toBe(1);
    });

    it("見つからない場合はcurrentIndexが-1になること", () => {
      const result = getImageSiblings(mockItems, "/folder/notfound.png");
      expect(result.images).toHaveLength(3);
      expect(result.currentIndex).toBe(-1);
    });
  });
});

  describe("formatFileSize", () => {
    it("バイト数を正しくフォーマットすること", () => {
      expect(formatFileSize(0)).toBe("0 B");
      expect(formatFileSize(1024)).toBe("1.0 KB");
      expect(formatFileSize(1024 * 1024 * 2.5)).toBe("2.5 MB");
      expect(formatFileSize(undefined)).toBe("-");
    });
  });
