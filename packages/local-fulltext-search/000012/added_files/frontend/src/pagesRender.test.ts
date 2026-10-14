/**
 * 各画面を、状態を与えて描画するテスト。
 * 画面は「フックの戻り値」を受け取って表示するだけなので、実物のフックの初期値へ検証したい状態を上書きして渡す。
 * ブラウザーを使わないサーバー描画のため、検証できるのは表示内容だけ（クリックなどの操作は行わない）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";

import { closeRenderer, installBrowserStubs, loadSourceModule, renderToHtml, visibleText } from "./testing/render.ts";
import type { UseIndexedTargetsResult } from "./hooks/useIndexedTargets.ts";
import type { UseLauncherResult } from "./hooks/useLauncher.ts";
import type { UseRuleManagementResult } from "./hooks/useRuleManagement.ts";
import type { UseSchedulerResult } from "./hooks/useScheduler.ts";
import type { IndexedTarget, SearchTargetFolder } from "./types.ts";

const noop = (): void => undefined;
const messages = { setErrorMessage: noop, setNoticeMessage: noop };

test.before(() => installBrowserStubs());
test.after(() => closeRenderer());

/** フックを呼ぶコンポーネントを 1 回だけ描画し、その HTML を返す。 */
function renderWithHooks(build: () => ReactElement): string {
  return renderToHtml(build, {});
}

// ---------------------------------------------------------------- スケジューラー

async function renderSchedulerPage(overrides: Partial<UseSchedulerResult>): Promise<string> {
  const { useScheduler } = await loadSourceModule<typeof import("./hooks/useScheduler.ts")>("/src/hooks/useScheduler.ts");
  const { SchedulerPage } = await loadSourceModule<typeof import("./pages/SchedulerPage.tsx")>("/src/pages/SchedulerPage.tsx");
  return renderWithHooks(() =>
    createElement(SchedulerPage, {
      onToggleMenu: noop,
      scheduler: { ...useScheduler({ pageView: "scheduler", ...messages }), ...overrides },
    }),
  );
}

test("スケジューラー画面は、登録済みのパス・実行状況・ログを表示する", async () => {
  const text = visibleText(
    await renderSchedulerPage({
      schedulerPaths: ["/docs/a", "/docs/b"],
      schedulerState: {
        paths: ["/docs/a", "/docs/b"],
        start_at: null,
        is_enabled: true,
        status: "running",
        last_started_at: null,
        last_finished_at: null,
        current_path: "/docs/a",
        last_error: "permission denied",
        logs: [
          { logged_at: "2026-10-01T00:00:00Z", level: "info", folder_path: "/docs/a", message: "started /docs/a" },
          { logged_at: "2026-10-01T00:01:00Z", level: "info", folder_path: "/docs/a", message: "finished /docs/a" },
        ],
      },
    }),
  );

  assert.match(text, /\/docs\/a 削除 \/docs\/b 削除/);
  assert.match(text, /状態: running/);
  assert.match(text, /処理中パス: \/docs\/a/);
  assert.match(text, /最終エラー: permission denied/);
  assert.match(text, /ログ 2件/);
  assert.match(text, /started \/docs\/a/);
  assert.match(text, /finished \/docs\/a/);
});

test("スケジューラー画面は、状態を取得する前でも待機中として表示できる", async () => {
  const text = visibleText(await renderSchedulerPage({}));

  assert.match(text, /スケジューラー/);
  assert.match(text, /状態: -/);
  assert.match(text, /ログ 0件/);
});

// ---------------------------------------------------------------- ランチャー

async function renderLauncherPage(overrides: Partial<UseLauncherResult>): Promise<string> {
  const { useLauncher } = await loadSourceModule<typeof import("./hooks/useLauncher.ts")>("/src/hooks/useLauncher.ts");
  const { LauncherPage } = await loadSourceModule<typeof import("./pages/LauncherPage.tsx")>("/src/pages/LauncherPage.tsx");
  return renderWithHooks(() =>
    createElement(LauncherPage, {
      onToggleMenu: noop,
      launcher: { ...useLauncher({ pageView: "launcher", ...messages }), ...overrides },
    }),
  );
}

test("ランチャー画面は、起動状態・PID・ログを表示する", async () => {
  const html = await renderLauncherPage({
    launcherHotkey: "double_shift",
    launcherState: {
      status: "running",
      is_running: true,
      pid: 4321,
      returncode: null,
      autostart: true,
      log_path: "/tmp/launcher.log",
      logs: ["line one", "line two"],
    },
  });
  const text = visibleText(html);

  assert.match(text, /状態: running/);
  assert.match(text, /PID: 4321/);
  assert.match(text, /自動起動: 有効/);
  assert.match(text, /ログ 2行/);
  assert.match(text, /line one/);
  // 保存済みの呼び出しキーが選択されている
  assert.match(html, /<option value="double_shift" selected="">/);
});

// ---------------------------------------------------------------- 検索ルール管理

