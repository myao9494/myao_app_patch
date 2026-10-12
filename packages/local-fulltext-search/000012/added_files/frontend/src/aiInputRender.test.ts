/**
 * AIインプット画面のフックと部品を、実際に呼び出して検証するテスト。
 * ブラウザーを使わないサーバー描画のため、検証できるのは初期状態と表示内容だけ（操作や通信は行わない）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";

import { closeRenderer, installBrowserStubs, loadSourceModule, renderToHtml, visibleText } from "./testing/render.ts";
import type { UseAiExportOptionsResult } from "./hooks/useAiExportOptions.ts";
import type { SearchResult } from "./types.ts";

test.before(() => installBrowserStubs());
test.after(() => closeRenderer());

function searchResult(fileName: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    file_id: 1,
    result_kind: "file",
    target_path: "/vault",
    file_name: fileName,
    full_path: `/vault/${fileName}`,
    file_ext: fileName.slice(fileName.lastIndexOf(".")),
    created_at: "2026-10-01T00:00:00Z",
    mtime: "2026-10-01T00:00:00Z",
    click_count: 0,
    snippet: "",
    ...overrides,
  } as SearchResult;
}

test("出力オプションの既定値: 画像とリンクされたメールは含め、Markdown 原文は含めない", async () => {
  const { useAiExportOptions } = await loadSourceModule<typeof import("./hooks/useAiExportOptions.ts")>(
    "/src/hooks/useAiExportOptions.ts",
  );
  let options: UseAiExportOptionsResult | null = null;
  renderToHtml(() => {
    options = useAiExportOptions();
    return null;
  }, {});

  assert.ok(options);
  const loaded = options as UseAiExportOptionsResult;
  // Markdown 原文まで含めると、本文と重複してトークンを消費するため既定では含めない
  assert.equal(loaded.includeRawMarkdown, false);
  assert.equal(loaded.includeImages, true);
  assert.equal(loaded.includeLinkedEmails, true);
  assert.equal(loaded.optimizeTokens, true);
});

test("検索結果から開いたとき、文書として扱えるファイルだけが候補になり、既定の拡張子フィルターは md", async () => {
  const { AiInputPage } = await loadSourceModule<typeof import("./components/AiInputPage.tsx")>(
    "/src/components/AiInputPage.tsx",
  );
  const html = renderToHtml(
    () =>
      createElement(AiInputPage, {
        results: [
          searchResult("design-note.md", { file_id: 1 }),
          searchResult("diagram.png", { file_id: 2 }),
          searchResult("drawing.excalidraw.md", { file_id: 3 }),
          searchResult("report.pdf", { file_id: 4 }),
        ],
        excludeKeywords: "",
      }),
    {},
  );
  const text = visibleText(html);

  assert.match(html, /value="md"/, "拡張子フィルターの初期値は md");
  assert.match(text, /ステップ 2/, "候補があるので選択用の一覧が表示される");
  assert.match(text, /design-note\.md/);
  assert.doesNotMatch(text, /diagram\.png/, "画像は候補にしない");
  assert.doesNotMatch(text, /drawing\.excalidraw\.md/, "図面は候補にしない");
  assert.doesNotMatch(text, /report\.pdf/, "拡張子フィルター（md）に合わないものは表示しない");
});

test("除外キーワードに合致するパスのノートは候補に出さない", async () => {
  const { AiInputPage } = await loadSourceModule<typeof import("./components/AiInputPage.tsx")>(
    "/src/components/AiInputPage.tsx",
  );
  const text = visibleText(
    renderToHtml(
      () =>
        createElement(AiInputPage, {
          results: [
            searchResult("keep.md", { file_id: 1 }),
            searchResult("secret.md", { file_id: 2, full_path: "/vault/private/secret.md" }),
          ],
          excludeKeywords: "private",
        }),
      {},
    ),
  );

  assert.match(text, /keep\.md/);
  assert.doesNotMatch(text, /secret\.md/);
});

test("候補が無いときは、候補の選択（ステップ 2）と生成結果（ステップ 3）を表示しない", async () => {
  const { AiInputPage } = await loadSourceModule<typeof import("./components/AiInputPage.tsx")>(
    "/src/components/AiInputPage.tsx",
  );
  const text = visibleText(renderToHtml(() => createElement(AiInputPage, { results: [] }), {}));

  assert.match(text, /ステップ 1/);
  assert.doesNotMatch(text, /ステップ 2/);
  assert.doesNotMatch(text, /ステップ 3/);
});
