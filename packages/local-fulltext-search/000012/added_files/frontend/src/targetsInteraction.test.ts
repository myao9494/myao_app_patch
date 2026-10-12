/**
 * インデックス済みフォルダ・インデックス済み Web ページ・検索対象フォルダの各画面を DOM へ描画し、
 * 操作のあとの API 呼び出しと表示を検証するテスト。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { appSettings, indexStatus, searchResponse, searchResult } from "./testing/apiFixtures.ts";
import { withApp, type Routes } from "./testing/appHarness.ts";
import { click, findBySelector, findByText, hasElement, normalizeText, queryAllByText, typeInto, wait, last } from "./testing/dom.ts";
import { closeRenderer } from "./testing/render.ts";

test.after(() => closeRenderer());

const indexedTargets = [
  { full_path: "/docs", source_type: "local", indexed_file_count: 12, last_indexed_at: "2026-01-01T00:00:00Z" },
  { full_path: "/docs/archive", source_type: "local", indexed_file_count: 2, last_indexed_at: "2026-01-01T00:00:00Z" },
  { full_path: "/work/notes", source_type: "local", indexed_file_count: 5, last_indexed_at: null },
];
const searchTargets = [
  { full_path: "/docs", source_type: "local", is_enabled: true, last_indexed_at: "2026-01-01T00:00:00Z", indexed_file_count: 12 },
  { full_path: "/work/notes", source_type: "local", is_enabled: false, last_indexed_at: null, indexed_file_count: 0 },
];

function targetRoutes(overrides: Routes = {}): Routes {
  return {
    "GET /api/index/targets": { items: indexedTargets },
    "GET /api/index/search-targets": { items: searchTargets },
    ...overrides,
  };
}

function listedPaths(container: ParentNode): string[] {
  return [...container.querySelectorAll(".target-list-path")].map((element) => normalizeText(element.textContent));
}

function row(container: ParentNode, path: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>(".target-list-item")].find(
    (item) => normalizeText(item.querySelector(".target-list-path")?.textContent) === path,
  );
  assert.ok(found, `${path} の行が表示される`);
  return found;
}

test("インデックス済みフォルダ画面は、一覧をファイル数の多い順に並べ、件数・ファイル数を表示する", async () => {
  await withApp({ routes: targetRoutes(), page: "インデックス済みフォルダ" }, async (app) => {
    assert.equal(last(app.api.requestsTo("GET /api/index/targets"))?.query.get("source_type"), "local");
    assert.deepEqual(listedPaths(app.container), ["/docs", "/work/notes", "/docs/archive"]);
    assert.match(normalizeText(findBySelector(app.container, ".section-header-actions").textContent), /3\s*件/);
    assert.match(normalizeText(row(app.container, "/docs").textContent), /ファイル数\s*:\s*12/);
  });
});

test("キーワードで一覧を絞り込み、クリアで戻せる", async () => {
  await withApp({ routes: targetRoutes(), page: "インデックス済みフォルダ" }, async (app) => {
    const filter = findBySelector<HTMLInputElement>(app.container, "input.indexed-targets-search");
    await typeInto(filter, "archive");

    assert.deepEqual(listedPaths(app.container), ["/docs/archive"]);

    await click(findBySelector(app.container, "button[aria-label='絞り込みをクリア']"));
    assert.equal(listedPaths(app.container).length, 3);
  });
});

test("絞り込みに使ったキーワードを除外キーワードの下書きへ追加でき、検索ルール管理で保存待ちになる", async () => {
  await withApp({ routes: targetRoutes(), page: "インデックス済みフォルダ" }, async (app) => {
    const addButton = findByText(app.container, "button", "除外キーワードへ追加") as HTMLButtonElement;
    assert.equal(addButton.disabled, true, "キーワードが空のあいだは押せない");

    await typeInto(findBySelector<HTMLInputElement>(app.container, "input.indexed-targets-search"), "archive");
    await click(findByText(app.container, "button", "除外キーワードへ追加"));

    assert.match(app.notice(), /「archive」を除外キーワードへ追加しました/);
    assert.equal(findBySelector<HTMLInputElement>(app.container, "input.indexed-targets-search").value, "");
    assert.equal(app.isDrawerOpen(), true);

    await app.openPage("検索ルール管理");
    assert.match(app.text(), /archive/);
  });
});

test("非表示キーワードは一覧から該当フォルダを隠し、共有設定へ自動で保存する", async () => {
  await withApp(
    {
      routes: targetRoutes({
        "PUT /api/index/settings": (request) =>
          appSettings({ hidden_indexed_targets: (request.body as { hidden_indexed_targets: string }).hidden_indexed_targets }),
      }),
      page: "インデックス済みフォルダ",
    },
    async (app) => {
      await typeInto(findBySelector<HTMLTextAreaElement>(app.container, "textarea.indexed-targets-hide-box"), "work");

      assert.deepEqual(listedPaths(app.container), ["/docs", "/docs/archive"]);

      await wait(450);
      assert.deepEqual(app.lastBody("PUT /api/index/settings"), { hidden_indexed_targets: "work" });
    },
  );
});

test("保存済みの非表示キーワードは、開いた時点で一覧に効いている", async () => {
  await withApp(
    {
      routes: targetRoutes({ "GET /api/index/settings": appSettings({ hidden_indexed_targets: "archive" }) }),
      page: "インデックス済みフォルダ",
    },
    async (app) => {
      assert.deepEqual(listedPaths(app.container), ["/docs", "/work/notes"]);
      assert.equal(findBySelector<HTMLTextAreaElement>(app.container, "textarea.indexed-targets-hide-box").value, "archive");
    },
  );
});

test("選択したフォルダのインデックスを、確認のうえ削除し、検索結果も空にする", async () => {
  let remaining = indexedTargets;
  await withApp(
    {
      routes: targetRoutes({
        "GET /api/index/targets": () => ({ items: remaining }),
        "DELETE /api/index/targets": (request) => {
          const paths = (request.body as { target_paths: string[] }).target_paths;
          remaining = remaining.filter((item) => !paths.includes(item.full_path));
          return { deleted_count: paths.length };
        },
        "POST /api/search": searchResponse([searchResult({ file_name: "alpha.md", full_path: "/docs/archive/alpha.md" })]),
      }),
    },
    async (app) => {
      await app.runSearch();
      await app.openPage("インデックス済みフォルダ");
      const deleteButton = () => findByText(app.container, "button", "選択したフォルダのインデックスを削除") as HTMLButtonElement;
      assert.equal(deleteButton().disabled, true, "何も選んでいないあいだは押せない");

      await click(findBySelector(row(app.container, "/docs/archive"), "input[type='checkbox']"));
      assert.match(normalizeText(findBySelector(app.container, ".indexed-targets-selection-status").textContent), /選択中: 1件/);

      app.dom.setConfirmAnswer(false);
      await click(deleteButton());
      assert.equal(app.api.requestsTo("DELETE /api/index/targets").length, 0, "確認を断ったら削除しない");

      app.dom.setConfirmAnswer(true);
      await click(deleteButton());

      assert.deepEqual(app.lastBody("DELETE /api/index/targets"), { target_paths: ["/docs/archive"] });
      assert.deepEqual(listedPaths(app.container), ["/docs", "/work/notes"]);
      assert.match(app.notice(), /1件のインデックス済みフォルダを削除し、一覧への反映を確認しました/);

      await app.openPage("検索");
      assert.equal(hasElement(app.container, "article.result-card"), false, "削除したインデックスの検索結果を残さない");
    },
  );
});

test("インデックス取得中は削除ボタンを押せない", async () => {
  await withApp(
    { routes: targetRoutes({ "GET /api/index/status": indexStatus({ is_running: true }) }), page: "インデックス済みフォルダ" },
    async (app) => {
      await click(findByText(app.container, "button", "すべて選択"));

      assert.equal((findByText(app.container, "button", "選択したフォルダのインデックスを削除") as HTMLButtonElement).disabled, true);
    },
  );
});

test("削除を押した時点でインデックス取得が始まっていたら、削除せず完了を待つよう案内する", async () => {
  let status = indexStatus();
  await withApp(
    { routes: targetRoutes({ "GET /api/index/status": () => status }), page: "インデックス済みフォルダ" },
    async (app) => {
      await click(findByText(app.container, "button", "すべて選択"));
      status = indexStatus({ is_running: true });
      await click(findByText(app.container, "button", "選択したフォルダのインデックスを削除"));

      assert.equal(app.api.requestsTo("DELETE /api/index/targets").length, 0);
      assert.match(app.notice(), /インデックス取得中のため、削除は完了後に実行できます/);
    },
  );
});

test("削除後の一覧に対象が残っていたら、成功とせずエラーにする", async () => {
  await withApp(
    {
      routes: targetRoutes({ "DELETE /api/index/targets": { deleted_count: 1 } }),
      page: "インデックス済みフォルダ",
    },
    async (app) => {
      await click(findBySelector(row(app.container, "/docs/archive"), "input[type='checkbox']"));
      await click(findByText(app.container, "button", "選択したフォルダのインデックスを削除"));

      assert.match(app.error(), /削除後の一覧確認で1件が残っています/);
    },
  );
});

test("インデックス済み Web ページ画面は Web の一覧を読み込み、キーワードは Web 用の除外キーワードへ追加する", async () => {
  await withApp(
    {
      routes: targetRoutes({
        "GET /api/index/targets": (request) => ({
          items:
            request.query.get("source_type") === "web"
              ? [{ full_path: "https://example.com/docs", source_type: "web", indexed_file_count: 4, last_indexed_at: null }]
              : indexedTargets,
        }),
      }),
      page: "インデックス済みWebページ",
    },
    async (app) => {
      assert.equal(last(app.api.requestsTo("GET /api/index/targets"))?.query.get("source_type"), "web");
      assert.deepEqual(listedPaths(app.container), ["https://example.com/docs"]);
      assert.equal(queryAllByText(app.container, "button", "Finderで開く").length, 0, "Web ページに Finder で開くボタンは出さない");

      await typeInto(findBySelector<HTMLInputElement>(app.container, "input.indexed-targets-search"), "example");
      await click(findByText(app.container, "button", "Web除外キーワードへ追加"));

      assert.match(app.notice(), /「example」をWeb除外キーワードへ追加しました/);
      assert.equal(app.isDrawerOpen(), true);
      assert.equal(findBySelector<HTMLTextAreaElement>(app.drawer(), "textarea").value, "example");
    },
  );
});

test("インデックス済みフォルダ画面からも設定メニューを開ける", async () => {
  await withApp({ routes: targetRoutes(), page: "インデックス済みフォルダ" }, async (app) => {
    assert.equal(app.isDrawerOpen(), false);

    await click(findBySelector(app.container, ".section-header-actions button[aria-label='設定']"));

    assert.equal(app.isDrawerOpen(), true);
  });
});

test("検索対象フォルダ画面は、登録済みのフォルダと有効・無効の状態を表示する", async () => {
  await withApp({ routes: targetRoutes(), page: "検索対象フォルダ" }, async (app) => {
    assert.deepEqual(listedPaths(app.container), ["/docs", "/work/notes"]);
    assert.equal(findBySelector<HTMLInputElement>(row(app.container, "/docs"), "input[type='checkbox']").checked, true);
    assert.equal(findBySelector<HTMLInputElement>(row(app.container, "/work/notes"), "input[type='checkbox']").checked, false);
    assert.match(normalizeText(findBySelector(app.container, ".indexed-targets-selection-status").textContent), /対象中: 1件 \/ 全2件/);
  });
});

test("チェックを切り替えると、そのフォルダの有効・無効を保存する", async () => {
  await withApp(
    {
      routes: targetRoutes({
        "PUT /api/index/search-targets": (request) => {
          const body = request.body as { folder_path: string; is_enabled: boolean };
          return {
            items: searchTargets.map((item) => (item.full_path === body.folder_path ? { ...item, is_enabled: body.is_enabled } : item)),
          };
        },
      }),
      page: "検索対象フォルダ",
    },
    async (app) => {
      await click(findBySelector(row(app.container, "/work/notes"), "input[type='checkbox']"));

      assert.deepEqual(app.lastBody("PUT /api/index/search-targets"), { folder_path: "/work/notes", is_enabled: true });
      assert.equal(findBySelector<HTMLInputElement>(row(app.container, "/work/notes"), "input[type='checkbox']").checked, true);
    },
  );
});

test("検索対象フォルダは、確認のうえ登録だけを外せる（インデックスは消さない）", async () => {
  let targets = searchTargets;
  await withApp(
    {
      routes: targetRoutes({
        "GET /api/index/search-targets": () => ({ items: targets }),
        "DELETE /api/index/search-targets": (request) => {
          const paths = (request.body as { folder_paths: string[] }).folder_paths;
          targets = targets.filter((item) => !paths.includes(item.full_path));
          return { deleted_count: paths.length };
        },
      }),
      page: "検索対象フォルダ",
    },
    async (app) => {
      await click(findByText(row(app.container, "/work/notes"), "button", "削除"));

      assert.match(last(app.dom.dialogs) ?? "", /検索対象フォルダから削除しますか/);
      assert.deepEqual(app.lastBody("DELETE /api/index/search-targets"), { folder_paths: ["/work/notes"] });
      assert.equal(app.api.requestsTo("DELETE /api/index/targets").length, 0);
      assert.deepEqual(listedPaths(app.container), ["/docs"]);
      assert.match(app.notice(), /1件の検索対象フォルダを削除しました/);
    },
  );
});

test("行のボタンで、そのフォルダのインデックス削除と再取得を実行できる", async () => {
  await withApp(
    {
      routes: targetRoutes({
        "DELETE /api/index/targets": { deleted_count: 1 },
        "POST /api/index/search-targets/reindex": { reindexed_count: 1 },
      }),
      page: "検索対象フォルダ",
    },
    async (app) => {
      await click(findByText(row(app.container, "/docs"), "button", "インデックス削除"));
      assert.deepEqual(app.lastBody("DELETE /api/index/targets"), { target_paths: ["/docs"] });
      assert.match(app.notice(), /1件のインデックスを削除しました/);

      await click(findByText(row(app.container, "/docs"), "button", "インデックス再取得"));
      assert.deepEqual(app.lastBody("POST /api/index/search-targets/reindex"), { folder_paths: ["/docs"] });
      assert.match(app.notice(), /1件のインデックスを再取得しました/);
    },
  );
});

test("インデックス取得ボタンは、有効な検索対象だけをまとめて取得する", async () => {
  await withApp(
    { routes: targetRoutes({ "POST /api/index/search-targets/reindex": { reindexed_count: 1 } }), page: "検索対象フォルダ" },
    async (app) => {
      await click(findByText(app.container, "button.indexed-targets-primary-action", "インデックス取得"));

      assert.deepEqual(app.lastBody("POST /api/index/search-targets/reindex"), { folder_paths: ["/docs"] });
      assert.match(app.notice(), /1件の検索対象フォルダをインデックス取得しました/);
    },
  );
});

test("検索欄のフォルダを検索対象へ追加すると、全データベース検索を解除してそのフォルダを対象にする", async () => {
  let registered = searchTargets;
  await withApp(
    {
      routes: targetRoutes({
        "GET /api/index/search-targets": () => ({ items: registered }),
        "POST /api/index/search-targets": (request) => {
          registered = [...registered, { ...searchTargets[0], full_path: (request.body as { folder_path: string }).folder_path }];
          return { items: registered };
        },
      }),
    },
    async (app) => {
      await click(findBySelector(app.container, "button.search-all-button"));
      const pathInput = findBySelector<HTMLInputElement>(app.container, "input.path-input");
      await typeInto(pathInput, "/other");
      await wait(260);
      const addButton = queryAllByText(app.container, "button", "検索対象").find((button) => !button.classList.contains("page-tab"));
      assert.ok(addButton);

      await click(addButton);

      // 階層の欄が空（無制限）なら、無制限として登録する
      assert.deepEqual(app.lastBody("POST /api/index/search-targets"), { folder_path: "/other", index_depth: null });
      assert.equal(findBySelector(app.container, "button.search-all-button").getAttribute("aria-pressed"), "false");

      await app.openPage("検索対象フォルダ");
      assert.deepEqual(listedPaths(app.container), ["/docs", "/work/notes", "/other"]);
    },
  );
});
