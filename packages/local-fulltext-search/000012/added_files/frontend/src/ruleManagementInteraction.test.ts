/**
 * 検索ルール管理画面（除外キーワード・類似語・インデックス対象拡張子）を DOM へ描画し、
 * 操作のあとの表示と保存（API 呼び出し）を検証するテスト。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { appSettings } from "./testing/apiFixtures.ts";
import { withApp, type AppHarness, type Routes } from "./testing/appHarness.ts";
import {
  blur,
  click,
  doubleClick,
  dragAndDrop,
  findBySelector,
  findByText,
  hasElement,
  mouseDown,
  normalizeText,
  pressKey,
  queryAllByText,
  rightClick,
  typeInto,
  wait,
} from "./testing/dom.ts";
import { closeRenderer } from "./testing/render.ts";

test.after(() => closeRenderer());

const AUTOSAVE_WAIT_MS = 200;
const initialSettings = appSettings({
  exclude_keywords: ".git\nnode_modules\nbackup",
  synonym_groups: "PC,パソコン:個人用計算機\nAI,人工知能",
  index_selected_extensions: ".md\n.txt\n.pdf",
});

/** 送られた設定を保存済みの設定へ重ねて返す */
function settingsRoutes(base = initialSettings): Routes {
  let current = base;
  return {
    "GET /api/index/settings": () => current,
    "PUT /api/index/settings": (request) => {
      const { clean_excluded_files: _ignored, ...changes } = request.body as Record<string, unknown>;
      current = { ...current, ...changes };
      return current;
    },
  };
}

const openRules = (routes: Routes = settingsRoutes()) => ({ routes, page: "検索ルール管理" });

function card(app: AppHarness, title: string): HTMLElement {
  const heading = findByText(app.container, ".rule-list-card h3", title);
  return heading.closest(".rule-list-card") as HTMLElement;
}

function entries(app: AppHarness, title: string): string[] {
  return [...card(app, title).querySelectorAll(".rule-list-item")].map((item) =>
    normalizeText(item.querySelector("code")?.textContent ?? item.querySelector("input")?.getAttribute("value")),
  );
}

function ruleRow(app: AppHarness, title: string, text: string): HTMLElement {
  return findByText(card(app, title), ".rule-list-item", text);
}

function savedStatus(app: AppHarness, title: string): string {
  return normalizeText(card(app, title).querySelector(".settings-save-status")?.textContent);
}

async function addViaModal(app: AppHarness, title: string, values: string[]): Promise<void> {
  await click(findByText(card(app, title), ".rule-card-header-actions button", "追加"));
  const inputs = [...findBySelector(app.container, ".rule-add-modal").querySelectorAll<HTMLInputElement>("input")];
  for (const [index, value] of values.entries()) {
    await typeInto(inputs[index], value);
  }
  await click(findByText(app.container, ".rule-add-modal-actions button", "追加する"));
}

test("保存済みの除外キーワードと類似語を一覧で表示する", async () => {
  await withApp(openRules(), async (app) => {
    assert.deepEqual(entries(app, "除外キーワード"), [".git", "node_modules", "backup"]);
    assert.deepEqual(entries(app, "類似語・専門用語リスト"), ["PC,パソコン", "AI,人工知能"]);
    assert.match(normalizeText(ruleRow(app, "類似語・専門用語リスト", "PC,パソコン").textContent), /個人用計算機/, "意味・解説も表示する");
    assert.equal(savedStatus(app, "除外キーワード"), "自動保存済み");
    assert.equal(savedStatus(app, "類似語・専門用語リスト"), "自動保存済み");
  });
});

test("カードごとの検索欄で、そのカードの一覧だけを絞り込む", async () => {
  await withApp(openRules(), async (app) => {
    await typeInto(findBySelector<HTMLInputElement>(app.container, "input[aria-label='除外キーワードを検索']"), "node");
    await typeInto(findBySelector<HTMLInputElement>(app.container, "input[aria-label='類似語・専門用語を検索']"), "人工");

    assert.deepEqual(entries(app, "除外キーワード"), ["node_modules"]);
    assert.deepEqual(entries(app, "類似語・専門用語リスト"), ["AI,人工知能"]);

    await typeInto(findBySelector<HTMLInputElement>(app.container, "input[aria-label='除外キーワードを検索']"), "zzz");
    assert.match(normalizeText(card(app, "除外キーワード").textContent), /一致する除外キーワードはありません/);
  });
});

