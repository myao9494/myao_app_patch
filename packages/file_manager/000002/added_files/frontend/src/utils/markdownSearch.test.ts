/**
 * Markdownエディタ・プレビュー用検索ユーティリティのテスト
 * - プレーンテキスト内検索マッチ抽出 (findTextMatches)
 * - 次へ/前へインデックス計算 (getNextMatchIndex)
 * - HTMLタグを破壊しない安全なハイライト付与 (highlightHtmlText)
 */
import { describe, it, expect } from "vitest";
import {
  findTextMatches,
  getNextMatchIndex,
  highlightHtmlText,
} from "./markdownSearch";

describe("markdownSearch", () => {
  describe("findTextMatches", () => {
    it("空の検索クエリの場合は空配列を返すこと", () => {
      expect(findTextMatches("Hello world", "", false)).toEqual([]);
      expect(findTextMatches("Hello world", "   ", false)).toEqual([]);
      expect(findTextMatches("", "test", false)).toEqual([]);
    });

    it("大文字小文字を無視して複数のマッチを正確に検出すること", () => {
      const text = "Apple banana APPLE orange apple";
      const matches = findTextMatches(text, "apple", false);

      expect(matches).toHaveLength(3);
      expect(matches[0]).toEqual({ start: 0, end: 5, text: "Apple" });
      expect(matches[1]).toEqual({ start: 13, end: 18, text: "APPLE" });
      expect(matches[2]).toEqual({ start: 26, end: 31, text: "apple" });
    });

    it("日本語文字列に対しても正しくマッチすること", () => {
      const text = "本日の天気は晴れです。明日の天気も晴れです。";
      const matches = findTextMatches(text, "天気", false);

      expect(matches).toHaveLength(2);
      expect(matches[0]).toEqual({ start: 3, end: 5, text: "天気" });
      expect(matches[1]).toEqual({ start: 14, end: 16, text: "天気" });
    });

    it("正規表現モードで正しくマッチすること", () => {
      const text = "item1, item20, item300";
      const matches = findTextMatches(text, "item\\d+", true);

      expect(matches).toHaveLength(3);
      expect(matches[0]).toEqual({ start: 0, end: 5, text: "item1" });
      expect(matches[1]).toEqual({ start: 7, end: 13, text: "item20" });
      expect(matches[2]).toEqual({ start: 15, end: 22, text: "item300" });
    });

    it("不正な正規表現の場合は通常の部分一致にフォールバックすること", () => {
      const text = "sample(1) and sample(2)";
      const matches = findTextMatches(text, "(1", true);

      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({ start: 6, end: 8, text: "(1" });
    });
  });

  describe("getNextMatchIndex", () => {
    it("nextで次のインデックスへ進み、末尾で先頭にラップアラウンドすること", () => {
      expect(getNextMatchIndex(0, 3, "next")).toBe(1);
      expect(getNextMatchIndex(1, 3, "next")).toBe(2);
      expect(getNextMatchIndex(2, 3, "next")).toBe(0);
    });

    it("prevで前のインデックスへ戻り、先頭で末尾にラップアラウンドすること", () => {
      expect(getNextMatchIndex(2, 3, "prev")).toBe(1);
      expect(getNextMatchIndex(1, 3, "prev")).toBe(0);
      expect(getNextMatchIndex(0, 3, "prev")).toBe(2);
    });

    it("総件数が0の場合は0を返すこと", () => {
      expect(getNextMatchIndex(0, 0, "next")).toBe(0);
      expect(getNextMatchIndex(0, 0, "prev")).toBe(0);
    });

    it("インデックスが範囲外の場合は安全に処理すること", () => {
      expect(getNextMatchIndex(-1, 3, "next")).toBe(0);
      expect(getNextMatchIndex(-1, 3, "prev")).toBe(2);
      expect(getNextMatchIndex(10, 3, "next")).toBe(0);
    });
  });

  describe("highlightHtmlText", () => {
    it("空クエリの場合は元のHTMLをそのまま返し、マッチ件数0とすること", () => {
      const html = "<p>Hello world</p>";
      const result = highlightHtmlText(html, "", 0, false);
      expect(result.highlightedHtml).toBe(html);
      expect(result.totalMatches).toBe(0);
    });

    it("HTMLタグ属性の内部を破壊せず、テキスト部分のみをmarkでハイライトすること", () => {
      const html = '<a href="https://example.com/apple" class="apple-link">Fresh Apple</a>';
      const result = highlightHtmlText(html, "apple", 0, false);

      expect(result.totalMatches).toBe(1);
      // hrefやclass内の"apple"は置換されず、タグ外部の"Apple"のみハイライトされる
      expect(result.highlightedHtml).toContain('href="https://example.com/apple"');
      expect(result.highlightedHtml).toContain('class="apple-link"');
      expect(result.highlightedHtml).toContain('<mark class="md-search-highlight active" data-match-index="0">Apple</mark>');
    });

    it("複数ヒットがある場合、指定したactiveIndexの要素にactiveクラスが付与されること", () => {
      const html = "<p>One test and another test.</p>";
      const result = highlightHtmlText(html, "test", 1, false);

      expect(result.totalMatches).toBe(2);
      expect(result.highlightedHtml).toContain('<mark class="md-search-highlight" data-match-index="0">test</mark>');
      expect(result.highlightedHtml).toContain('<mark class="md-search-highlight active" data-match-index="1">test</mark>');
    });

    it("不正な正規表現でも安全にフォールバックしてハイライトできること", () => {
      const html = "<p>test(1) test(2)</p>";
      const result = highlightHtmlText(html, "(1", 0, true);

      expect(result.totalMatches).toBe(1);
      expect(result.highlightedHtml).toContain('<mark class="md-search-highlight active" data-match-index="0">(1</mark>');
    });
  });
});
