/**
 * 設定メニュー（設定ドロワー）を DOM へ描画し、操作のあとの API 呼び出しと表示を検証するテスト。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { appSettings, indexStatus, searchResponse, searchResult } from "./testing/apiFixtures.ts";
import { withApp, type AppHarness, type Routes } from "./testing/appHarness.ts";
import {
  click,
  findBySelector,
  findByText,
  hasElement,
  httpError,
  normalizeText,
  queryAllByText,
  selectOption,
  typeInto,
  last,
} from "./testing/dom.ts";
import { closeRenderer } from "./testing/render.ts";

test.after(() => closeRenderer());

/** 送られた設定をそのまま保存済みとして返す */
const echoSettings: Routes = {
  "PUT /api/index/settings": (request) => appSettings(request.body as Partial<ReturnType<typeof appSettings>>),
};

async function openDrawer(app: AppHarness): Promise<HTMLElement> {
  await click(findBySelector(app.container, ".search-nav .menu-button"));
  return app.drawer();
}

/** 入力欄のすぐ後ろにある「保存」ボタンと保存状態の表示を返す */
function saveRowAfter(field: Element): { button: HTMLButtonElement; status: () => string } {
  let node = field.nextElementSibling;
  while (node && !node.classList.contains("settings-action-row")) {
    node = node.nextElementSibling;
  }
  assert.ok(node, "入力欄の後ろに保存の行がある");
  const row = node;
  return {
    button: findBySelector<HTMLButtonElement>(row, "button.settings-save-button"),
    status: () => normalizeText(row.querySelector(".settings-save-status")?.textContent),
  };
}

test("設定メニューは、設定ボタンで開き、閉じるボタンで閉じる", async () => {
  await withApp({}, async (app) => {
    assert.equal(app.isDrawerOpen(), false);

    const drawer = await openDrawer(app);
    assert.equal(app.isDrawerOpen(), true);
    assert.equal(drawer.getAttribute("aria-hidden"), "false");

    await click(findByText(drawer, "button", "閉じる"));
    assert.equal(app.isDrawerOpen(), false);
  });
});

test("設定メニューから、スケジューラー・ベクトル管理・AIインプット・ランチャーの各画面へ移れる", async () => {
  const destinations: Array<[string, RegExp]> = [
    ["スケジューラー", /スケジューラー/],
    ["ベクトル管理", /Embedding|ベクトル/],
    ["AIインプット", /AI/],
    ["ランチャー", /ランチャー/],
  ];
  for (const [label, heading] of destinations) {
    await withApp(
      {
        routes: {
          "GET /api/vector/model/status": httpError(503, "unavailable"),
          "GET /api/export/config": { export_folder: "", default_select_count: 10 },
        },
      },
      async (app) => {
        const drawer = await openDrawer(app);
        await click(findByText(drawer, ".settings-action-row > button", label));

        assert.equal(hasElement(app.container, "input.search-input") && hasElement(app.container, "article.result-card"), false);
        assert.match(app.pageText(), heading, `${label} の画面を表示する`);
      },
    );
  }
});

test("スケジューラーを開くと、設定メニューを閉じて最新のスケジューラー状態を読み込む", async () => {
  await withApp({}, async (app) => {
    const before = app.api.requestsTo("GET /api/index/scheduler").length;
    const drawer = await openDrawer(app);
    await click(findByText(drawer, ".settings-action-row > button", "スケジューラー"));

    assert.equal(app.isDrawerOpen(), false);
    assert.equal(app.api.requestsTo("GET /api/index/scheduler").length, before + 1);
  });
});

test("設定メニューに、既定の検索フォルダ・除外キーワード・インデックス対象拡張子の入力欄は置かない", async () => {
  await withApp({}, async (app) => {
    const drawer = await openDrawer(app);
    const fieldIds = [...drawer.querySelectorAll("input, textarea, select")].map((element) => element.id);

    assert.deepEqual(fieldIds.sort(), [
      "confirm-index-deletion",
      "gantt-parent",
      "obsidian-sidebar-explorer-data-path",
      "refresh-window",
      "ui-zoom",
      "web-exclude-keywords",
      "web-fetch-mode",
    ]);
  });
});

test("表示倍率は、スライダーでアプリの表示だけを変え、次回の起動でも同じ倍率を使う", async () => {
  await withApp({}, async (app) => {
    const drawer = await openDrawer(app);
    const slider = findBySelector<HTMLInputElement>(drawer, "#ui-zoom");
    await typeInto(slider, "110");

    assert.equal(app.dom.window.document.body.style.getPropertyValue("zoom") || (app.dom.window.document.body.style as unknown as { zoom: string }).zoom, "1.1");
    assert.equal(app.dom.window.localStorage.getItem("ui_zoom"), "110");
    assert.match(normalizeText(findBySelector(drawer, ".zoom-settings").textContent), /110\s*%/);

    await click(findByText(drawer, "button", "100%に戻す"));
    assert.equal(app.dom.window.localStorage.getItem("ui_zoom"), "100");
  });

  await withApp({ storage: { ui_zoom: "90" } }, async (app) => {
    assert.equal(findBySelector<HTMLInputElement>(app.drawer(), "#ui-zoom").value, "90");
  });
});