test("追加ボタンのポップアップから除外キーワードを追加すると、少し待って自動で保存する", async () => {
  await withApp(openRules(), async (app) => {
    await addViaModal(app, "除外キーワード", ["dist"]);

    assert.equal(hasElement(app.container, ".rule-add-modal"), false, "追加できたらポップアップを閉じる");
    assert.deepEqual(entries(app, "除外キーワード"), [".git", "node_modules", "backup", "dist"]);
    assert.match(app.notice(), /「dist」を追加しました/);

    await wait(AUTOSAVE_WAIT_MS);
    assert.deepEqual(app.lastBody("PUT /api/index/settings"), { exclude_keywords: ".git\nnode_modules\nbackup\ndist" });
    assert.equal(savedStatus(app, "除外キーワード"), "自動保存済み");
  });
});

test("ポップアップでは Enter でも追加でき、日本語入力の変換確定の Enter では追加しない", async () => {
  await withApp(openRules(), async (app) => {
    await click(findByText(card(app, "除外キーワード"), ".rule-card-header-actions button", "追加"));
    const input = findBySelector<HTMLInputElement>(app.container, ".rule-add-modal input");
    await typeInto(input, "旧資料");

    await pressKey(input, "Enter", { isComposing: true });
    assert.equal(hasElement(app.container, ".rule-add-modal"), true, "変換中の Enter では閉じない");
    assert.equal(entries(app, "除外キーワード").includes("旧資料"), false);

    await pressKey(input, "Enter");
    assert.equal(hasElement(app.container, ".rule-add-modal"), false);
    assert.equal(entries(app, "除外キーワード").includes("旧資料"), true);
  });
});

test("登録済みの除外キーワードは追加せず、ポップアップを開いたまま知らせる", async () => {
  await withApp(openRules(), async (app) => {
    await addViaModal(app, "除外キーワード", ["BACKUP"]);

    assert.match(app.notice(), /「BACKUP」は除外リストに登録済みです/);
    assert.equal(hasElement(app.container, ".rule-add-modal"), true);
    assert.equal(entries(app, "除外キーワード").length, 3);
  });
});

test("ポップアップは、キャンセルでも外側を押しても閉じる", async () => {
  await withApp(openRules(), async (app) => {
    await click(findByText(card(app, "除外キーワード"), ".rule-card-header-actions button", "追加"));
    await click(findByText(app.container, ".rule-add-modal-actions button", "キャンセル"));
    assert.equal(hasElement(app.container, ".rule-add-modal"), false);

    await click(findByText(card(app, "類似語・専門用語リスト"), ".rule-card-header-actions button", "追加"));
    assert.equal(findBySelector(app.container, ".rule-add-modal").getAttribute("aria-label"), "類似語・専門用語を追加");
    await mouseDown(findBySelector(app.container, ".rule-add-modal-backdrop"));
    assert.equal(hasElement(app.container, ".rule-add-modal"), false);
  });
});

test("類似語は、語の並びと意味・解説を入力して追加でき、自動で保存する", async () => {
  await withApp(openRules(), async (app) => {
    await addViaModal(app, "類似語・専門用語リスト", ["スマートフォン, スマホ", "多機能携帯電話"]);

    assert.deepEqual(entries(app, "類似語・専門用語リスト").slice(-1), ["スマートフォン,スマホ"]);
    assert.match(normalizeText(ruleRow(app, "類似語・専門用語リスト", "スマートフォン,スマホ").textContent), /多機能携帯電話/);

    await wait(AUTOSAVE_WAIT_MS);
    assert.deepEqual(app.lastBody("PUT /api/index/settings"), {
      synonym_groups: "PC,パソコン:個人用計算機\nAI,人工知能\nスマートフォン,スマホ:多機能携帯電話",
    });
  });
});

