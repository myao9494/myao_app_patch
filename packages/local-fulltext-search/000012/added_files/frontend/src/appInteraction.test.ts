/**
 * アプリ全体を DOM へ描画し、起動時の読み込みとページの切り替えを検証するテスト。
 * 各画面の操作は、画面ごとの *Interaction.test.ts で検証する。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { searchResponse, searchResult } from "./testing/apiFixtures.ts";
import { withApp } from "./testing/appHarness.ts";
import { findBySelector, findByText, hasElement, httpError, normalizeText, queryAllByText, typeInto } from "./testing/dom.ts";
import { closeRenderer } from "./testing/render.ts";

test.after(() => closeRenderer());

const pageRoutes = {
  "GET /api/vector/model/status": httpError(503, "unavailable"),
  "GET /api/export/config": { export_folder: "", default_select_count: 10 },
};

test("起動時に設定・状態・検索対象を読み込み、エラーを出さない", async () => {
  await withApp({}, async (app) => {
    for (const route of [
      "GET /api/index/settings",
      "GET /api/index/status",
      "GET /api/index/scheduler",
      "GET /api/launcher/status",
      "GET /api/index/search-targets",
    ]) {
      assert.ok(app.api.requestsTo(route).length >= 1, `${route} を呼ぶ`);
    }
    assert.equal(app.error(), "");
  });
});

test("上部のタブで、すべてのページへ切り替えられる", async () => {
  const pages: Array<[string, RegExp]> = [
    ["インデックス済みフォルダ", /インデックス済みフォルダ/],
    ["インデックス済みWebページ", /インデックス済みWebページ/],
    ["検索対象フォルダ", /検索対象フォルダを有効\/無効で管理/],
    ["検索ルール管理", /除外キーワード/],
    ["ベクトル管理", /Embedding|ベクトル/],
    ["AIインプット", /AI/],
    ["ランチャー", /ランチャー/],
    ["検索", /Search Results/],
  ];
  await withApp({ routes: pageRoutes }, async (app) => {
    for (const [tabName, heading] of pages) {
      await app.openPage(tabName);

      const activeTabs = queryAllByText(app.container, "button.page-tab.active", "");
      assert.deepEqual(activeTabs.map((tab) => normalizeText(tab.textContent)), [tabName]);
      assert.match(app.pageText(), heading, `${tabName} の画面を表示する`);
      assert.equal(app.error(), "", `${tabName} でエラーを出さない`);
    }
  });
});

test("管理ページを開くたびに、そのページの最新の一覧・状態を読み込む", async () => {
  await withApp({ routes: pageRoutes }, async (app) => {
    const count = (route: string): number => app.api.requestsTo(route).length;
    const before = {
      targets: count("GET /api/index/targets"),
      searchTargets: count("GET /api/index/search-targets"),
      launcher: count("GET /api/launcher/status"),
    };

    await app.openPage("インデックス済みフォルダ");
    assert.equal(count("GET /api/index/targets"), before.targets + 1);
    await app.openPage("検索対象フォルダ");
    assert.equal(count("GET /api/index/search-targets"), before.searchTargets + 1);
    await app.openPage("ランチャー");
    assert.equal(count("GET /api/launcher/status"), before.launcher + 1);
  });
});

test("ページを切り替えて戻っても、検索語・絞り込み・検索結果を保つ", async () => {
  await withApp(
    { routes: { ...pageRoutes, "POST /api/search": searchResponse([searchResult({ file_name: "alpha.md" })]) } },
    async (app) => {
      await typeInto(findBySelector<HTMLInputElement>(app.container, "input.path-input"), "/docs");
      await app.runSearch("alpha");
      await app.openPage("検索ルール管理");
      assert.equal(hasElement(app.container, "article.result-card"), false);

      await app.openPage("検索");

      assert.equal(findBySelector<HTMLInputElement>(app.container, "input.search-input").value, "alpha");
      assert.equal(findBySelector<HTMLInputElement>(app.container, "input.path-input").value, "/docs");
      assert.equal(queryAllByText(app.container, "article.result-card", "alpha.md").length, 1);
      assert.equal(app.api.requestsTo("POST /api/search").length, 1, "戻っただけでは再検索しない");
    },
  );
});

test("ページを切り替えると、前のページのエラー・通知を消す", async () => {
  await withApp({ routes: { ...pageRoutes, "POST /api/search": httpError(500, "検索に失敗しました") } }, async (app) => {
    await app.runSearch("alpha");
    assert.match(app.error(), /検索に失敗しました/);

    await app.openPage("検索ルール管理");

    assert.equal(app.error(), "");
  });
});

test("AIインプットへ切り替えると、直前の検索結果を候補として引き継ぐ", async () => {
  await withApp(
    {
      routes: {
        ...pageRoutes,
        "POST /api/search": searchResponse([
          searchResult({ file_id: 1, file_name: "alpha.md", full_path: "/docs/alpha.md" }),
          searchResult({ file_id: 2, file_name: "beta.md", full_path: "/docs/beta.md" }),
        ]),
      },
    },
    async (app) => {
      await app.runSearch("alpha");
      await app.openPage("AIインプット");

      assert.match(app.pageText(), /alpha\.md/);
      assert.match(app.pageText(), /beta\.md/);
      assert.equal(findByText(app.container, "button.page-tab.active", "AIインプット") !== null, true);
    },
  );
});