test("Web 除外キーワードは、変更すると未保存と表示し、保存ボタンで保存する", async () => {
  await withApp({ routes: echoSettings }, async (app) => {
    const drawer = await openDrawer(app);
    const textarea = findBySelector<HTMLTextAreaElement>(drawer, "#web-exclude-keywords");
    const saveRow = saveRowAfter(textarea);
    assert.equal(saveRow.button.disabled, true);
    assert.equal(saveRow.status(), "保存済み");

    await typeInto(textarea, "/login\n/tag/");
    assert.equal(saveRowAfter(textarea).button.disabled, false);
    assert.notEqual(saveRowAfter(textarea).status(), "保存済み");

    await click(saveRowAfter(textarea).button);

    assert.deepEqual(app.lastBody("PUT /api/index/settings"), { web_exclude_keywords: "/login\n/tag/" });
    assert.equal(saveRowAfter(textarea).status(), "保存済み");
  });
});

test("未保存の Web 除外キーワードがあるまま Web を検索すると、今回の検索には反映していないと知らせる", async () => {
  await withApp({ routes: { "POST /api/search": searchResponse([searchResult()]) } }, async (app) => {
    const drawer = await openDrawer(app);
    await typeInto(findBySelector<HTMLTextAreaElement>(drawer, "#web-exclude-keywords"), "/login");
    await click(findByText(app.container, "button.source-toggle-button", "Web"));
    await app.runSearch();

    assert.match(app.notice(), /未保存のWeb除外キーワードは今回の検索に反映していません/);
  });
});

test("Web ページの取得方式は、選んだ時点で共有設定へ保存する", async () => {
  await withApp({ routes: echoSettings }, async (app) => {
    const drawer = await openDrawer(app);
    await selectOption(findBySelector<HTMLSelectElement>(drawer, "#web-fetch-mode"), "edge");

    assert.deepEqual(app.lastBody("PUT /api/index/settings"), { web_fetch_mode: "edge" });
    assert.equal(findBySelector<HTMLSelectElement>(drawer, "#web-fetch-mode").value, "edge");
  });
});

test("Obsidian の data.json のパスと gantt parent は、それぞれの保存ボタンで保存する", async () => {
  await withApp({ routes: echoSettings }, async (app) => {
    const drawer = await openDrawer(app);
    const obsidian = findBySelector<HTMLTextAreaElement>(drawer, "#obsidian-sidebar-explorer-data-path");
    await typeInto(obsidian, "  /Users/me/Vault/.obsidian/plugins/x/data.json  ");
    await click(saveRowAfter(obsidian).button);

    assert.deepEqual(app.lastBody("PUT /api/index/settings"), {
      obsidian_sidebar_explorer_data_path: "/Users/me/Vault/.obsidian/plugins/x/data.json",
    });

    const gantt = findBySelector<HTMLInputElement>(drawer, "#gantt-parent");
    await typeInto(gantt, "42");
    await click(saveRowAfter(gantt).button);

    assert.deepEqual(app.lastBody("PUT /api/index/settings"), { gantt_parent: 42 });
    assert.match(app.notice(), /gantt parent を保存しました/);
  });
});

test("インデックス削除時の確認は、チェックを切り替えた時点で保存する", async () => {
  await withApp({ routes: echoSettings }, async (app) => {
    const drawer = await openDrawer(app);
    const checkbox = findBySelector<HTMLInputElement>(drawer, "#confirm-index-deletion");
    assert.equal(checkbox.checked, true);

    await click(checkbox);

    assert.deepEqual(app.lastBody("PUT /api/index/settings"), { confirm_index_deletion: false });
    assert.equal(findBySelector<HTMLInputElement>(drawer, "#confirm-index-deletion").checked, false);
    assert.match(app.notice(), /確認通知を無効にしました/);
  });
});

test("インデックス更新間隔を変えると、その分数で検索し、次回の起動でも同じ値を使う", async () => {
  await withApp({ routes: { "POST /api/search": searchResponse([searchResult()]) } }, async (app) => {
    const drawer = await openDrawer(app);
    await typeInto(findBySelector<HTMLInputElement>(drawer, "#refresh-window"), "30");
    await app.runSearch();

    assert.equal(app.lastBody("POST /api/search").refresh_window_minutes, 30);
    assert.equal(app.dom.window.localStorage.getItem("refresh_window_minutes"), "30");
  });
});