test("ほかのグループと重なる語や、除外キーワードと同じ語を含む類似語は追加しない", async () => {
  await withApp(openRules(), async (app) => {
    await addViaModal(app, "類似語・専門用語リスト", ["パソコン, 計算機"]);
    assert.match(app.notice(), /「パソコン」は同義語内で重複して登録されています/);

    await typeInto(findBySelector<HTMLInputElement>(app.container, ".rule-add-modal input"), "backup, 退避");
    await click(findByText(app.container, ".rule-add-modal-actions button", "追加する"));
    assert.match(app.notice(), /「backup」は除外リストに登録済みです/);
    assert.equal(entries(app, "類似語・専門用語リスト").length, 2);
  });
});

test("行をダブルクリックするとその場で編集でき、Enter またはフォーカスを外すと確定して保存する", async () => {
  await withApp(openRules(), async (app) => {
    await doubleClick(ruleRow(app, "除外キーワード", "backup"));
    const input = findBySelector<HTMLInputElement>(card(app, "除外キーワード"), "input.rule-inline-input");
    assert.equal(input.value, "backup");

    await typeInto(input, "archive");
    await pressKey(input, "Enter");
    assert.deepEqual(entries(app, "除外キーワード"), [".git", "node_modules", "archive"]);

    await doubleClick(ruleRow(app, "類似語・専門用語リスト", "AI,人工知能"));
    const synonymInput = findBySelector<HTMLInputElement>(card(app, "類似語・専門用語リスト"), "input.rule-inline-input");
    await typeInto(synonymInput, "AI,人工知能,機械学習");
    await blur(synonymInput);
    assert.deepEqual(entries(app, "類似語・専門用語リスト").slice(-1), ["AI,人工知能,機械学習"]);

    await wait(AUTOSAVE_WAIT_MS);
    const saved = app.api.requestsTo("PUT /api/index/settings").map((request) => request.body as Record<string, string>);
    assert.ok(saved.some((body) => body.exclude_keywords === ".git\nnode_modules\narchive"));
    assert.ok(saved.some((body) => body.synonym_groups === "PC,パソコン:個人用計算機\nAI,人工知能,機械学習"));
  });
});

test("編集で登録済みの語と重なったら、変更せずに知らせる", async () => {
  await withApp(openRules(), async (app) => {
    await doubleClick(ruleRow(app, "除外キーワード", "backup"));
    const input = findBySelector<HTMLInputElement>(card(app, "除外キーワード"), "input.rule-inline-input");
    await typeInto(input, ".GIT");
    await pressKey(input, "Enter");

    assert.match(app.notice(), /「\.GIT」は除外リストに登録済みです/);
    assert.deepEqual(entries(app, "除外キーワード"), [".git", "node_modules", "backup"]);
  });
});

test("行の削除ボタンと右クリックのメニューは、確認のうえ削除して保存する", async () => {
  await withApp(openRules(), async (app) => {
    app.dom.setConfirmAnswer(false);
    await click(findByText(ruleRow(app, "除外キーワード", "backup"), "button", "削除"));
    assert.equal(entries(app, "除外キーワード").length, 3, "確認を断ったら削除しない");

    app.dom.setConfirmAnswer(true);
    await click(findByText(ruleRow(app, "除外キーワード", "backup"), "button", "削除"));
    assert.deepEqual(entries(app, "除外キーワード"), [".git", "node_modules"]);

    await rightClick(ruleRow(app, "類似語・専門用語リスト", "AI,人工知能"));
    await click(findByText(app.container, ".rule-context-menu button", "削除"));
    assert.deepEqual(entries(app, "類似語・専門用語リスト"), ["PC,パソコン"]);
    assert.equal(hasElement(app.container, ".rule-context-menu"), false);

    await wait(AUTOSAVE_WAIT_MS);
    const saved = app.api.requestsTo("PUT /api/index/settings").map((request) => request.body as Record<string, string>);
    assert.ok(saved.some((body) => body.exclude_keywords === ".git\nnode_modules"));
    assert.ok(saved.some((body) => body.synonym_groups === "PC,パソコン:個人用計算機"));
  });
});

