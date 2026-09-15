import assert from "node:assert/strict";
import test from "node:test";

import { filterSearchResultsByExtensions, parseSearchFilterExtensions } from "./extensionFilter.ts";

test("拡張子フィルターは空白区切り入力を正規化しつつ重複を除く", () => {
  assert.deepEqual(parseSearchFilterExtensions(" MD   .pdf  md "), [".md", ".pdf"]);
});

test("拡張子フィルターは複合拡張子を完全一致で扱う", () => {
  const items = [
    {
      file_id: 1,
      result_kind: "file" as const,
      source_type: "local" as const,
      target_path: "/tmp/docs",
      file_name: "memo.md",
      full_path: "/tmp/docs/memo.md",
      file_ext: ".md",
      created_at: "2026-04-18T00:00:00+09:00",
      mtime: "2026-04-18T00:00:00+09:00",
      click_count: 0,
      snippet: "memo",
    },
    {
      file_id: 2,
      result_kind: "file" as const,
      source_type: "local" as const,
      target_path: "/tmp/docs",
      file_name: "board.excalidraw.md",
      full_path: "/tmp/docs/board.excalidraw.md",
      file_ext: ".excalidraw.md",
      created_at: "2026-04-18T00:00:00+09:00",
      mtime: "2026-04-18T00:00:00+09:00",
      click_count: 0,
      snippet: "board",
    },
  ];

  assert.deepEqual(
    filterSearchResultsByExtensions(items, "md").map((item) => item.file_name),
    ["memo.md"],
  );
  assert.deepEqual(
    filterSearchResultsByExtensions(items, "excalidraw.md").map((item) => item.file_name),
    ["board.excalidraw.md"],
  );
});

test("拡張子フィルターはマイナス付き拡張子（-.png, -md 等）を除外として扱う", () => {
  const items = [
    {
      file_id: 1,
      result_kind: "file" as const,
      source_type: "local" as const,
      target_path: "/tmp/docs",
      file_name: "memo.md",
      full_path: "/tmp/docs/memo.md",
      file_ext: ".md",
      created_at: "2026-04-18T00:00:00+09:00",
      mtime: "2026-04-18T00:00:00+09:00",
      click_count: 0,
      snippet: "memo",
    },
    {
      file_id: 2,
      result_kind: "file" as const,
      source_type: "local" as const,
      target_path: "/tmp/docs",
      file_name: "image.png",
      full_path: "/tmp/docs/image.png",
      file_ext: ".png",
      created_at: "2026-04-18T00:00:00+09:00",
      mtime: "2026-04-18T00:00:00+09:00",
      click_count: 0,
      snippet: "image",
    },
    {
      file_id: 3,
      result_kind: "file" as const,
      source_type: "local" as const,
      target_path: "/tmp/docs",
      file_name: "sheet.xlsx",
      full_path: "/tmp/docs/sheet.xlsx",
      file_ext: ".xlsx",
      created_at: "2026-04-18T00:00:00+09:00",
      mtime: "2026-04-18T00:00:00+09:00",
      click_count: 0,
      snippet: "sheet",
    },
  ];

  // 単独で -.png を指定した場合は .png 以外が残る
  assert.deepEqual(
    filterSearchResultsByExtensions(items, "-.png").map((item) => item.file_name),
    ["memo.md", "sheet.xlsx"],
  );

  // ドットなし -png でも同様に除外される
  assert.deepEqual(
    filterSearchResultsByExtensions(items, "-png").map((item) => item.file_name),
    ["memo.md", "sheet.xlsx"],
  );

  // 通常指定と除外指定の組み合わせ
  assert.deepEqual(
    filterSearchResultsByExtensions(items, "md xlsx -png").map((item) => item.file_name),
    ["memo.md", "sheet.xlsx"],
  );
  assert.deepEqual(
    filterSearchResultsByExtensions(items, "md -md").map((item) => item.file_name),
    [],
  );
});
