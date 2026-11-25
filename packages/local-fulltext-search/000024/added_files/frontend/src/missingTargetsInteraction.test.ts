/**
 * 見つからない検索対象フォルダの案内を DOM へ描画して確かめる。
 *
 * 仕様:
 * - 未確認の見つからないフォルダがあれば、どのページでもポップアップで案内する。
 * - 案内には、インデックス済みフォルダ画面で × の付いた行を選んで削除できることを書く。
 * - 「確認しました」で確認済みをサーバーへ送り、閉じる。送れなかったときは閉じずにエラーを出す。
 * - たどらなかったリンクの案内が開いているあいだは重ねず、閉じてから開く。
 * - 案内を取得できなくても、画面の操作は止めない。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { withApp } from "./testing/appHarness.ts";
import { click, findByText, httpError, normalizeText } from "./testing/dom.ts";
import { closeRenderer } from "./testing/render.ts";

test.after(() => closeRenderer());

const moved = { full_path: "C:/Users/me/000_work/tehai_system_document" };
const network = { full_path: "//fileserver/share/資料" };

function dialog(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="dialog"][aria-label="見つからない検索対象フォルダの案内"]');
}

function skippedLinksDialog(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="dialog"][aria-label="検索しないフォルダの案内"]');
}

test("見つからないフォルダがあれば、パスと対処をポップアップで案内する", async () => {
  await withApp({ routes: { "GET /api/index/missing-targets": { items: [moved, network] } } }, async (app) => {
    const element = dialog(app.container);
    assert.ok(element, "ポップアップが開く");
    const text = normalizeText(element.textContent);
    assert.match(text, /C:\/Users\/me\/000_work\/tehai_system_document/);
    assert.match(text, /\/\/fileserver\/share\/資料/);
    assert.match(text, /インデックス済みフォルダ/);
    assert.match(text, /×/);
  });
});

test("見つからないフォルダが無ければポップアップは開かない", async () => {
  await withApp({}, async (app) => {
    assert.equal(dialog(app.container), null);
  });
});

test("確認すると確認済みをサーバーへ送って閉じる", async () => {
  await withApp(
    {
      routes: {
        "GET /api/index/missing-targets": { items: [moved, network] },
        "POST /api/index/missing-targets/acknowledge": { acknowledged_count: 2 },
      },
    },
    async (app) => {
      const element = dialog(app.container);
      assert.ok(element);

      await click(findByText(element, "button", "確認しました"));

      const [request] = app.api.requestsTo("POST /api/index/missing-targets/acknowledge");
      assert.deepEqual(request.body, { full_paths: [moved.full_path, network.full_path] });
      assert.equal(dialog(app.container), null);
    },
  );
});

test("確認を送れなかったときは、閉じずにエラーを出す", async () => {
  await withApp(
    {
      routes: {
        "GET /api/index/missing-targets": { items: [moved] },
        "POST /api/index/missing-targets/acknowledge": httpError(500, "保存できません"),
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

test("たどらなかったリンクの案内が開いているあいだは重ねず、閉じたあとに開く", async () => {
  await withApp(
    {
      routes: {
        "GET /api/index/missing-targets": { items: [moved] },
        "GET /api/index/skipped-links": {
          items: [{ link_path: "C:/Work/共有資料", target_path: "D:/共有/資料", link_type: "junction", is_covered: false }],
        },
        "POST /api/index/skipped-links/acknowledge": { acknowledged_count: 1 },
      },
    },
    async (app) => {
      const links = skippedLinksDialog(app.container);
      assert.ok(links);
      assert.equal(dialog(app.container), null);

      await click(findByText(links, "button", "確認しました"));

      assert.ok(dialog(app.container));
    },
  );
});

test("案内を取得できなくても、エラーを出さずに画面を使える", async () => {
  await withApp({ routes: { "GET /api/index/missing-targets": httpError(500, "失敗") } }, async (app) => {
    assert.equal(dialog(app.container), null);
    assert.equal(app.error(), "");
  });
});