test("右クリックのメニューは、ほかの場所を押すと閉じる", async () => {
  await withApp(openRules(), async (app) => {
    await rightClick(ruleRow(app, "除外キーワード", "backup"));
    assert.equal(hasElement(app.container, ".rule-context-menu"), true);

    await click(findByText(app.container, ".rule-list-card h3", "インデックス対象拡張子"));
    assert.equal(hasElement(app.container, ".rule-context-menu"), false);
  });
});

test("行を選ぶと見分けがつき、Delete キーでも確認のうえ削除できる。入力中の Delete では削除しない", async () => {
  await withApp(openRules(), async (app) => {
    await click(ruleRow(app, "除外キーワード", "node_modules"));
    assert.equal(ruleRow(app, "除外キーワード", "node_modules").classList.contains("selected"), true);
    assert.equal(card(app, "除外キーワード").classList.contains("active"), true);

    const searchInput = findBySelector<HTMLInputElement>(app.container, "input[aria-label='除外キーワードを検索']");
    await pressKey(searchInput, "Delete");
    assert.equal(entries(app, "除外キーワード").length, 3, "入力欄で押した Delete では削除しない");

    await pressKey(app.dom.window.document.body, "Delete");
    assert.deepEqual(entries(app, "除外キーワード"), [".git", "backup"]);
    assert.match(app.dom.dialogs[app.dom.dialogs.length - 1], /本当に削除しますか/);
  });
});

test("行をドラッグして並べ替えると、その順序で保存する", async () => {
  await withApp(openRules(), async (app) => {
    await dragAndDrop(ruleRow(app, "除外キーワード", "backup"), ruleRow(app, "除外キーワード", ".git"));

    assert.deepEqual(entries(app, "除外キーワード"), ["backup", ".git", "node_modules"]);

    await wait(AUTOSAVE_WAIT_MS);
    assert.deepEqual(app.lastBody("PUT /api/index/settings"), { exclude_keywords: "backup\n.git\nnode_modules" });
  });
});

test("変更は元に戻す・やり直すボタンでも、Ctrl+Z / Ctrl+Shift+Z でも取り消し・やり直しができる", async () => {
  await withApp(openRules(), async (app) => {
    await addViaModal(app, "除外キーワード", ["dist"]);
    await addViaModal(app, "除外キーワード", ["build"]);
    assert.equal(entries(app, "除外キーワード").length, 5);

    await click(findByText(app.container, ".section-header-actions button", "元に戻す"));
    assert.deepEqual(entries(app, "除外キーワード").slice(-1), ["dist"]);
    assert.match(app.notice(), /検索ルールの変更を取り消しました/);

    await pressKey(app.dom.window.document.body, "z", { ctrlKey: true });
    assert.deepEqual(entries(app, "除外キーワード"), [".git", "node_modules", "backup"]);

    await pressKey(app.dom.window.document.body, "z", { ctrlKey: true, shiftKey: true });
    await click(findByText(app.container, ".section-header-actions button", "やり直す"));
    assert.deepEqual(entries(app, "除外キーワード").slice(-2), ["dist", "build"]);
  });
});

test("入力欄を操作していないとき、A キーで選択中のカードの追加ポップアップを開く", async () => {
  await withApp(openRules(), async (app) => {
    await pressKey(findBySelector(app.container, "input[aria-label='除外キーワードを検索']"), "a");
    assert.equal(hasElement(app.container, ".rule-add-modal"), false, "入力中は開かない");

    await pressKey(app.dom.window.document.body, "a", { ctrlKey: true });
    assert.equal(hasElement(app.container, ".rule-add-modal"), false, "Ctrl+A では開かない");

    await click(ruleRow(app, "類似語・専門用語リスト", "AI,人工知能"));
    await pressKey(app.dom.window.document.body, "a");
    assert.equal(findBySelector(app.container, ".rule-add-modal").getAttribute("aria-label"), "類似語・専門用語を追加");
  });
});

