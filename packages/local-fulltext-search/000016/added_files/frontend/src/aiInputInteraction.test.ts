/**
 * AIインプット画面を DOM へ描画し、候補の抽出・選択・生成・プレビューでの調整・保存までの操作を検証するテスト。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { appSettings, searchResponse, searchResult } from "./testing/apiFixtures.ts";
import { withApp, type AppHarness, type OpenAppOptions, type Routes } from "./testing/appHarness.ts";
import {
  click,
  dragAndDrop,
  findBySelector,
  findByText,
  hasElement,
  httpError,
  last,
  mouseDown,
  mouseEnter,
  mouseUp,
  normalizeText,
  pressKey,
  queryAllByText,
  typeInto,
  wait,
} from "./testing/dom.ts";
import { closeRenderer } from "./testing/render.ts";
import type { SearchResult } from "./types.ts";

test.after(() => closeRenderer());

const REGENERATE_WAIT_MS = 260;

const alpha = searchResult({ file_id: 1, file_name: "alpha.md", full_path: "/docs/alpha.md", match_source: "both", has_obsidian_top_tag: true, salient_sentence: "核心の文" });
const beta = searchResult({ file_id: 2, file_name: "beta.md", full_path: "/docs/beta.md", match_source: "vector" });
const gamma = searchResult({ file_id: 3, file_name: "gamma.md", full_path: "/docs/gamma.md", match_source: "keyword" });

type GenerateBody = {
  file_paths: string[];
  file_depths: Record<string, number>;
  excluded_file_paths?: string[];
  prompt: string;
  title: string;
  include_raw_markdown: boolean;
  include_images: boolean;
  include_linked_emails: boolean;
  optimize_tokens: boolean;
};

/** 送られたノートの並びをそのまま反映した HTML を返す（順序や除外が反映されたかを確かめられる） */
const generateRoute: Routes = {
  "POST /api/export/ai-html": (request) => {
    const body = request.body as GenerateBody;
    const expandedNodes = body.file_paths.flatMap((path) => {
      const root = { full_path: path, file_name: path.split("/").pop() ?? path, depth_level: 0, root_path: path };
      if (path !== alpha.full_path || (body.file_depths[path] ?? 0) < 1) {
        return [root];
      }
      const children = [
        { full_path: "/docs/child.md", file_name: "child.md", depth_level: 1, root_path: path, parent_path: path, parent_name: "alpha.md" },
        { full_path: "/docs/grandchild.md", file_name: "grandchild.md", depth_level: 2, root_path: path, parent_path: "/docs/child.md", parent_name: "child.md" },
      ].filter((child) => !(body.excluded_file_paths ?? []).includes(child.full_path));
      return [root, ...children];
    });
    return {
      html_content: `<html><body>${body.file_paths.join("|")}</body></html>`,
      file_name: `${body.title}.html`,
      total_documents: expandedNodes.length,
      total_linked_emails: 0,
      total_images_embedded: 0,
      size_bytes: 100,
      expanded_nodes: expandedNodes,
    };
  },
};

function aiRoutes(overrides: Routes = {}, results: SearchResult[] = [alpha, beta, gamma]): Routes {
  return {
    "POST /api/search": searchResponse(results),
    "GET /api/export/config": { export_folder: "/tmp/export", default_select_count: 10 },
    ...generateRoute,
    ...overrides,
  };
}

/** 検索してから AIインプットを開く（検索結果が候補として引き継がれる） */
async function withAiInput(
  options: { routes?: Routes; results?: SearchResult[]; app?: OpenAppOptions; filter?: string },
  body: (app: AppHarness, page: HTMLElement) => Promise<void>,
): Promise<void> {
  await withApp({ ...options.app, routes: aiRoutes(options.routes, options.results) }, async (app) => {
    if (options.filter !== undefined) {
      await typeInto(findBySelector<HTMLInputElement>(app.container, ".search-nav input.extension-filter-input"), options.filter);
    }
    await app.runSearch("alpha");
    await app.openPage("AIインプット");
    await body(app, findBySelector(app.container, ".ai-input-page-container"));
  });
}

function candidateRows(page: HTMLElement): HTMLTableRowElement[] {
  return [...page.querySelectorAll<HTMLTableRowElement>("table.ai-export-table tbody tr")];
}

function candidateRow(page: HTMLElement, fileName: string): HTMLTableRowElement {
  const row = candidateRows(page).find((item) => normalizeText(item.textContent).includes(fileName));
  assert.ok(row, `${fileName} の行が表示される`);
  return row;
}

function selectedNames(page: HTMLElement): string[] {
  return candidateRows(page)
    .filter((row) => findBySelector<HTMLInputElement>(row, "input[type='checkbox']").checked)
    .map((row) => normalizeText(findBySelector(row, ".table-title-link span").textContent));
}

