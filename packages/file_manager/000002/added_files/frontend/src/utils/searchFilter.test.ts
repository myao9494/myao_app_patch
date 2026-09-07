/**
 * 検索フィルタユーティリティのテスト
 * - 部分一致検索 (matchesSearchQuery)
 * - 正規表現検索 (matchesSearchQuery with isRegex)
 * - 不正な正規表現時のフォールバック
 * - ヒット件数フォーマット (formatSearchMatchCount)
 */
import { describe, it, expect } from "vitest";
import { matchesSearchQuery, formatSearchMatchCount, getNextSearchHitIndex, formatSearchPosition } from "./searchFilter";

describe("searchFilter", () => {
  describe("matchesSearchQuery", () => {
    it("空のクエリの場合は常にtrueを返すこと", () => {
      expect(matchesSearchQuery("file.txt", "", false)).toBe(true);
      expect(matchesSearchQuery("file.txt", "", true)).toBe(true);
      expect(matchesSearchQuery("file.txt", "   ", false)).toBe(true);
    });

    it("通常検索で大文字小文字を区別せず部分一致すること", () => {
      expect(matchesSearchQuery("MyDocument.PDF", "doc", false)).toBe(true);
      expect(matchesSearchQuery("MyDocument.PDF", "pdf", false)).toBe(true);
      expect(matchesSearchQuery("MyDocument.PDF", "MYDOC", false)).toBe(true);
      expect(matchesSearchQuery("MyDocument.PDF", "xyz", false)).toBe(false);
    });

    it("日本語のファイル名に対して部分一致すること", () => {
      expect(matchesSearchQuery("確定申告2026.pdf", "申告", false)).toBe(true);
      expect(matchesSearchQuery("確定申告2026.pdf", "2026", false)).toBe(true);
      expect(matchesSearchQuery("確定申告2026.pdf", "領収書", false)).toBe(false);
    });

    it("正規表現検索が正しく機能すること", () => {
      expect(matchesSearchQuery("test_123.log", "^test_\\d+", true)).toBe(true);
      expect(matchesSearchQuery("test_abc.log", "^test_\\d+", true)).toBe(false);
      expect(matchesSearchQuery("style.min.css", "\\.(css|scss)$", true)).toBe(true);
    });

    it("不正な正規表現の場合は通常の部分一致にフォールバックすること", () => {
      // 閉じられていないカッコなど
      expect(matchesSearchQuery("sample(1).txt", "(1", true)).toBe(true);
      expect(matchesSearchQuery("sample[A].txt", "[A", true)).toBe(true);
    });
  });

  describe("formatSearchMatchCount", () => {
    it("ヒット件数と全体件数を正しくフォーマットすること", () => {
      expect(formatSearchMatchCount(5, 10)).toBe("5 / 10");
      expect(formatSearchMatchCount(0, 10)).toBe("0 / 10");
      expect(formatSearchMatchCount(10, 10)).toBe("10 / 10");
    });
  });

  describe("getNextSearchHitIndex", () => {
    it("Enterで次のヒットへ進むこと (next)", () => {
      expect(getNextSearchHitIndex(0, 5, "next")).toBe(1);
      expect(getNextSearchHitIndex(1, 5, "next")).toBe(2);
      expect(getNextSearchHitIndex(3, 5, "next")).toBe(4);
    });

    it("最後のヒットでnextを押すと最初のヒットにラップアラウンドすること", () => {
      expect(getNextSearchHitIndex(4, 5, "next")).toBe(0);
    });

    it("Shift+Enterで前のヒットへ戻ること (prev)", () => {
      expect(getNextSearchHitIndex(2, 5, "prev")).toBe(1);
      expect(getNextSearchHitIndex(1, 5, "prev")).toBe(0);
    });

    it("最初のヒットでprevを押すと最後のヒットにラップアラウンドすること", () => {
      expect(getNextSearchHitIndex(0, 5, "prev")).toBe(4);
    });

    it("totalHitsが0件の場合は0を返すこと", () => {
      expect(getNextSearchHitIndex(0, 0, "next")).toBe(0);
      expect(getNextSearchHitIndex(0, 0, "prev")).toBe(0);
    });

    it("初期状態などでcurrentIndexが範囲外の場合は安全に処理すること", () => {
      expect(getNextSearchHitIndex(-1, 5, "next")).toBe(0);
      expect(getNextSearchHitIndex(-1, 5, "prev")).toBe(4);
      expect(getNextSearchHitIndex(10, 5, "next")).toBe(0);
    });
  });

  describe("formatSearchPosition", () => {
    it("現在のヒット位置と合計ヒット数を正しくフォーマットすること", () => {
      expect(formatSearchPosition(0, 5)).toBe("1 / 5");
      expect(formatSearchPosition(2, 5)).toBe("3 / 5");
      expect(formatSearchPosition(4, 5)).toBe("5 / 5");
    });

    it("ヒット数が0の場合は0 / 0を返すこと", () => {
      expect(formatSearchPosition(0, 0)).toBe("0 / 0");
    });
  });
});
