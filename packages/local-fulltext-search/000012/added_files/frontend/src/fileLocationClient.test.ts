import assert from "node:assert/strict";
import test from "node:test";

import { deleteFile, openFileLocation } from "./api/client.ts";

/**
 * ファイル位置オープン API はパスをそのまま backend へ POST する。
 */
test("openFileLocation は対象パスを API へ送る", async () => {
  const originalFetch = globalThis.fetch;
  let capturedInput: RequestInfo | URL | undefined;
  let capturedBody: string | undefined;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedInput = input;
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ status: "success" }));
  }) as typeof fetch;

  try {
    const response = await openFileLocation("/tmp/docs/file.txt");

    assert.equal(capturedInput, "/api/files/open-location");
    assert.deepEqual(JSON.parse(capturedBody ?? "{}"), { path: "/tmp/docs/file.txt" });
    assert.deepEqual(response, { status: "success" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/**
 * 削除 API には表示中のフルパスを expected_path として渡し、サーバー側で取り違えを検知できるようにする。
 */
test("deleteFile は file_id と表示中のフルパスを DELETE /api/files/{id} へ渡す", async () => {
  const originalFetch = globalThis.fetch;
  let capturedInput = "";
  let capturedMethod = "";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedInput = String(input);
    capturedMethod = String(init?.method);
    return new Response(JSON.stringify({ status: "success", file_id: 42 }));
  }) as typeof fetch;

  try {
    const result = await deleteFile(42, "/tmp/docs/メモ & 資料.md");

    const url = new URL(capturedInput, "http://localhost");
    assert.equal(url.pathname, "/api/files/42");
    assert.equal(url.searchParams.get("expected_path"), "/tmp/docs/メモ & 資料.md");
    assert.equal(capturedMethod, "DELETE");
    assert.deepEqual(result, { status: "success", file_id: 42 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
