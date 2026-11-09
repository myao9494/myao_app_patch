/**
 * 共通処理（lib/）の単体テスト。
 * - Git対象拡張子の正規化
 * - Git画像メモIDの決まり方（同じファイルは同じID、Excalidraw図は本文と別ID）
 * - 並列度を制限した順序維持の非同期処理
 * - 画像の data URI を画像オブジェクトごとに1回だけ作る
 * - テキスト差分の行をブロックへ分ける
 * - 位置合わせの範囲指定（ドラッグから範囲を作る・APIへの変換）
 * - 外部から開くURLの git_path / markdown_path の読み取り
 */

import test from "node:test";
import assert from "node:assert/strict";
import { anchorPayload, regionFromDrag } from "../src/lib/anchorRegion.js";
import { mapWithConcurrency } from "../src/lib/api.js";
import { toDataUri } from "../src/lib/files.js";
import { gitImageMemoId, gitMemoKey } from "../src/lib/memoStore.js";
import { loadDisplayScale, loadMemoSidebarWidth, normalizeTextExtensions } from "../src/lib/storage.js";
import { chunkItems, contextMenuPosition, normalizeLineEndings } from "../src/lib/util.js";
import { gitPathFromSearch } from "../src/lib/location.js";

test("gitPathFromSearch: git_path（フォルダー・ファイル）を優先し、無ければ markdown_path / markdown_file", () => {
  assert.equal(gitPathFromSearch("?git_path=%2Frepo%2Fdocs"), "/repo/docs");
  assert.equal(gitPathFromSearch("?git_path=C%3A%2Frepo%2Fa.txt"), "C:/repo/a.txt");
  assert.equal(gitPathFromSearch("?markdown_path=%2Fvault%2Fnote.md"), "/vault/note.md");
  assert.equal(gitPathFromSearch("?markdown_file=%2Fvault%2Fnote.md"), "/vault/note.md");
  assert.equal(gitPathFromSearch("?git_path=%2Fa&markdown_path=%2Fb.md"), "/a");
  assert.equal(gitPathFromSearch(""), "");
});

test("contextMenuPosition: 画面の端でも内側に収め、表示倍率の分を割り戻す", () => {
  const size = { width: 300, height: 120 };
  const viewport = { width: 1000, height: 800 };
  assert.deepEqual(contextMenuPosition(100, 200, size, viewport), { left: 100, top: 200 });
  assert.deepEqual(contextMenuPosition(990, 790, size, viewport), { left: 692, top: 672 });
  assert.deepEqual(contextMenuPosition(100, 200, size, viewport, 2), { left: 50, top: 100 });
  assert.deepEqual(contextMenuPosition(990, 790, size, viewport, 2), { left: 346, top: 336 });
});

test("normalizeTextExtensions: 小文字化・ドット補完・重複除去・不正値除外を行う", () => {
  assert.deepEqual(normalizeTextExtensions("MD, .txt  yaml,md, ..bad, ok!"), [".md", ".txt", ".yaml"]);
  assert.deepEqual(normalizeTextExtensions([".CSV", "csv"]), [".csv"]);
  assert.equal(normalizeTextExtensions(Array.from({ length: 80 }, (_, index) => `e${index}`)).length, 50);
});

test("gitImageMemoId: 同じリポジトリ・パスは同じID、Excalidraw図は本文と別ID", () => {
  const id = gitImageMemoId("/repo", "docs/note.md");
  assert.equal(id, gitImageMemoId("/repo", "docs/note.md"));
  assert.match(id, /^git-image-[0-9a-f]+$/);
  assert.notEqual(id, gitImageMemoId("/repo", "docs/note.md#excalidraw"));
  assert.equal(gitMemoKey("", "a.md"), "repo::a.md");
});

test("mapWithConcurrency: 順序を保ち、同時実行数を limit 以下に抑える", async () => {
  let running = 0;
  let peak = 0;
  const results = await mapWithConcurrency([30, 5, 20, 1, 10], 2, async (delay, index) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, delay));
    running -= 1;
    return index * 10;
  });
  assert.deepEqual(results, [0, 10, 20, 30, 40]);
  assert.equal(peak, 2);
});

test("mapWithConcurrency: 1件でも失敗したら例外を投げる", async () => {
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (value) => {
      if (value === 2) throw new Error("failed");
      return value;
    }),
    /failed/,
  );
});

test("normalizeLineEndings: CRLF・CRをLFへ統一する", () => {
  assert.equal(normalizeLineEndings("a\r\nb\rc\n"), "a\nb\nc\n");
  assert.equal(normalizeLineEndings(undefined), "");
});

test("chunkItems: 順序を保って size 件ずつに分け、空配列は空のまま", () => {
  assert.deepEqual(chunkItems([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkItems([], 2), []);
});

test("toDataUri: 同じ画像オブジェクトには同じ文字列を返し、別オブジェクトは別に作る", () => {
  const image = { mime_type: "image/png", data: "QUJD" };
  const first = toDataUri(image);
  assert.equal(first, "data:image/png;base64,QUJD");
  assert.equal(toDataUri(image), first);
  assert.equal(toDataUri({ mime_type: "image/jpeg", data: "QUJD" }), "data:image/jpeg;base64,QUJD");
});

test("loadDisplayScale / loadMemoSidebarWidth: 未保存なら既定値（100% / 230px）、保存値は範囲内に丸める", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  try {
    assert.equal(loadDisplayScale(), 1);
    assert.equal(loadMemoSidebarWidth(), 230);
    store.set("visual-diff-display-scale-v2", "1.25");
    store.set("visual-diff-memo-sidebar-width", "9999");
    assert.equal(loadDisplayScale(), 1.25);
    assert.equal(loadMemoSidebarWidth(), 420);
    store.set("visual-diff-display-scale-v2", "abc");
    assert.equal(loadDisplayScale(), 1);
  } finally {
    delete globalThis.localStorage;
  }
});

test("regionFromDrag: ドラッグの向きによらず範囲を作り、画像内に収める", () => {
  const size = { width: 400, height: 300 };
  assert.deepEqual(regionFromDrag({ x: 120.4, y: 80 }, { x: 40, y: 40.2 }, size), { x: 40, y: 40, width: 80, height: 40, label: "指定した範囲" });
  assert.deepEqual(regionFromDrag({ x: -30, y: 250 }, { x: 60, y: 900 }, size), { x: 0, y: 250, width: 60, height: 50, label: "指定した範囲" });
});

test("regionFromDrag: 小さすぎる範囲は null", () => {
  assert.equal(regionFromDrag({ x: 10, y: 10 }, { x: 20, y: 200 }, { width: 400, height: 300 }), null);
});

test("anchorPayload: 範囲がなければ送らず、B の位置は指定時だけ送る", () => {
  const region = { x: 1, y: 2, width: 30, height: 40 };
  assert.deepEqual(anchorPayload(null), {});
  assert.deepEqual(anchorPayload({ region, regionB: null }), { anchor_region: region });
  assert.deepEqual(anchorPayload({ region, regionB: region }), { anchor_region: region, anchor_region_b: region });
});
