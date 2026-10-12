/**
 * 外部のファイルハブ（Open hub）で開く URL の組み立てのテスト。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenHubFileUrl, buildOpenHubFolderUrl, resolveOpenHubBaseUrl } from "./openHub.ts";

test("接続先の既定は自端末の 8001 番", () => {
  assert.equal(resolveOpenHubBaseUrl(undefined), "http://127.0.0.1:8001");
  assert.equal(resolveOpenHubBaseUrl({}), "http://127.0.0.1:8001");
  assert.equal(resolveOpenHubBaseUrl({ VITE_OPEN_HUB_BASE_URL: "  " }), "http://127.0.0.1:8001");
});

test("ビルド時の設定で接続先を差し替えられ、末尾のスラッシュは取り除く", () => {
  assert.equal(resolveOpenHubBaseUrl({ VITE_OPEN_HUB_BASE_URL: "http://hub.local:9000//" }), "http://hub.local:9000");
});

test("ファイルは /api/fullpath、フォルダは /?path へ、パスを URL エンコードして渡す", () => {
  const env = { VITE_OPEN_HUB_BASE_URL: "http://hub.local:9000/" };

  assert.equal(
    buildOpenHubFileUrl("/Users/me/メモ & 資料/a b.md", env),
    "http://hub.local:9000/api/fullpath?path=%2FUsers%2Fme%2F%E3%83%A1%E3%83%A2%20%26%20%E8%B3%87%E6%96%99%2Fa%20b.md",
  );
  assert.equal(buildOpenHubFolderUrl("C:\\docs\\設計", env), "http://hub.local:9000/?path=C%3A%5Cdocs%5C%E8%A8%AD%E8%A8%88");
});