function selectionBadge(page: HTMLElement): string {
  return normalizeText(findByText(page, "span.badge", "件 選択中").textContent);
}

function generateBodies(app: AppHarness): GenerateBody[] {
  return app.api.requestsTo("POST /api/export/ai-html").map((request) => request.body as GenerateBody);
}

async function generate(app: AppHarness, page: HTMLElement): Promise<HTMLElement> {
  await click(findBySelector(page, "button.ai-generate-top-btn"));
  return findBySelector(app.dom.window.document.body, ".ai-preview-modal");
}

function modalFiles(modal: HTMLElement): string[] {
  return [...modal.querySelectorAll<HTMLElement>(".ai-file-selection-item")].map((item) =>
    normalizeText(item.querySelector(":scope > div > div > span")?.textContent),
  );
}

function modalFile(modal: HTMLElement, fileName: string): HTMLElement {
  const item = [...modal.querySelectorAll<HTMLElement>(".ai-file-selection-item")].find(
    (element) => normalizeText(element.querySelector(":scope > div > div > span")?.textContent) === fileName,
  );
  assert.ok(item, `${fileName} がファイル一覧に表示される`);
  return item;
}

function previewHtml(modal: HTMLElement): string {
  return findBySelector(modal, "iframe").getAttribute("srcdoc") ?? "";
}

// ---- 候補の一覧

test("直前の検索結果のうち、文書のノートだけを候補として表示する（図面・画像・除外キーワードの対象は出さない）", async () => {
  const results = [
    alpha,
    searchResult({ file_id: 10, file_name: "diagram.excalidraw.md", full_path: "/docs/diagram.excalidraw.md" }),
    searchResult({ file_id: 11, file_name: "old_note.md", full_path: "/docs/backup/old_note.md" }),
    beta,
  ];
  await withAiInput(
    { results, routes: { "GET /api/index/settings": appSettings({ exclude_keywords: "backup" }) } },
    async (_app, page) => {
      assert.deepEqual(
        candidateRows(page).map((row) => normalizeText(findBySelector(row, ".table-title-link span").textContent)),
        ["alpha.md", "beta.md"],
      );
    },
  );
});

