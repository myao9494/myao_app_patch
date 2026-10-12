/**
 * アプリのスタイルシートを読み込んだ状態で画面を描画し、実際の要素に適用されるスタイルを検証するテスト。
 * jsdom はレイアウトを計算しないため、確かめるのは「どの値が適用されるか」まで（見た目の位置や大きさは対象外）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { searchResponse, searchResult } from "./testing/apiFixtures.ts";
import { withApp } from "./testing/appHarness.ts";
import { click, findBySelector, findByText, styleOf } from "./testing/dom.ts";
import { closeRenderer } from "./testing/render.ts";

test.after(() => closeRenderer());

const routes = {
  "POST /api/search": searchResponse([
    searchResult({ file_name: "alpha.md", full_path: "/docs/alpha.md", match_source: "both", salient_sentence: "核心の文" }),
  ]),
  "GET /api/index/targets": { items: [{ full_path: "/docs", source_type: "local", indexed_file_count: 3, last_indexed_at: null }] },
  "GET /api/export/config": { export_folder: "/tmp/export", default_select_count: 10 },
  "POST /api/export/ai-html": {
    html_content: "<html></html>",
    file_name: "a.html",
    total_documents: 1,
    total_images_embedded: 0,
    size_bytes: 13,
    expanded_nodes: [],
  },
};

test("検索結果のフルパスは、文字を選択して部分コピーできる", async () => {
  await withApp({ routes, withStyles: true }, async (app) => {
    await app.runSearch();

    assert.equal(styleOf(findBySelector(app.container, "code.result-path-text"), "user-select"), "text");
  });
});

test("検索結果の抜粋は、折りたたんでいるあいだ 5 行で切る", async () => {
  await withApp({ routes, withStyles: true }, async (app) => {
    await app.runSearch();
    const snippet = findBySelector(app.container, "p.result-snippet-clamped");

    assert.equal(styleOf(snippet, "-webkit-line-clamp"), "5");
    assert.equal(styleOf(snippet, "overflow"), "hidden");
  });
});

test("一致理由のバッジと核心文は、種類ごとに色分けして表示する", async () => {
  await withApp({ routes, withStyles: true }, async (app) => {
    await app.runSearch();
    const badge = findBySelector(app.container, ".result-match-badge.match-both");

    assert.notEqual(styleOf(badge, "background-color"), "");
    assert.notEqual(styleOf(badge, "color"), styleOf(findBySelector(app.container, "code.result-path-text"), "color"));
    assert.notEqual(styleOf(findBySelector(app.container, ".result-salient-sentence"), "border-left-color"), "");
  });
});

test("検索対象の切り替えボタンは、幅が狭くてもラベルを折り返さない", async () => {
  await withApp({ routes, withStyles: true }, async (app) => {
    const button = findByText(app.container, "button.source-toggle-button", "ローカル");

    assert.equal(styleOf(button, "white-space"), "nowrap");
    assert.equal(styleOf(button, "flex-shrink"), "0");
    assert.equal(styleOf(findBySelector(app.container, ".source-toggle"), "flex-shrink"), "0");
    assert.equal(styleOf(findBySelector(app.container, ".path-picker-row.top-path-picker"), "flex-wrap"), "wrap");
  });
});

test("エラーの帯は赤系で表示する", async () => {
  await withApp({ routes, withStyles: true }, async (app) => {
    await app.runSearch("");

    assert.match(app.error(), /検索語を入力してください/);
    assert.match(styleOf(findBySelector(app.container, ".error-banner"), "background-color"), /239, 68, 68/);
  });
});

test("通知の帯は青系で表示する", async () => {
  await withApp(
    { routes: { ...routes, "PUT /api/index/settings": (request) => ({ ...(request.body as object) }) }, withStyles: true },
    async (app) => {
      await click(findBySelector(app.container, ".search-nav .menu-button"));
      await click(findBySelector(app.drawer(), "#confirm-index-deletion"));

      assert.match(styleOf(findBySelector(app.container, ".notice-banner"), "background-color"), /59, 130, 246/);
    },
  );
});

test("インデックス済みフォルダ画面は、一覧の部分だけを縦にスクロールさせる", async () => {
  await withApp({ routes, withStyles: true, page: "インデックス済みフォルダ" }, async (app) => {
    const list = findBySelector(app.container, ".indexed-targets-list");

    assert.equal(styleOf(list, "overflow-y"), "auto");
    assert.equal(styleOf(list, "min-height"), "0px");
  });
});

test("設定メニューは、閉じているあいだ画面の外へずらして操作できないようにし、開くと元の位置へ戻す", async () => {
  await withApp({ routes, withStyles: true }, async (app) => {
    assert.equal(styleOf(app.drawer(), "pointer-events"), "none");
    const closedTransform = styleOf(app.drawer(), "transform");

    await click(findBySelector(app.container, ".search-nav .menu-button"));

    assert.notEqual(styleOf(app.drawer(), "pointer-events"), "none");
    assert.notEqual(styleOf(app.drawer(), "transform"), closedTransform);
  });
});

test("AIインプットの候補の表は、画面の高さに合わせて広げ、表の中だけをスクロールさせる", async () => {
  await withApp({ routes, withStyles: true }, async (app) => {
    await app.runSearch();
    await app.openPage("AIインプット");
    const table = findBySelector(app.container, ".ai-candidate-table-container");

    assert.match(styleOf(table, "height"), /100vh/);
    assert.equal(styleOf(table, "max-height"), "none", "固定の高さで切らない");
    assert.equal(styleOf(table, "overflow-y"), "auto");
  });
});

test("AIインプットのプレビューは、余白なしで画面全体を使う", async () => {
  await withApp({ routes, withStyles: true }, async (app) => {
    await app.runSearch();
    await app.openPage("AIインプット");
    await click(findBySelector(app.container, "button.ai-generate-top-btn"));
    const backdrop = findBySelector(app.dom.window.document.body, ".ai-preview-modal-backdrop");
    const modal = findBySelector(backdrop, ".ai-preview-modal");

    assert.equal(styleOf(backdrop, "position"), "fixed");
    assert.equal(styleOf(backdrop, "padding"), "0px");
    assert.equal(styleOf(modal, "width"), "100vw");
    assert.equal(styleOf(modal, "height"), "100vh");
    assert.equal(styleOf(modal, "max-width"), "none");
  });
});
