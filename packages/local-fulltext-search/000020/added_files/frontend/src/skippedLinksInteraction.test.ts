/**
 * 走査でたどらなかったフォルダのリンクの案内を DOM へ描画して確かめる。
 *
 * 仕様:
 * - 未確認のリンクがあれば、どのページでもポップアップでリンクと元のフォルダを案内する。
 * - 「確認しました」で確認済みをサーバーへ送り、閉じる。送れなかったときは閉じずにエラーを出す。
 * - インデックスが終わるたびに読み直す。
 * - 案内を取得できなくても、画面の操作は止めない。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { indexStatus, searchResponse, searchResult } from "./testing/apiFixtures.ts";
import { withApp } from "./testing/appHarness.ts";
import { click, findByText, httpError, normalizeText } from "./testing/dom.ts";
import { closeRenderer } from "./testing/render.ts";

test.after(() => closeRenderer());

const junction = {
  link_path: "C:/Work/共有資料",
  target_path: "D:/共有/資料",
  link_type: "junction",
  is_covered: false,
};
const symlink = {
  link_path: "/Users/me/notes/archive",
  target_path: "/Volumes/data/archive",
  link_type: "symlink",
  is_covered: false,
};

function dialog(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="dialog"][aria-label="検索しないフォルダの案内"]');
}

test("未確認のリンクがあれば、リンクと元のフォルダをポップアップで案内する", async () => {
  await withApp({ routes: { "GET /api/index/skipped-links": { items: [junction, symlink] } } }, async (app) => {
    const element = dialog(app.container);
    assert.ok(element, "ポップアップが開く");
    const text = normalizeText(element.textContent);
    assert.match(text, /C:\/Work\/共有資料/);
    assert.match(text, /D:\/共有\/資料/);
    assert.match(text, /ジャンクション/);
    assert.match(text, /\/Users\/me\/notes\/archive/);
    assert.match(text, /\/Volumes\/data\/archive/);
    assert.match(text, /シンボリックリンク/);
    assert.match(text, /元のフォルダを検索対象に追加/);
  });
});

test("リンクが無ければポップアップは開かない", async () => {
  await withApp({}, async (app) => {
    assert.equal(dialog(app.container), null);
  });
});

test("元のフォルダが検索対象に含まれるリンクは、その旨を案内する", async () => {
  await withApp(
    { routes: { "GET /api/index/skipped-links": { items: [{ ...junction, is_covered: true }] } } },
    async (app) => {
      const element = dialog(app.container);
      assert.ok(element);
      assert.match(normalizeText(element.textContent), /元のフォルダは検索対象に含まれています/);
    },
  );
});

test("確認すると確認済みをサーバーへ送って閉じる", async () => {
  await withApp(
    {
      routes: {
        "GET /api/index/skipped-links": { items: [junction, symlink] },
        "POST /api/index/skipped-links/acknowledge": { acknowledged_count: 2 },
      },
    },
    async (app) => {
      const element = dialog(app.container);
      assert.ok(element);

      await click(findByText(element, "button", "確認しました"));

      const [request] = app.api.requestsTo("POST /api/index/skipped-links/acknowledge");
      assert.deepEqual(request.body, { link_paths: [junction.link_path, symlink.link_path] });
      assert.equal(dialog(app.container), null);
    },
  );
});

test("確認を送れなかったときは、閉じずにエラーを出す", async () => {
  await withApp(
    {
      routes: {
        "GET /api/index/skipped-links": { items: [junction] },
        "POST /api/index/skipped-links/acknowledge": httpError(500, "保存できません"),
      },
    },
    async (app) => {
      const element = dialog(app.container);
      assert.ok(element);

      await click(findByText(element, "button", "確認しました"));

      assert.ok(dialog(app.container), "もう一度確認できるよう開いたまま");
      assert.match(app.error(), /保存できません/);
    },
  );
});

test("インデックスが終わったら読み直して案内する", async () => {
  let items: (typeof junction)[] = [];
  let status = indexStatus({ last_finished_at: "2026-11-01T00:00:00Z" });
  await withApp(
    {
      routes: {
        "GET /api/index/skipped-links": () => ({ items }),
        "GET /api/index/status": () => status,
        "POST /api/search": searchResponse([searchResult()]),
      },
    },
    async (app) => {
      assert.equal(dialog(app.container), null);

      items = [junction];
      status = indexStatus({ last_finished_at: "2026-11-02T00:00:00Z" });
      await app.runSearch();

      assert.ok(dialog(app.container), "新しいインデックスの結果で案内する");
    },
  );
});

test("案内を取得できなくても、エラーを出さず画面を使える", async () => {
  await withApp(
    { routes: { "GET /api/index/skipped-links": httpError(500, "読めません") } },
    async (app) => {
      assert.equal(dialog(app.container), null);
      assert.equal(app.error(), "");
    },
  );
});