test("候補には順位・一致理由・パス・根拠文を表示する", async () => {
  await withAiInput({}, async (_app, page) => {
    const text = normalizeText(candidateRow(page, "alpha.md").textContent);

    assert.match(text, /#\s*1/);
    assert.match(text, /両方一致/);
    assert.match(text, /\/docs\/alpha\.md/);
    assert.match(text, /核心の文/);
    assert.match(normalizeText(candidateRow(page, "beta.md").textContent), /意味一致/);
  });
});

test("拡張子フィルタの既定は md で、検索欄にフィルタがあればそれを引き継ぐ", async () => {
  const results = [alpha, searchResult({ file_id: 20, file_name: "memo.txt", full_path: "/docs/memo.txt", file_ext: ".txt" })];
  await withAiInput({ results, filter: "" }, async (_app, page) => {
    assert.equal(findBySelector<HTMLInputElement>(page, "input.extension-filter-input").value, "md");
    assert.deepEqual(selectedNames(page), ["alpha.md"]);
  });
  await withAiInput({ results, filter: "txt" }, async (_app, page) => {
    assert.equal(findBySelector<HTMLInputElement>(page, "input.extension-filter-input").value, "txt");
    assert.deepEqual(selectedNames(page), ["memo.txt"]);
  });
});

test("候補が無いときは、候補の表を出さず、生成もできない", async () => {
  await withApp({ routes: aiRoutes(), page: "AIインプット" }, async (app) => {
    const page = findBySelector(app.container, ".ai-input-page-container");

    assert.equal(hasElement(page, "table.ai-export-table tbody tr"), false);
    assert.equal(app.api.requestsTo("POST /api/export/ai-html").length, 0);
  });
});

// ---- 候補の抽出

test("質問を入力して抽出すると、全データベースをハイブリッド検索し、上位を自動で選択する", async () => {
  await withApp({ routes: aiRoutes(), page: "AIインプット" }, async (app) => {
    const page = findBySelector(app.container, ".ai-input-page-container");
    await typeInto(findBySelector<HTMLInputElement>(page, "input.input-field"), "次期システムの仕様");
    await click(findByText(page, "button", "候補ノートを抽出"));

    const body = app.lastBody("POST /api/search");
    assert.equal(body.q, "次期システムの仕様");
    assert.equal(body.search_all_enabled, true);
    assert.equal(body.search_type, "hybrid");
    assert.equal(body.types, "md");
    assert.equal(body.limit, 40);
    assert.equal(body.exclude_keywords, ".git\nnode_modules");
    assert.deepEqual(selectedNames(page), ["alpha.md", "beta.md", "gamma.md"]);
  });
});

test("質問欄で Enter を押しても抽出する。日本語入力の変換確定の Enter では抽出しない", async () => {
  await withApp({ routes: aiRoutes(), page: "AIインプット" }, async (app) => {
    const input = findBySelector<HTMLInputElement>(app.container, ".ai-input-page-container input.input-field");
    await typeInto(input, "仕様");

    await pressKey(input, "Enter", { isComposing: true });
    assert.equal(app.api.requestsTo("POST /api/search").length, 0);

    await pressKey(input, "Enter");
    assert.equal(app.api.requestsTo("POST /api/search").length, 1);
  });
});

test("質問が空のまま抽出しようとしたら、検索せずに入力を促す", async () => {
  await withApp({ routes: aiRoutes(), page: "AIインプット" }, async (app) => {
    await click(findByText(app.container, ".ai-input-page-container button", "候補ノートを抽出"));

    assert.equal(app.api.requestsTo("POST /api/search").length, 0);
    assert.match(last(app.dom.dialogs) ?? "", /質問や探したいキーワードを入力してください/);
  });
});

// ---- 選択

test("全解除・全選択・行のクリックで選択を切り替え、選択件数とトークンの概算を表示する", async () => {
  await withAiInput({}, async (_app, page) => {
    assert.match(selectionBadge(page), /3\s*\/\s*3\s*件 選択中/);
    assert.match(normalizeText(page.textContent), /約\s*[\d,]+\s*トークン/);

    await click(findByText(page, "button", "全解除"));
    assert.deepEqual(selectedNames(page), []);
    assert.match(selectionBadge(page), /0\s*\/\s*3\s*件 選択中/);

    await click(candidateRow(page, "beta.md").cells[4]);
    assert.deepEqual(selectedNames(page), ["beta.md"]);

    await click(findByText(page, "button", "全選択"));
    assert.deepEqual(selectedNames(page), ["alpha.md", "beta.md", "gamma.md"]);
  });
});

test("チェックボックスからドラッグすると連続で選択でき、Shift を押しながらだと連続で解除できる", async () => {
  await withAiInput({}, async (_app, page) => {
    await click(findByText(page, "button", "全解除"));
    const checkbox = (name: string): HTMLInputElement => findBySelector<HTMLInputElement>(candidateRow(page, name), "input[type='checkbox']");

    await mouseDown(checkbox("alpha.md"));
    await mouseEnter(candidateRow(page, "beta.md"));
    await mouseEnter(candidateRow(page, "gamma.md"));
    await mouseUp();
    assert.deepEqual(selectedNames(page), ["alpha.md", "beta.md", "gamma.md"]);

    await mouseEnter(candidateRow(page, "alpha.md"));
    assert.deepEqual(selectedNames(page), ["alpha.md", "beta.md", "gamma.md"], "ボタンを離したあとは、通過しても変えない");

    await mouseDown(checkbox("gamma.md"), { shiftKey: true });
    await mouseEnter(candidateRow(page, "beta.md"), { shiftKey: true });
    await mouseUp();
    assert.deepEqual(selectedNames(page), ["alpha.md"]);
  });
});

test("チェックボックスを押すたびに選択が切り替わり、選択済みから始めたドラッグは連続で解除する", async () => {
  await withAiInput({}, async (_app, page) => {
    const checkbox = (name: string): HTMLInputElement => findBySelector<HTMLInputElement>(candidateRow(page, name), "input[type='checkbox']");
    /** ブラウザと同じく mousedown → mouseup → click の順で押す */
    const press = async (element: Element): Promise<void> => {
      await mouseDown(element);
      await mouseUp();
      await click(element);
    };
    assert.deepEqual(selectedNames(page), ["alpha.md", "beta.md", "gamma.md"]);

    await press(checkbox("beta.md"));
    assert.deepEqual(selectedNames(page), ["alpha.md", "gamma.md"], "選択済みを押すと外れる");

    await press(checkbox("beta.md"));
    assert.deepEqual(selectedNames(page), ["alpha.md", "beta.md", "gamma.md"], "もう一度押すと付く");

    await press(candidateRow(page, "gamma.md").cells[0]);
    assert.deepEqual(selectedNames(page), ["alpha.md", "beta.md"], "チェックボックスの周りのセルを押しても切り替わる");

    await mouseDown(checkbox("alpha.md"));
    await mouseEnter(candidateRow(page, "beta.md"));
    await mouseUp();
    assert.deepEqual(selectedNames(page), [], "選択済みから始めたドラッグは、通過した行も外す");
  });
});

test("デフォルト選択数は、保存済みの値で上位から選び、変えるとその場で選び直してサーバーへ保存する", async () => {
  await withAiInput(
    {
      routes: {
        "GET /api/export/config": { export_folder: "/tmp/export", default_select_count: 2 },
        "POST /api/export/config": (request) => ({ success: true, export_folder: "/tmp/export", ...(request.body as object) }),
      },
    },
    async (app, page) => {
      const input = findBySelector<HTMLInputElement>(page, "input.default-select-count-input");
      assert.equal(input.value, "2");
      assert.deepEqual(selectedNames(page), ["alpha.md", "beta.md"]);

      await typeInto(input, "1");

      assert.deepEqual(selectedNames(page), ["alpha.md"]);
      assert.deepEqual(app.lastBody("POST /api/export/config"), { default_select_count: 1 });
    },
  );
});

test("ノートのタイトルを押すと、ファイルハブで開く（選択は変えない）", async () => {
  await withAiInput({}, async (app, page) => {
    await click(findBySelector(candidateRow(page, "beta.md"), "button.table-title-link"));

    assert.deepEqual(app.dom.openedUrls, ["http://127.0.0.1:8001/api/fullpath?path=%2Fdocs%2Fbeta.md"]);
    assert.deepEqual(selectedNames(page), ["alpha.md", "beta.md", "gamma.md"]);
  });
});

// ---- 生成

test("候補の表の上にある生成ボタンで、選んだノートを表示順のまま生成する。リンクを辿る深さは top タグつきが 2、ほかは 1", async () => {
  await withAiInput({}, async (app, page) => {
    await click(candidateRow(page, "beta.md").cells[4]);
    assert.match(normalizeText(findBySelector(page, "button.ai-generate-top-btn").textContent), /AI用HTMLファイルを生成する\s*\(\s*2\s*件\)/);

    await generate(app, page);

    const body = generateBodies(app)[0];
    assert.deepEqual(body.file_paths, ["/docs/alpha.md", "/docs/gamma.md"]);
    assert.deepEqual(body.file_depths, { "/docs/alpha.md": 2, "/docs/gamma.md": 1 });
    assert.equal(body.prompt, "", "AI への指示文は付けない");
    assert.equal(body.include_images, true);
    assert.equal(body.include_linked_emails, true);
    assert.equal(body.optimize_tokens, true);
    assert.equal(body.title, "AI_Context_Document");
  });
});

test("画面で抽出した候補から生成するときは、質問から付けたタイトルを使う", async () => {
  await withApp({ routes: aiRoutes(), page: "AIインプット" }, async (app) => {
    const page = findBySelector(app.container, ".ai-input-page-container");
    await typeInto(findBySelector<HTMLInputElement>(page, "input.input-field"), "PJ-X の仕様/課題");
    await click(findByText(page, "button", "候補ノートを抽出"));
    await generate(app, page);

    assert.equal(generateBodies(app)[0].title, "AI_Context_PJ-X_の仕様_課題");
  });
});

test("1 件も選んでいないと生成せず、選択を促す", async () => {
  await withAiInput({}, async (app, page) => {
    await click(findByText(page, "button", "全解除"));
    await click(findBySelector(page, "button.ai-generate-top-btn"));

    assert.equal(app.api.requestsTo("POST /api/export/ai-html").length, 0);
    assert.equal(hasElement(app.dom.window.document.body, ".ai-preview-modal"), false);
  });
});

test("生成に失敗したら、理由を知らせてプレビューは開かない", async () => {
  await withAiInput({ routes: { "POST /api/export/ai-html": httpError(500, "生成できません") } }, async (app, page) => {
    await click(findBySelector(page, "button.ai-generate-top-btn"));

    assert.match(last(app.dom.dialogs) ?? "", /HTML生成に失敗しました: 生成できません/);
    assert.equal(hasElement(app.dom.window.document.body, ".ai-preview-modal"), false);
  });
});

test("AI への指示を入力するステップや指示文のひな形は、画面に無い", async () => {
  await withAiInput({}, async (app, page) => {
    await generate(app, page);
    const text = normalizeText(app.dom.window.document.body.textContent);

    assert.doesNotMatch(text, /ステップ\s*3/);
    assert.doesNotMatch(text, /AIへの指示/);
    assert.equal(hasElement(page, "textarea"), false);
  });
});

// ---- プレビュー

test("生成すると画面いっぱいのプレビューを開き、左に HTML、右に対象ファイルの一覧を表示する", async () => {
  await withAiInput({}, async (app, page) => {
    const modal = await generate(app, page);

    assert.equal(previewHtml(modal), "<html><body>/docs/alpha.md|/docs/beta.md|/docs/gamma.md</body></html>");
    assert.deepEqual(modalFiles(modal), ["alpha.md", "beta.md", "gamma.md"]);
    assert.match(normalizeText(findBySelector(modal, ".ai-file-selection-pane").textContent), /3\s*件選択/);
    assert.match(normalizeText(findBySelector(modal, ".ai-preview-pane").textContent), /ドキュメント:\s*5\s*件/);
    assert.equal(hasElement(modal, ".ai-preview-pane") && hasElement(modal, ".ai-file-selection-pane"), true);
  });
});

test("処理できなかったリンクがあれば、プレビューと生成結果に、理由・対象・リンク元を時間切れから順に表示する", async () => {
  const skippedLinks = [
    { kind: "linked_note", target: "ないノート", source: "alpha.md", reason: "not_found", detail: "", seconds: 0 },
    { kind: "image", target: "slow.png", source: "beta.md", reason: "timeout", detail: "10 秒で打ち切り", seconds: 10.02 },
    { kind: "email", target: "/mail/broken.msg", source: "gamma.md", reason: "error", detail: "ValueError: 壊れている", seconds: 0.1 },
  ];
  const routes: Routes = {
    "POST /api/export/ai-html": (request) => {
      const response = (generateRoute["POST /api/export/ai-html"] as (r: typeof request) => Record<string, unknown>)(request);
      return { ...response, skipped_links: skippedLinks };
    },
  };
  await withAiInput({ routes }, async (app, page) => {
    const modal = await generate(app, page);
    const notice = findBySelector(modal, ".ai-skipped-links");
    assert.match(normalizeText(notice.textContent), /処理できなかったリンク\s*\(3\s*件\)/);
    const rows = [...notice.querySelectorAll("li")].map((item) => normalizeText(item.textContent));
    assert.equal(rows.length, 3);
    assert.match(rows[0], /時間切れ.*画像.*slow\.png.*リンク元:\s*beta\.md.*10 秒で打ち切り/);
    assert.match(rows[1], /エラー.*メール.*broken\.msg.*リンク元:\s*gamma\.md.*ValueError/);
    assert.match(rows[2], /見つからない.*リンク先ノート.*ないノート.*リンク元:\s*alpha\.md/);

    await click(findBySelector(modal, "button[aria-label='閉じる']"));
    assert.match(normalizeText(findBySelector(page, ".ai-skipped-links").textContent), /処理できなかったリンク\s*\(3\s*件\)/);
  });
});

test("処理できなかったリンクが無ければ、その欄は出さない", async () => {
  await withAiInput({}, async (app, page) => {
    const modal = await generate(app, page);
    assert.equal(hasElement(modal, ".ai-skipped-links"), false);
  });
});

test("HTML ソースへ切り替えると、生成した HTML の文字列を表示する", async () => {
  await withAiInput({}, async (app, page) => {
    const modal = await generate(app, page);
    await click(findByText(modal, ".ai-preview-pane button", "HTMLソース"));

    assert.equal(hasElement(modal, "iframe"), false);
    assert.match(normalizeText(findBySelector(modal, ".rag-code-block").textContent), /<html><body>\/docs\/alpha\.md/);

    await click(findByText(modal, ".ai-preview-pane button", "プレビュー表示"));
    assert.equal(hasElement(modal, "iframe"), true);
  });
});

test("プレビューは、閉じるボタンでも Esc キーでも閉じ、閉じたあとは生成結果の要約を表示する", async () => {
  await withAiInput({}, async (app, page) => {
    let modal = await generate(app, page);
    await click(findBySelector(modal, "button[aria-label='閉じる']"));
    assert.equal(hasElement(app.dom.window.document.body, ".ai-preview-modal"), false);
    assert.equal(app.api.requestsTo("POST /api/export/ai-html").length, 1);

    modal = await generate(app, page);
    await pressKey(app.dom.window.document.body, "Escape");
    assert.equal(hasElement(app.dom.window.document.body, ".ai-preview-modal"), false);
  });
});

test("対象ファイルのチェックを外すと、少し待ってから残りのノートで作り直す。最後の 1 件は外せない", async () => {
  await withAiInput({}, async (app, page) => {
    const modal = await generate(app, page);
    await click(findBySelector(modalFile(modal, "beta.md"), "input[type='checkbox']"));
    assert.equal(generateBodies(app).length, 1, "すぐには作り直さない");

    await wait(REGENERATE_WAIT_MS);
    assert.deepEqual(last(generateBodies(app))?.file_paths, ["/docs/alpha.md", "/docs/gamma.md"]);
    assert.equal(previewHtml(modal), "<html><body>/docs/alpha.md|/docs/gamma.md</body></html>");
    assert.equal(modalFile(modal, "beta.md").classList.contains("checked"), false);

    await click(findBySelector(modalFile(modal, "gamma.md"), "input[type='checkbox']"));
    await click(findBySelector(modalFile(modal, "alpha.md"), "input[type='checkbox']"));
    assert.match(last(app.dom.dialogs) ?? "", /少なくとも1件のファイルを選択してください/);
    assert.equal(modalFile(modal, "alpha.md").classList.contains("checked"), true);
  });
});

test("▲▼ で順序を入れ替えると、その順序で作り直す。端のノートは、それ以上動かせない", async () => {
  await withAiInput({}, async (app, page) => {
    const modal = await generate(app, page);
    assert.equal(findBySelector<HTMLButtonElement>(modalFile(modal, "alpha.md"), "button.ai-order-up").disabled, true);
    assert.equal(findBySelector<HTMLButtonElement>(modalFile(modal, "gamma.md"), "button.ai-order-down").disabled, true);

    await click(findBySelector(modalFile(modal, "gamma.md"), "button.ai-order-up"));
    await wait(REGENERATE_WAIT_MS);

    assert.deepEqual(modalFiles(modal), ["alpha.md", "gamma.md", "beta.md"]);
    assert.deepEqual(last(generateBodies(app))?.file_paths, ["/docs/alpha.md", "/docs/gamma.md", "/docs/beta.md"]);
    assert.match(normalizeText(modalFile(modal, "gamma.md").textContent), /#\s*2/);
  });
});

test("ドラッグ＆ドロップでも順序を入れ替えられる", async () => {
  await withAiInput({}, async (app, page) => {
    const modal = await generate(app, page);
    await dragAndDrop(modalFile(modal, "gamma.md"), modalFile(modal, "alpha.md"));
    await wait(REGENERATE_WAIT_MS);

    assert.deepEqual(modalFiles(modal), ["gamma.md", "alpha.md", "beta.md"]);
    assert.deepEqual(last(generateBodies(app))?.file_paths, ["/docs/gamma.md", "/docs/alpha.md", "/docs/beta.md"]);
  });
});

test("ノートごとにリンクを辿る深さを変えられ、変えるとその深さで作り直す（0〜10 に収める）", async () => {
  await withAiInput({}, async (app, page) => {
    const modal = await generate(app, page);
    const depthInput = (name: string): HTMLInputElement => findBySelector<HTMLInputElement>(modalFile(modal, name), "input.link-depth-input");
    assert.equal(depthInput("alpha.md").value, "2");
    assert.equal(depthInput("beta.md").value, "1");

    await typeInto(depthInput("beta.md"), "3");
    await wait(REGENERATE_WAIT_MS);
    assert.equal(last(generateBodies(app))?.file_depths["/docs/beta.md"], 3);

    await typeInto(depthInput("beta.md"), "99");
    await wait(REGENERATE_WAIT_MS);
    assert.equal(last(generateBodies(app))?.file_depths["/docs/beta.md"], 10);
  });
});

test("top タグのみを出すと、top タグつきのノートだけで作り直す", async () => {
  await withAiInput({}, async (app, page) => {
    const modal = await generate(app, page);
    await click(findBySelector(findByText(modal, "label", "obsidianのtopタグのみを出す"), "input"));
    await wait(REGENERATE_WAIT_MS);

    assert.deepEqual(last(generateBodies(app))?.file_paths, ["/docs/alpha.md"]);
    assert.deepEqual(modalFiles(modal), ["alpha.md"]);
  });
});

test("top タグつきのノートが 1 件も無いときに top タグのみを選ぶと、作り直さずに知らせる", async () => {
  await withAiInput({ results: [beta, gamma] }, async (app, page) => {
    const modal = await generate(app, page);
    await click(findBySelector(findByText(modal, "label", "obsidianのtopタグのみを出す"), "input"));
    await wait(REGENERATE_WAIT_MS);

    assert.match(last(app.dom.dialogs) ?? "", /topタグを含むノートが選択されていません/);
    assert.equal(generateBodies(app).length, 1);
  });
});

test("トークン最適化のチェックを外して作り直すと、最適化なしで生成する", async () => {
  await withAiInput({}, async (app, page) => {
    const modal = await generate(app, page);
    const optimize = findBySelector<HTMLInputElement>(findByText(modal, "label", "トークン最適化"), "input");
    assert.equal(optimize.checked, true);

    await click(optimize);
    await wait(REGENERATE_WAIT_MS);

    assert.equal(last(generateBodies(app))?.optimize_tokens, false);
  });
});

test("リンク先のノートは、親ノートの下にツリーで表示し、階層とリンク元を示す", async () => {
  await withAiInput({}, async (app, page) => {
    const modal = await generate(app, page);
    const children = [...modal.querySelectorAll<HTMLElement>(".ai-child-node-item")].map((item) => normalizeText(item.textContent));

    assert.equal(children.length, 2);
    assert.match(children[0], /階層 1.*child\.md.*リンク元:\s*alpha\.md/);
    assert.match(children[1], /階層 2.*grandchild\.md.*リンク元:\s*child\.md/);
    assert.match(normalizeText(findBySelector(modal, ".ai-file-selection-pane").textContent), /展開後:\s*5\s*件/);
  });
});

test("リンク先のノートのチェックを外すと、そのノートを除いて作り直す", async () => {
  await withAiInput({}, async (app, page) => {
    const modal = await generate(app, page);
    const child = findByText(modal, ".ai-child-node-item", "grandchild.md");
    await click(findBySelector(child, "input[type='checkbox']"));
    await wait(REGENERATE_WAIT_MS);

    assert.deepEqual(last(generateBodies(app))?.excluded_file_paths, ["/docs/grandchild.md"]);
    assert.deepEqual(app.dom.openedUrls, [], "チェックの切り替えでは、ファイルハブを開かない");
  });
});

test("ツリーは、ノートごとの切り替えと「すべて折りたたむ・すべて展開」で開閉できる", async () => {
  await withAiInput({}, async (app, page) => {
    const modal = await generate(app, page);
    const childCount = (): number => modal.querySelectorAll(".ai-child-node-item").length;
    assert.equal(childCount(), 2);

    await click(findBySelector(modalFile(modal, "alpha.md"), "button.ai-tree-toggle-btn"));
    assert.equal(childCount(), 0);
    assert.deepEqual(app.dom.openedUrls, [], "開閉の切り替えでは、ファイルハブを開かない");

    await click(findByText(modal, "button", "すべて展開"));
    assert.equal(childCount(), 2);
    await click(findByText(modal, "button", "すべて折りたたむ"));
    assert.equal(childCount(), 0);
    assert.equal(generateBodies(app).length, 1, "開閉だけでは作り直さない");
  });
});

test("対象ファイルやリンク先のノートを押すと、そのノートをファイルハブで開く", async () => {
  await withAiInput({}, async (app, page) => {
    const modal = await generate(app, page);
    await click(modalFile(modal, "beta.md"));
    await click(findByText(modal, ".ai-child-node-item", "child.md"));

    assert.deepEqual(app.dom.openedUrls, [
      "http://127.0.0.1:8001/api/fullpath?path=%2Fdocs%2Fbeta.md",
      "http://127.0.0.1:8001/api/fullpath?path=%2Fdocs%2Fchild.md",
    ]);
  });
});

// ---- 保存

test("HTML 保存は、生成した HTML をファイルへ保存し、保存先のパスをクリップボードへコピーする", async () => {
  await withAiInput(
    {
      routes: {
        "POST /api/export/ai-html/save": { success: true, saved_path: "/tmp/export/AI_Context_Document.html", file_name: "AI_Context_Document.html", size_bytes: 10 },
      },
    },
    async (app, page) => {
      const modal = await generate(app, page);
      await click(findBySelector(modal, "button.save-copy-path-button"));

      assert.deepEqual(app.lastBody("POST /api/export/ai-html/save"), {
        html_content: "<html><body>/docs/alpha.md|/docs/beta.md|/docs/gamma.md</body></html>",
        file_name: "AI_Context_Document.html",
      });
      assert.deepEqual(app.dom.clipboardWrites, ["/tmp/export/AI_Context_Document.html"]);
      assert.match(normalizeText(modal.textContent), /パスをコピーしました: \/tmp\/export\/AI_Context_Document\.html/);
    },
  );
});

test("クリップボードへ書き込めない環境でも、保存は成功として扱い、パスを手で写せるよう表示する", async () => {
  await withAiInput(
    {
      routes: {
        "POST /api/export/ai-html/save": { success: true, saved_path: "/tmp/export/a.html", file_name: "a.html", size_bytes: 10 },
      },
    },
    async (app, page) => {
      app.dom.denyClipboard();
      const modal = await generate(app, page);
      await click(findBySelector(modal, "button.save-copy-path-button"));

      assert.match(normalizeText(modal.textContent), /HTML保存完了 \(パス手動コピー\): \/tmp\/export\/a\.html/);
      assert.equal(queryAllByText(modal, "*", "HTML保存に失敗しました").length, 0);
      assert.equal(app.dom.dialogs.length, 0);
    },
  );
});

test("HTML の保存に失敗したら、理由を知らせる", async () => {
  await withAiInput({ routes: { "POST /api/export/ai-html/save": httpError(500, "書き込めません") } }, async (app, page) => {
    const modal = await generate(app, page);
    await click(findBySelector(modal, "button.save-copy-path-button"));

    assert.match(last(app.dom.dialogs) ?? "", /HTML保存に失敗しました: 書き込めません/);
  });
});

test("2 ファイルを保存は、いまの順序・深さ・除外・保存先で、マークダウンと結合画像の保存を要求する", async () => {
  await withAiInput(
    {
      routes: {
        "POST /api/export/ai-bundle/save": { success: true, markdown_name: "AI_Context_Document.md", image_name: "AI_Context_Document.png", has_images: true },
      },
    },
    async (app, page) => {
      const modal = await generate(app, page);
      await click(findBySelector(modalFile(modal, "beta.md"), "input[type='checkbox']"));
      await click(findBySelector(findByText(modal, ".ai-child-node-item", "grandchild.md"), "input[type='checkbox']"));
      await wait(REGENERATE_WAIT_MS);
      await click(findByText(modal, ".ai-preview-modal-header button", "2ファイルを保存"));

      const body = app.lastBody("POST /api/export/ai-bundle/save");
      assert.deepEqual(body.file_paths, ["/docs/alpha.md", "/docs/gamma.md"]);
      assert.deepEqual(body.file_depths, { "/docs/alpha.md": 2, "/docs/gamma.md": 1 });
      assert.deepEqual(body.excluded_file_paths, ["/docs/grandchild.md"]);
      assert.equal(body.target_dir, "/tmp/export");
      assert.equal(body.optimize_tokens, true);
      assert.equal(body.include_linked_emails, true);
      assert.match(normalizeText(modal.textContent), /2ファイル保存完了: AI_Context_Document\.md & AI_Context_Document\.png/);
    },
  );
});

test("コードコピーは HTML をクリップボードへ入れ、HTML DL はファイルとしてダウンロードさせる", async () => {
  await withAiInput({}, async (app, page) => {
    const modal = await generate(app, page);
    await click(findByText(modal, ".ai-preview-modal-header button", "コードコピー"));
    assert.deepEqual(app.dom.clipboardWrites, ["<html><body>/docs/alpha.md|/docs/beta.md|/docs/gamma.md</body></html>"]);

    await click(findByText(modal, ".ai-preview-modal-header button", "HTML DL"));
    assert.equal(app.dom.downloads.length, 1);
    assert.equal(await app.dom.downloads[0].text(), "<html><body>/docs/alpha.md|/docs/beta.md|/docs/gamma.md</body></html>");
  });
});

// ---- 保存先フォルダ

test("保存先フォルダは、サーバーに保存された設定を表示し、ボタンでそのフォルダを開く", async () => {
  await withAiInput({ routes: { "POST /api/export/open-folder": { success: true, opened_path: "/tmp/export" } } }, async (app, page) => {
    assert.match(normalizeText(page.textContent), /\/tmp\/export/);

    await click(findByText(page, "button", "Explorerで開く"));
    assert.deepEqual(app.lastBody("POST /api/export/open-folder"), { folder_path: "/tmp/export" });

    const modal = await generate(app, page);
    await click(findByText(modal, ".ai-preview-modal-header button", "フォルダを開く"));
    assert.equal(app.api.requestsTo("POST /api/export/open-folder").length, 2);
  });
});

test("保存先設定で入力したフォルダをサーバーへ保存し、表示へ反映する。空のままでは保存しない", async () => {
  await withAiInput(
    {
      routes: {
        "POST /api/export/config": (request) => ({ success: true, export_folder: (request.body as { export_folder: string }).export_folder }),
      },
    },
    async (app, page) => {
      await click(findByText(page, "button", "保存先設定"));
      const dialog = findBySelector(app.dom.window.document.body, ".ai-folder-config-modal");
      const input = findBySelector<HTMLInputElement>(dialog, "input[type='text']");
      assert.equal(input.value, "/tmp/export");

      await typeInto(input, "   ");
      await click(findByText(dialog, "button", "保存"));
      assert.match(last(app.dom.dialogs) ?? "", /保存先フォルダのパスを入力してください/);
      assert.equal(app.api.requestsTo("POST /api/export/config").length, 0);

      await typeInto(input, " /Users/me/AI_Inputs ");
      await click(findByText(dialog, "button", "保存"));

      assert.deepEqual(app.lastBody("POST /api/export/config"), { export_folder: "/Users/me/AI_Inputs" });
      assert.equal(hasElement(app.dom.window.document.body, ".ai-folder-config-modal"), false);
      assert.match(normalizeText(page.textContent), /\/Users\/me\/AI_Inputs/);
    },
  );
});