test("インデックス更新間隔が不正なときは検索せず、設定メニューを開いて知らせる", async () => {
  await withApp({}, async (app) => {
    const drawer = await openDrawer(app);
    await typeInto(findBySelector<HTMLInputElement>(drawer, "#refresh-window"), "-1");
    await click(findByText(drawer, "button", "閉じる"));
    await app.runSearch();

    assert.equal(app.api.requestsTo("POST /api/search").length, 0);
    assert.match(app.error(), /更新間隔は 0 以上の分で入力してください/);
    assert.equal(app.isDrawerOpen(), true);
  });
});

test("失敗したファイルの一覧は、開いたときに読み込み、開いているあいだは検索のたびに更新する", async () => {
  let failedFiles = [
    { normalized_path: "/docs/broken.pdf", file_name: "broken.pdf", error_message: "壊れた PDF", last_failed_at: "2026-01-01T00:00:00Z" },
  ];
  await withApp(
    {
      routes: {
        "GET /api/index/failed-files": () => ({ items: failedFiles }),
        "POST /api/search": searchResponse([searchResult()]),
      },
    },
    async (app) => {
      const drawer = await openDrawer(app);
      assert.equal(app.api.requestsTo("GET /api/index/failed-files").length, 0, "開くまでは読み込まない");

      await click(findByText(drawer, "button", "失敗したファイル"));
      assert.equal(app.api.requestsTo("GET /api/index/failed-files").length, 1);
      assert.match(normalizeText(drawer.textContent), /broken\.pdf/);
      assert.match(normalizeText(drawer.textContent), /壊れた PDF/);

      failedFiles = [];
      await app.runSearch();
      assert.equal(app.api.requestsTo("GET /api/index/failed-files").length, 2);
      assert.match(normalizeText(drawer.textContent), /記録されている失敗ファイルはありません/);
    },
  );
});

test("データベースの初期化は、確認のうえ実行し、検索結果・失敗ファイル・状態表示を初期状態へ戻す", async () => {
  const resetStatus = indexStatus({ total_files: 0, error_count: 0 });
  await withApp(
    {
      routes: {
        "GET /api/index/status": indexStatus({ total_files: 120, error_count: 2 }),
        "GET /api/index/failed-files": {
          items: [{ normalized_path: "/docs/broken.pdf", file_name: "broken.pdf", error_message: "壊れた PDF", last_failed_at: "2026-01-01T00:00:00Z" }],
        },
        "POST /api/search": searchResponse([searchResult({ file_name: "alpha.md" })]),
        "POST /api/index/reset": { message: "reset", status: resetStatus },
      },
    },
    async (app) => {
      await app.runSearch();
      const drawer = await openDrawer(app);
      await click(findByText(drawer, "button", "失敗したファイル"));
      assert.match(normalizeText(findBySelector(drawer, ".status-card").textContent), /総ファイル数: 120/);

      app.dom.setConfirmAnswer(false);
      await click(findByText(drawer, "button", "データベースを初期化"));
      assert.equal(app.api.requestsTo("POST /api/index/reset").length, 0, "確認を断ったら初期化しない");
      assert.match(last(app.dom.dialogs) ?? "", /検索インデックス、対象キャッシュ、失敗履歴がすべて消えます/);

      app.dom.setConfirmAnswer(true);
      await click(findByText(drawer, "button", "データベースを初期化"));

      assert.equal(app.api.requestsTo("POST /api/index/reset").length, 1);
      assert.match(app.notice(), /データベースを初期化しました/);
      assert.equal(hasElement(app.container, "article.result-card"), false);
      assert.match(normalizeText(findBySelector(drawer, ".status-card").textContent), /総ファイル数: 0/);
      assert.doesNotMatch(normalizeText(drawer.textContent), /broken\.pdf/);

      await app.openPage("検索対象フォルダ");
      assert.equal(queryAllByText(app.container, ".target-list-item", "").length, 0);
    },
  );
});

test("データベースの初期化に失敗したら、理由をエラーとして表示し、検索結果は残す", async () => {
  await withApp(
    {
      routes: {
        "POST /api/search": searchResponse([searchResult({ file_name: "alpha.md" })]),
        "POST /api/index/reset": httpError(409, "Indexing is already running."),
      },
    },
    async (app) => {
      await app.runSearch();
      const drawer = await openDrawer(app);
      await click(findByText(drawer, "button", "データベースを初期化"));

      assert.match(app.error(), /Indexing is already running\./);
      assert.equal(hasElement(app.container, "article.result-card"), true);
    },
  );
});

test("設定の読み込みに失敗したら、起動時にエラーを表示する", async () => {
  await withApp({ routes: { "GET /api/index/settings": httpError(500, "設定を読めません") } }, async (app) => {
    assert.match(app.error(), /設定を読めません/);
  });
});
