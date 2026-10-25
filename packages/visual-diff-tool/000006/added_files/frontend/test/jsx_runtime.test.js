/**
 * ビルド設定の前提を守るテスト。
 * vite.config を置かずに esbuild の既定（クラシックJSX変換: React.createElement）でビルドしているため、
 * JSXを含むファイルは必ず React を import していなければならない（無いと画面が真っ白になる）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

function listJsxFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listJsxFiles(path);
    return entry.name.endsWith(".jsx") ? [path] : [];
  });
}

test("すべての .jsx ファイルが React を import している", () => {
  const missing = listJsxFiles(SRC).filter((file) => !/^import React\b/m.test(readFileSync(file, "utf8")));
  assert.deepEqual(missing, []);
});