async function renderRuleManagementPage(overrides: Partial<UseRuleManagementResult>): Promise<string> {
  const { useRuleManagement } = await loadSourceModule<typeof import("./hooks/useRuleManagement.ts")>(
    "/src/hooks/useRuleManagement.ts",
  );
  const { RuleManagementPage } = await loadSourceModule<typeof import("./pages/RuleManagementPage.tsx")>(
    "/src/pages/RuleManagementPage.tsx",
  );
  return renderWithHooks(() =>
    createElement(RuleManagementPage, {
      onChangePage: async () => undefined,
      onToggleMenu: noop,
      rules: {
        ...useRuleManagement({ confirmIndexDeletion: true, isRuleManagementPage: true, ...messages }),
        ...overrides,
      },
    }),
  );
}

test("検索ルール管理画面は、除外キーワード・類似語・拡張子の 3 つの一覧と件数を表示する", async () => {
  const text = visibleText(
    await renderRuleManagementPage({
      filteredExcludeKeywordEntries: ["node_modules", ".git"],
      filteredSynonymGroupEntries: ["PC,パソコン : パーソナルコンピュータ"],
      selectedIndexExtensions: [".md", ".pdf"],
    }),
  );

  assert.match(text, /除外キーワード 2件/);
  assert.match(text, /node_modules 削除 \.git 削除/);
  assert.match(text, /類似語・専門用語リスト 1件/);
  assert.match(text, /パーソナルコンピュータ/);
  assert.match(text, /インデックス対象拡張子 2件選択中/);
});

test("検索ルール管理画面は、未保存の変更があることを一覧ごとに示す", async () => {
  const saved = visibleText(await renderRuleManagementPage({}));
  const unsaved = visibleText(
    await renderRuleManagementPage({ hasUnsavedExcludeKeywords: true, hasUnsavedIndexExtensions: true }),
  );

  assert.match(saved, /自動保存済み/);
  assert.doesNotMatch(saved, /未保存/);
  assert.match(unsaved, /未保存/);
});

// ---------------------------------------------------------------- インデックス済み / 検索対象フォルダ

async function renderIndexedTargetsPage(
  mode: { isSearchTargetsPage: boolean; isIndexedWebTargetsPage: boolean },
  overrides: Partial<UseIndexedTargetsResult>,
): Promise<string> {
  const { useIndexedTargets } = await loadSourceModule<typeof import("./hooks/useIndexedTargets.ts")>(
    "/src/hooks/useIndexedTargets.ts",
  );
  const { useIndexStatus } = await loadSourceModule<typeof import("./hooks/useIndexStatus.ts")>("/src/hooks/useIndexStatus.ts");
  const { IndexedTargetsPage } = await loadSourceModule<typeof import("./pages/IndexedTargetsPage.tsx")>(
    "/src/pages/IndexedTargetsPage.tsx",
  );
  return renderWithHooks(() => {
    const indexing = useIndexStatus(messages);
    const targets = useIndexedTargets({
      ...messages,
      hasLoadedAppSettings: true,
      isIndexedWebTargetsPage: mode.isIndexedWebTargetsPage,
      refreshIndexStatus: indexing.refreshIndexStatus,
      appendExcludeKeywordDraft: noop,
      appendWebExcludeKeywordDraft: noop,
      clearSearchResults: noop,
      openMenu: noop,
    });
    return createElement(IndexedTargetsPage, {
      ...mode,
      indexing,
      onToggleMenu: noop,
      openLocationLabel: "Finderで開く",
      targets: { ...targets, ...overrides },
    });
  });
}

test("インデックス済みフォルダ画面は、フォルダごとのファイル数と選択件数を表示する", async () => {
  const filteredTargets: IndexedTarget[] = [
    { full_path: "/docs/a", source_type: "local", last_indexed_at: null, indexed_file_count: 12 },
    { full_path: "/docs/b", source_type: "local", last_indexed_at: null, indexed_file_count: 3 },
  ];
  const text = visibleText(
    await renderIndexedTargetsPage(
      { isSearchTargetsPage: false, isIndexedWebTargetsPage: false },
      { filteredTargets, selectedTargetPaths: ["/docs/a"] },
    ),
  );

  assert.match(text, /インデックス済みフォルダ/);
  assert.match(text, /\/docs\/a ファイル数: 12/);
  assert.match(text, /\/docs\/b ファイル数: 3/);
  assert.match(text, /選択中: 1件/);
  assert.match(text, /Finderで開く/);
});

test("検索対象フォルダ画面は、有効・無効の状態と操作を表示する", async () => {
  const filteredSearchTargets: SearchTargetFolder[] = [
    { full_path: "/work/enabled", source_type: "local", is_enabled: true, last_indexed_at: null, indexed_file_count: 5 },
    { full_path: "/work/disabled", source_type: "local", is_enabled: false, last_indexed_at: null, indexed_file_count: 0 },
  ];
  const html = await renderIndexedTargetsPage(
    { isSearchTargetsPage: true, isIndexedWebTargetsPage: false },
    { filteredSearchTargets },
  );
  const text = visibleText(html);

  assert.match(text, /検索対象フォルダ/);
  assert.match(text, /\/work\/enabled/);
  assert.match(text, /\/work\/disabled/);
  // 有効な対象だけチェックが入る
  assert.equal(html.match(/type="checkbox"[^>]*checked=""/g)?.length ?? 0, 1);
});