test("類似語の中に除外キーワードと同じ語があれば、その行に知らせを表示する", async () => {
  await withApp(
    openRules(settingsRoutes(appSettings({ exclude_keywords: "backup", synonym_groups: "backup,退避" }))),
    async (app) => {
      assert.match(normalizeText(findBySelector(app.container, ".rule-conflict").textContent), /除外リストに登録済み: backup/);
    },
  );
});

test("検索へ戻るボタンで検索画面へ戻り、設定ボタンで設定メニューを開ける", async () => {
  await withApp(openRules(), async (app) => {
    await click(findBySelector(app.container, ".rule-management-panel .section-header-actions button[aria-label='設定']"));
    assert.equal(app.isDrawerOpen(), true);

    await click(findByText(app.container, ".section-header-actions button", "検索へ戻る"));
    assert.equal(hasElement(app.container, ".rule-management-panel"), false);
    assert.equal(findByText(app.container, "button.page-tab.active", "検索") !== null, true);
  });
});

// ---- インデックス対象拡張子

function extensionOption(app: AppHarness, extension: string): HTMLInputElement {
  const label = [...card(app, "インデックス対象拡張子").querySelectorAll<HTMLElement>("label.extension-option")].find(
    (item) => normalizeText(item.querySelector("span")?.textContent) === extension,
  );
  assert.ok(label, `${extension} の選択肢が表示される`);
  return findBySelector<HTMLInputElement>(label, "input[type='checkbox']");
}

function extensionSaveButton(app: AppHarness): HTMLButtonElement {
  return findBySelector<HTMLButtonElement>(card(app, "インデックス対象拡張子"), "button.settings-save-button");
}

test("インデックス対象拡張子は、保存済みの選択をチェックで表示し、変更するまで保存ボタンを押せない", async () => {
  await withApp(openRules(), async (app) => {
    assert.equal(extensionOption(app, ".md").checked, true);
    assert.equal(extensionOption(app, ".docx").checked, false);
    assert.match(normalizeText(card(app, "インデックス対象拡張子").textContent), /3件選択中/);
    assert.equal(extensionSaveButton(app).disabled, true);
  });
});

test("拡張子を追加で選んで保存すると、選択を共有設定へ保存する（削除の確認は出さない）", async () => {
  await withApp(openRules(), async (app) => {
    await click(extensionOption(app, ".docx"));
    assert.equal(extensionSaveButton(app).disabled, false);

    await click(extensionSaveButton(app));

    const body = app.lastBody("PUT /api/index/settings");
    assert.deepEqual(String(body.index_selected_extensions).split("\n").sort(), [".docx", ".md", ".pdf", ".txt"]);
    assert.equal(body.clean_excluded_files, false);
    assert.equal(app.dom.dialogs.length, 0);
    assert.match(app.notice(), /インデックス対象拡張子を保存しました/);
    assert.equal(extensionSaveButton(app).disabled, true);
  });
});

test("拡張子を外して保存するときは、既存インデックスを削除するかを確認し、許可されたときだけ削除を指示する", async () => {
  for (const [answer, expected] of [[true, true], [false, false]] as const) {
    await withApp(openRules(), async (app) => {
      app.dom.setConfirmAnswer(answer);
      await click(extensionOption(app, ".pdf"));
      await click(extensionSaveButton(app));

      assert.match(app.dom.dialogs[0], /\.pdf/);
      const body = app.lastBody("PUT /api/index/settings");
      assert.equal(body.clean_excluded_files, expected);
      assert.deepEqual(String(body.index_selected_extensions).split("\n").sort(), [".md", ".txt"]);
    });
  }
});

test("削除時の確認を無効にしているときは、拡張子を外しても確認せず、既存インデックスも削除しない", async () => {
  await withApp(openRules(settingsRoutes({ ...initialSettings, confirm_index_deletion: false })), async (app) => {
    await click(extensionOption(app, ".pdf"));
    await click(extensionSaveButton(app));

    assert.equal(app.dom.dialogs.length, 0);
    assert.equal(app.lastBody("PUT /api/index/settings").clean_excluded_files, false);
  });
});

