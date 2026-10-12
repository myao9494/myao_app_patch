/**
 * 検索画面（検索欄・絞り込み・検索結果）を DOM へ描画し、操作のあとの API 呼び出しと表示を検証するテスト。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { appSettings, indexStatus, installAppApi, searchResponse, searchResult } from "./testing/apiFixtures.ts";
import {
  click,
  findBySelector,
  findByText,
  hasElement,
  installDom,
  last,
  mount,
  normalizeText,
  pressKey,
  queryAllByText,
  selectOption,
  typeInto,
  wait,
} from "./testing/dom.ts";
import { closeRenderer, loadSourceModule } from "./testing/render.ts";

type AppModule = typeof import("./App.tsx");
type Routes = NonNullable<Parameters<typeof installAppApi>[0]>;

test.after(() => closeRenderer());

const alpha = searchResult({
  file_id: 1,
  file_name: "alpha.md",
  full_path: "/docs/alpha.md",
  match_source: "both",
  match_type: "both",
  salient_sentence: "核心の文",
  click_count: 3,
  snippet: "本文 <mark>alpha</mark>",
});
const beta = searchResult({
  file_id: 2,
  file_name: "beta.txt",
  full_path: "/docs/sub/beta.txt",
  file_ext: ".txt",
  match_source: "vector",
  match_type: "vector_only",
});
const keywordOnly = searchResult({
  file_id: 3,
  file_name: "gamma.md",
  full_path: "/docs/gamma.md",
  match_source: "keyword",
  match_type: "keyword_only",
});
const folder = searchResult({ file_id: -1, result_kind: "folder", file_name: "sub", full_path: "/docs/sub", file_ext: "" });

async function openApp(options: { search?: string; storage?: Record<string, string>; routes?: Routes } = {}) {
  const dom = installDom({ search: options.search, storage: options.storage });
  const api = installAppApi({ "POST /api/search": searchResponse([alpha, beta, keywordOnly, folder]), ...options.routes });
  const { default: App } = await loadSourceModule<AppModule>("/src/App.tsx");
  const view = await mount(App, {});
  const container = view.container;
  return {
    api,
    dom,
    container,
    text: () => normalizeText(container.textContent),
    resultCount: () => normalizeText(findBySelector(container, ".section-header span").textContent),
    searchInput: () => findBySelector<HTMLInputElement>(container, "input.search-input"),
    runSearch: async (query = "alpha") => {
      await typeInto(findBySelector<HTMLInputElement>(container, "input.search-input"), query);
      await click(findBySelector(container, ".search-nav .primary-button"));
    },
    lastSearchBody: () => last(api.requestsTo("POST /api/search"))?.body as Record<string, unknown>,
    card: (fileName: string) => findByText(container, "article.result-card", fileName),
    close: async () => {
      await view.unmount();
      api.restore();
      dom.close();
    },
  };
}

test("フォルダを指定せずに検索でき、既定はハイブリッド検索で登録済みの検索対象を探す", async () => {
  const app = await openApp();
  try {
    await app.runSearch("alpha");

    const body = app.lastSearchBody();
    assert.equal(body.q, "alpha");
    assert.equal(body.full_path, "");
    assert.equal(body.search_all_enabled, false);
    assert.equal(body.search_type, "hybrid");
    assert.equal(body.offset, 0);
    assert.equal(body.limit, 50);
    assert.equal(hasElement(app.container, ".error-banner"), false, "フォルダ未入力でもエラーにしない");
    assert.equal(app.resultCount(), "4 / 4件");
  } finally {
    await app.close();
  }
});

test("検索欄で Enter を押しても検索する", async () => {
  const app = await openApp();
  try {
    await typeInto(app.searchInput(), "beta");
    await pressKey(app.searchInput(), "Enter");

    assert.equal(app.lastSearchBody().q, "beta");
  } finally {
    await app.close();
  }
});

test("検索方式を切り替えると、その方式で検索し、次回の起動でも同じ方式を使う", async () => {
  const app = await openApp();
  try {
    await click(findByText(app.container, "button.search-type-button", "通常"));
    await app.runSearch();

    assert.equal(app.lastSearchBody().search_type, "keyword");
    assert.equal(app.dom.window.localStorage.getItem("search_type"), "keyword");
    assert.equal(findByText(app.container, "button.search-type-button", "通常").getAttribute("aria-pressed"), "true");
  } finally {
    await app.close();
  }
});

test("全データベース検索は、フォルダ未指定のまま全体を探す。フォルダ入力欄は操作でき、入力しても解除されない", async () => {
  const app = await openApp();
  try {
    const searchAll = findBySelector(app.container, "button.search-all-button");
    const pathInput = findBySelector<HTMLInputElement>(app.container, "input.path-input");
    await click(searchAll);

    assert.equal(searchAll.getAttribute("aria-pressed"), "true");
    assert.equal(pathInput.disabled, false);
    assert.equal(findByText(app.container, ".path-picker-row button", "選択").hasAttribute("disabled"), false);

    await app.runSearch();
    assert.equal(app.lastSearchBody().search_all_enabled, true);
    assert.equal(app.lastSearchBody().full_path, "", "既定のフォルダへ置き換えない");

    await typeInto(pathInput, "/docs");
    assert.equal(searchAll.getAttribute("aria-pressed"), "true");
    await app.runSearch();
    assert.equal(app.lastSearchBody().full_path, "/docs");
    assert.equal(app.lastSearchBody().search_all_enabled, true);
  } finally {
    await app.close();
  }
});

test("検索種別・日付種別・並び替え・正規表現・階層の指定を検索条件として送る", async () => {
  const app = await openApp();
  try {
    await selectOption(findBySelector<HTMLSelectElement>(app.container, "#search-target-select"), "filename");
    await selectOption(findBySelector<HTMLSelectElement>(app.container, "#date-field-select"), "created");
    await typeInto(findBySelector<HTMLInputElement>(app.container, "#created-from-input"), "2026-01-01");
    await typeInto(findBySelector<HTMLInputElement>(app.container, "#created-to-input"), "2026-01-31");
    await selectOption(findBySelector<HTMLSelectElement>(app.container, "#sort-by-select"), "modified");
    await selectOption(findBySelector<HTMLSelectElement>(app.container, "select[aria-label='並び順']"), "asc");
    await click(findBySelector(app.container, "button.regex-toggle-button"));
    await typeInto(findBySelector<HTMLInputElement>(app.container, "#index-depth-input"), "2");
    await app.runSearch("report");

    const body = app.lastSearchBody();
    assert.equal(body.search_target, "filename");
    assert.equal(body.date_field, "created");
    assert.equal(body.created_from, "2026-01-01");
    assert.equal(body.created_to, "2026-01-31");
    assert.equal(body.sort_by, "modified");
    assert.equal(body.sort_order, "asc");
    assert.equal(body.regex_enabled, true);
    assert.equal(body.index_depth, 2);
  } finally {
    await app.close();
  }
});

test("並び順は、並び替えが default のあいだは選べない", async () => {
  const app = await openApp();
  try {
    const order = findBySelector<HTMLSelectElement>(app.container, "select[aria-label='並び順']");
    assert.equal(order.disabled, true);

    await selectOption(findBySelector<HTMLSelectElement>(app.container, "#sort-by-select"), "click_count");
    assert.equal(order.disabled, false);
  } finally {
    await app.close();
  }
});

test("並び替えには融合スコア・意味類似度・キーワードスコアの順を選べる", async () => {
  const app = await openApp();
  try {
    const values = [...findBySelector<HTMLSelectElement>(app.container, "#sort-by-select").options].map((option) => option.value);

    assert.deepEqual(values, ["default", "hybrid_score", "vector_score", "keyword_score", "modified", "created", "click_count"]);
  } finally {
    await app.close();
  }
});

test("日付の近道ボタンは開始日を入れ、キャンセルで日付指定を消す", async () => {
  const app = await openApp();
  try {
    const from = findBySelector<HTMLInputElement>(app.container, "#created-from-input");
    const to = findBySelector<HTMLInputElement>(app.container, "#created-to-input");
    await click(findByText(app.container, "button.date-filter-shortcut-button", "1週間以内"));

    assert.match(from.value, /^\d{4}-\d{2}-\d{2}$/);
    await app.runSearch();
    assert.equal(app.lastSearchBody().created_from, from.value);

    await click(findByText(app.container, "button", "日付指定をキャンセル"));
    assert.equal(from.value, "");
    assert.equal(to.value, "");
    await app.runSearch();
    assert.equal(app.lastSearchBody().created_from, undefined);
  } finally {
    await app.close();
  }
});

test("拡張子フィルタは、取得済みの結果を画面上で絞り込み、次回の起動でも同じ値を使う", async () => {
  const app = await openApp();
  try {
    await app.runSearch();
    await typeInto(findBySelector<HTMLInputElement>(app.container, "input.extension-filter-input"), "txt");

    assert.equal(queryAllByText(app.container, "article.result-card", "beta.txt").length, 1);
    assert.equal(queryAllByText(app.container, "article.result-card", "alpha.md").length, 0);
    assert.equal(app.resultCount(), "1 / 4件表示");

    await typeInto(findBySelector<HTMLInputElement>(app.container, "input.extension-filter-input"), "-txt");
    assert.equal(queryAllByText(app.container, "article.result-card", "beta.txt").length, 0);
    assert.equal(queryAllByText(app.container, "article.result-card", "alpha.md").length, 1);

    await app.runSearch();
    assert.equal(app.dom.window.localStorage.getItem("search_filter_extensions"), "-txt");
  } finally {
    await app.close();
  }
});

test("Web を選ぶと Web ページを検索し、gantt を含める指定も送る", async () => {
  const app = await openApp();
  try {
    await click(findByText(app.container, "button.source-toggle-button", "Web"));
    await click(findBySelector(app.container, ".gantt-include-toggle input"));
    await app.runSearch();

    assert.equal(app.lastSearchBody().source_type, "web");
    assert.equal(app.lastSearchBody().include_gantt_tasks, true);
  } finally {
    await app.close();
  }
});

test("インデックス実行中は状態を表示し、中止ボタンで中止を要求できる", async () => {
  const running = indexStatus({ is_running: true, total_files: 12 });
  const app = await openApp({
    routes: {
      "GET /api/index/status": running,
      "POST /api/index/cancel": { message: "cancel requested", status: { ...running, cancel_requested: true } },
    },
  });
  try {
    const cancel = findBySelector<HTMLButtonElement>(app.container, "button.index-cancel-button");
    assert.equal(cancel.disabled, false);
    assert.equal(findBySelector(app.container, ".index-status-pill").classList.contains("idle"), false);

    await click(cancel);

    assert.equal(app.api.requestsTo("POST /api/index/cancel").length, 1);
  } finally {
    await app.close();
  }
});

test("インデックスを実行していないときは、中止ボタンを押せない", async () => {
  const app = await openApp();
  try {
    assert.equal(findBySelector<HTMLButtonElement>(app.container, "button.index-cancel-button").disabled, true);
    assert.match(normalizeText(findBySelector(app.container, ".index-status-pill").textContent), /インデックス待機中/);
  } finally {
    await app.close();
  }
});

test("検索結果には一致理由のバッジ・核心文・アクセス数を表示する", async () => {
  const app = await openApp();
  try {
    await app.runSearch();

    assert.match(normalizeText(app.card("alpha.md").textContent), /両方一致/);
    assert.match(normalizeText(app.card("alpha.md").textContent), /核心文\s*核心の文/);
    assert.match(normalizeText(app.card("alpha.md").textContent), /アクセス: 3/);
    assert.match(normalizeText(app.card("beta.txt").textContent), /意味一致/);
    assert.match(normalizeText(app.card("gamma.md").textContent), /キーワード一致/);
    assert.equal(hasElement(app.card("beta.txt"), ".result-salient-sentence"), false);
    assert.equal(hasElement(app.card("種別: フォルダ"), ".result-match-badge"), false);
  } finally {
    await app.close();
  }
});

test("フルパスは選択できる文字として表示し、コピーは専用のボタンで行う", async () => {
  const app = await openApp();
  try {
    await app.runSearch();
    const card = app.card("alpha.md");
    const pathText = findBySelector(card, "code.result-path-text");

    assert.equal(normalizeText(pathText.textContent), "/docs/alpha.md");
    assert.equal(pathText.closest("button, a"), null, "パスの文字はボタンやリンクの中に置かない");

    await click(findBySelector(card, "button.result-copy-button"));

    assert.deepEqual(app.dom.clipboardWrites, ["/docs/alpha.md"]);
    assert.match(normalizeText(app.card("alpha.md").textContent), /コピーしました/);
  } finally {
    await app.close();
  }
});

test("ファイルとフォルダは、ファイルハブで開くリンクを持つ", async () => {
  const app = await openApp();
  try {
    await app.runSearch();
    const fileCard = app.card("beta.txt");
    const folderCard = app.card("種別: フォルダ");

    assert.equal(
      findBySelector(fileCard, "a.result-file-link").getAttribute("href"),
      "http://127.0.0.1:8001/api/fullpath?path=%2Fdocs%2Fsub%2Fbeta.txt",
    );
    assert.equal(findBySelector(fileCard, "a.result-folder-link").getAttribute("href"), "http://127.0.0.1:8001/?path=%2Fdocs%2Fsub");
    assert.equal(findBySelector(folderCard, "a.result-file-link").getAttribute("href"), "http://127.0.0.1:8001/?path=%2Fdocs%2Fsub");
  } finally {
    await app.close();
  }
});

test("フォルダの結果は種別をフォルダと表示し、無視・削除のボタンを出さない", async () => {
  const app = await openApp();
  try {
    await app.runSearch();
    const folderCard = app.card("種別: フォルダ");

    assert.doesNotMatch(normalizeText(folderCard.textContent), /アクセス:/);
    assert.equal(hasElement(folderCard, "button.result-ignore-button"), false);
    assert.equal(hasElement(folderCard, "button.result-delete-button"), false);
    assert.equal(findBySelector(folderCard, "button.result-open-location-button").getAttribute("title"), "Finderで開く");
  } finally {
    await app.close();
  }
});

test("ファイル名のリンクを開くとアクセス数を記録し、表示を更新する", async () => {
  const app = await openApp({ routes: { "POST /api/search/click": { file_id: 1, click_count: 4 } } });
  try {
    await app.runSearch("alpha");
    await click(findBySelector(app.card("alpha.md"), "a.result-file-link"));

    assert.deepEqual(app.api.requestsTo("POST /api/search/click")[0].body, { file_id: 1, query: "alpha" });
    assert.match(normalizeText(app.card("alpha.md").textContent), /アクセス: 4/);
  } finally {
    await app.close();
  }
});

test("Finder で開くボタンは、ファイルの親フォルダを開くよう要求する", async () => {
  const app = await openApp({ routes: { "POST /api/files/open-location": { status: "ok" } } });
  try {
    await app.runSearch();
    await click(findBySelector(app.card("beta.txt"), "button.result-open-location-button"));

    assert.deepEqual(app.api.requestsTo("POST /api/files/open-location")[0].body, { path: "/docs/sub" });
  } finally {
    await app.close();
  }
});

test("無視ボタンは、フルパスを除外キーワードへ追記して保存し、結果一覧から外す", async () => {
  const app = await openApp({
    routes: {
      "PUT /api/index/settings": (request) =>
        appSettings({ exclude_keywords: (request.body as { exclude_keywords: string }).exclude_keywords }),
    },
  });
  try {
    await app.runSearch();
    await click(findBySelector(app.card("alpha.md"), "button.result-ignore-button"));

    assert.deepEqual(app.api.requestsTo("PUT /api/index/settings")[0].body, {
      exclude_keywords: ".git\nnode_modules\n/docs/alpha.md",
    });
    assert.equal(queryAllByText(app.container, "article.result-card", "alpha.md").length, 0);
    assert.equal(app.resultCount(), "3 / 3件");
    assert.match(normalizeText(findBySelector(app.container, ".notice-banner").textContent), /無視リストへ追加しました/);

    // 検索ルール管理の一覧にも、保存済みの値として反映される
    await click(findByText(app.container, "button.page-tab", "検索ルール管理"));
    assert.match(app.text(), /\/docs\/alpha\.md/);
  } finally {
    await app.close();
  }
});

test("削除ボタンは、確認のうえ表示中のパスを添えて削除を要求し、結果一覧から外す", async () => {
  const app = await openApp({ routes: { "DELETE /api/files/1": { status: "deleted", file_id: 1 } } });
  try {
    await app.runSearch();
    app.dom.setConfirmAnswer(false);
    await click(findBySelector(app.card("alpha.md"), "button.result-delete-button"));
    assert.equal(app.api.requestsTo("DELETE /api/files/1").length, 0, "確認を断ったら削除しない");

    app.dom.setConfirmAnswer(true);
    await click(findBySelector(app.card("alpha.md"), "button.result-delete-button"));

    const deletion = app.api.requestsTo("DELETE /api/files/1")[0];
    assert.equal(deletion.query.get("expected_path"), "/docs/alpha.md");
    assert.match(last(app.dom.dialogs) ?? "", /元に戻せません/);
    assert.equal(queryAllByText(app.container, "article.result-card", "alpha.md").length, 0);
    assert.match(normalizeText(findBySelector(app.container, ".notice-banner").textContent), /ファイルを削除しました/);
  } finally {
    await app.close();
  }
});

test("抜粋が枠に収まらないときだけ、展開と折りたたみのボタンを表示する", async () => {
  const app = await openApp();
  try {
    await app.runSearch();
    assert.equal(hasElement(app.container, "button.result-snippet-toggle"), false, "収まっているあいだは表示しない");
    await app.close();
  } catch (error) {
    await app.close();
    throw error;
  }

  const overflowing = await openApp();
  try {
    overflowing.dom.setElementSize({ scrollHeight: 300, clientHeight: 100 });
    await overflowing.runSearch();
    const card = overflowing.card("alpha.md");
    const toggle = findBySelector(card, "button.result-snippet-toggle");
    const snippet = findBySelector(card, "p.result-snippet");

    assert.equal(snippet.classList.contains("result-snippet-clamped"), true);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");

    await click(toggle);

    assert.equal(snippet.classList.contains("result-snippet-clamped"), false);
    assert.equal(findBySelector(card, "button.result-snippet-toggle").getAttribute("aria-expanded"), "true");
    assert.match(normalizeText(findBySelector(card, "button.result-snippet-toggle").textContent), /折りたたむ/);
  } finally {
    await overflowing.close();
  }
});

test("続きがあるときは、ボタンでも一覧の末尾への到達でも次のページを読み込む", async () => {
  const pages: Record<number, ReturnType<typeof searchResponse>> = {
    0: searchResponse([alpha], { total: 3, has_more: true, next_offset: 1 }),
    1: searchResponse([beta], { total: 3, has_more: true, next_offset: 2 }),
    2: searchResponse([keywordOnly], { total: 3, has_more: false, next_offset: null }),
  };
  const app = await openApp({
    routes: { "POST /api/search": (request) => pages[(request.body as { offset: number }).offset] },
  });
  try {
    await app.runSearch();
    assert.equal(app.resultCount(), "1 / 3件");

    await click(findByText(app.container, "button", "次の50件を表示"));
    assert.equal(app.lastSearchBody().offset, 1);
    assert.equal(app.resultCount(), "2 / 3件");

    await app.dom.triggerIntersection();
    assert.equal(app.lastSearchBody().offset, 2);
    assert.equal(app.resultCount(), "3 / 3件");
    assert.equal(queryAllByText(app.container, "button", "次の50件を表示").length, 0);
  } finally {
    await app.close();
  }
});

test("検索に失敗したら、理由をエラーとして表示する", async () => {
  const { httpError } = await import("./testing/dom.ts");
  const app = await openApp({ routes: { "POST /api/search": httpError(409, "Indexing is already running.") } });
  try {
    await app.runSearch();

    assert.match(normalizeText(findBySelector(app.container, ".error-banner").textContent), /Indexing is already running\./);
  } finally {
    await app.close();
  }
});

test("起動 URL に検索語があれば、開いた直後に 1 度だけ自動で検索する", async () => {
  const app = await openApp({ search: "?q=alpha&full_path=%2Fdocs&index_depth=2&search_all=1" });
  try {
    const searches = app.api.requestsTo("POST /api/search");

    assert.equal(searches.length, 1);
    assert.equal((searches[0].body as { q: string }).q, "alpha");
    assert.equal((searches[0].body as { full_path: string }).full_path, "/docs");
    assert.equal((searches[0].body as { index_depth: number }).index_depth, 2);
  } finally {
    await app.close();
  }
});

test("入力したフォルダが検索対象に含まれていないときだけ、検索対象へ追加するボタンを表示する", async () => {
  const target = { full_path: "/docs", source_type: "local", is_enabled: true, last_indexed_at: null, indexed_file_count: 0 };
  const app = await openApp({
    routes: {
      "GET /api/index/search-targets": { items: [target] },
      "GET /api/index/search-targets/coverage": (request) => {
        const path = request.query.get("folder_path") ?? "";
        const isCovered = path.startsWith("/docs");
        return { normalized_path: path, source_type: "local", is_covered: isCovered, covering_path: isCovered ? "/docs" : null };
      },
      "POST /api/index/search-targets": {
        items: [target, { ...target, full_path: "/other" }],
      },
    },
  });
  try {
    const pathInput = findBySelector<HTMLInputElement>(app.container, "input.path-input");
    const addButtons = () => queryAllByText(app.container, "button", "検索対象");

    await typeInto(pathInput, "/docs/sub");
    await wait(260);
    await typeInto(pathInput, "/docs/sub");
    assert.equal(addButtons().filter((button) => !button.classList.contains("page-tab")).length, 0);

    await typeInto(pathInput, "/other");
    await wait(260);
    await typeInto(pathInput, "/other");
    const addButton = addButtons().find((button) => !button.classList.contains("page-tab"));
    assert.ok(addButton, "検索対象外のフォルダには追加ボタンを表示する");

    await click(addButton);

    const added = app.api.requestsTo("POST /api/index/search-targets")[0].body as { folder_path: string };
    assert.equal(added.folder_path, "/other");
    assert.match(normalizeText(findBySelector(app.container, ".notice-banner").textContent), /検索対象に追加しました/);
  } finally {
    await app.close();
  }
});
