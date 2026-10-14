/**
 * インデックスサービス検索のフルパス絞り込みのテスト
 *
 * 仕様:
 * - 空白区切りの複数キーワードは、フルパス（フォルダ名を含む）に全て含まれる項目だけを返す
 * - 大文字小文字は区別しない
 * - 外部サービスには語ごとに問い合わせ、結果を統合して重複を除く
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterByAllTokens, searchIndexService, splitQueryTokens } from "./indexService";

describe("splitQueryTokens", () => {
  it("半角・全角空白で分割し空要素を除く", () => {
    expect(splitQueryTokens("  人事　top  ")).toEqual(["人事", "top"]);
  });
});

describe("filterByAllTokens", () => {
  const items = [
    { name: "top.excalidraw", path: "/work/人事/top.excalidraw" },
    { name: "top.excalidraw", path: "/work/経理/top.excalidraw" },
  ];

  it("全ての語をフルパスに含むものだけ残す", () => {
    expect(filterByAllTokens(items, ["人事", "TOP"])).toEqual([items[0]]);
  });
});

describe("searchIndexService（複数語）", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
    vi.stubGlobal("localStorage", { getItem: () => null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("語ごとに検索して統合し、フルパスで絞り込む", async () => {
    const top = [
      { name: "top.excalidraw", path: "/work/人事/top.excalidraw", type: "file", size: 1, date_modified: 0 },
      { name: "top.excalidraw", path: "/work/経理/top.excalidraw", type: "file", size: 1, date_modified: 0 },
    ];
    const fetchMock = vi.fn(async (input: string) => {
      const search = new URL(input).searchParams.get("search");
      const results = search === "top" ? top : [];
      return { ok: true, json: async () => ({ totalResults: results.length, results }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await searchIndexService({ query: "人事 top" });

    expect(res.results.map((r) => r.path)).toEqual(["/work/人事/top.excalidraw"]);
    expect(res.totalResults).toBe(1);
  });
});