test("全選択・全解除で、すべての拡張子をまとめて切り替える", async () => {
  await withApp(openRules(), async (app) => {
    await click(findByText(card(app, "インデックス対象拡張子"), "button", "全解除"));
    assert.match(normalizeText(card(app, "インデックス対象拡張子").textContent), /0件選択中/);
    assert.equal(extensionOption(app, ".md").checked, false);

    await click(findByText(card(app, "インデックス対象拡張子"), "button", "全選択"));
    assert.equal(extensionOption(app, ".md").checked, true);
    assert.equal(extensionOption(app, ".wav").checked, true);
  });
});

test("追加の拡張子を登録すると選択済みになり、保存で本文用・ファイル名用を分けて保存する", async () => {
  await withApp(openRules(), async (app) => {
    const [contentInput, filenameInput] = [...card(app, "インデックス対象拡張子").querySelectorAll<HTMLInputElement>("input.extension-add-input")];
    await typeInto(contentInput, "py");
    await click(findByText(contentInput.closest(".extension-add-row") as HTMLElement, "button", "追加"));
    await typeInto(filenameInput, ".cae");
    await click(findByText(filenameInput.closest(".extension-add-row") as HTMLElement, "button", "追加"));

    assert.equal(extensionOption(app, ".py").checked, true);
    assert.equal(extensionOption(app, ".cae").checked, true);

    await click(extensionSaveButton(app));
    const body = app.lastBody("PUT /api/index/settings");
    assert.equal(body.custom_content_extensions, ".py");
    assert.equal(body.custom_filename_extensions, ".cae");
    assert.equal(String(body.index_selected_extensions).split("\n").includes(".py"), true);
  });
});

test("登録済みの拡張子や空の入力は追加せず、エラーで知らせる", async () => {
  await withApp(openRules(), async (app) => {
    const contentInput = findBySelector<HTMLInputElement>(card(app, "インデックス対象拡張子"), "input.extension-add-input");
    const addButton = findByText(contentInput.closest(".extension-add-row") as HTMLElement, "button", "追加");

    await click(addButton);
    assert.match(app.error(), /追加する拡張子を入力してください/);

    await typeInto(contentInput, ".md");
    await click(addButton);
    assert.match(app.error(), /拡張子 \.md は既に登録されています/);
  });
});

test("拡張子の検索欄で、選択肢を絞り込める", async () => {
  await withApp(openRules(), async (app) => {
    await typeInto(findBySelector<HTMLInputElement>(app.container, "input[aria-label='拡張子を検索']"), "xls");

    const shown = queryAllByText(card(app, "インデックス対象拡張子"), "label.extension-option", "").map((label) =>
      normalizeText(label.textContent),
    );
    assert.deepEqual(shown, [".xlsx", ".xlsm"]);
  });
});

test("拡張子を 1 つも選んでいないと検索できず、設定メニューを開いて知らせる", async () => {
  await withApp(openRules(), async (app) => {
    await click(findByText(card(app, "インデックス対象拡張子"), "button", "全解除"));
    await app.openPage("検索");
    await app.runSearch("alpha");

    assert.equal(app.api.requestsTo("POST /api/search").length, 0);
    assert.match(app.error(), /インデックス対象の拡張子を 1 つ以上選択してください/);
  });
});

test("未保存の類似語があるまま検索すると、今回の検索には反映していないと知らせる", async () => {
  const { searchResponse, searchResult } = await import("./testing/apiFixtures.ts");
  const routes = settingsRoutes();
  await withApp({ routes: { ...routes, "POST /api/search": searchResponse([searchResult()]) }, page: "検索ルール管理" }, async (app) => {
    await addViaModal(app, "類似語・専門用語リスト", ["車, 自動車"]);
    await app.openPage("検索");
    await app.runSearch("alpha");

    assert.match(app.notice(), /未保存の同義語リストは今回の検索に反映していません/);
  });
});
