/**
 * アプリ全体を描画して、初期表示を検証するテスト。
 * ブラウザーを使わないサーバー描画のため、検証できるのは最初に表示される内容だけ（操作や通信は行わない）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { closeRenderer, installBrowserStubs, loadSourceModule, renderToHtml, visibleText } from "./testing/render.ts";

type AppModule = typeof import("./App.tsx");

test.after(() => closeRenderer());

async function renderApp(options: Parameters<typeof installBrowserStubs>[0] = {}): Promise<string> {
  installBrowserStubs(options);
  const { default: App } = await loadSourceModule<AppModule>("/src/App.tsx");
  return renderToHtml(App, {});
}

test("初期表示は検索画面で、すべてのページへのタブが並ぶ", async () => {
  const html = await renderApp();
  const text = visibleText(html);

  for (const tab of [
    "検索",
    "インデックス済みフォルダ",
    "インデックス済みWebページ",
    "検索対象フォルダ",
    "検索ルール管理",
    "ベクトル管理",
    "AIインプット",
    "ランチャー",
  ]) {
    assert.match(html, new RegExp(`class="[^"]*\\bpage-tab\\b[^"]*"[^>]*>${tab}<`), `タブ「${tab}」が表示される`);
  }
  assert.match(html, /class="[^"]*\bpage-tab active"[^>]*>検索</, "検索タブが選択中になる");
  assert.match(text, /Search Results 0 \/ 0件/);
  assert.match(text, /一致する結果はありません。/);
  assert.doesNotMatch(html, /class="error-banner"/);
  assert.doesNotMatch(html, /class="notice-banner"/);
});

test("設定ドロワーは閉じた状態で描画され、各設定の入力欄を持つ", async () => {
  const html = await renderApp();

  assert.match(html, /<aside class="settings-drawer " aria-hidden="true">/);
  for (const id of ["web-fetch-mode", "gantt-parent"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(visibleText(html), /状態: インデックス待機中/);
});

test("起動 URL の検索条件が検索欄へ反映される", async () => {
  const html = await renderApp({ search: "?q=alpha+beta&full_path=%2Ftmp%2Fdocs&index_depth=2" });

  assert.match(html, /value="alpha beta"/);
  assert.match(html, /value="\/tmp\/docs"/);
  assert.match(html, /value="2"/);
});

test("検索方式の既定はハイブリッドで、保存済みの選択があればそれを使う", async () => {
  const selectedSearchType = (html: string): string | undefined =>
    html.match(/<button[^>]*search-type-button[^>]*aria-pressed="true"[^>]*>([^<]*)<\/button>/)?.[1];

  assert.match(selectedSearchType(await renderApp()) ?? "", /ハイブリッド/);
  assert.match(selectedSearchType(await renderApp({ storage: { search_type: "keyword" } })) ?? "", /通常/);
});
