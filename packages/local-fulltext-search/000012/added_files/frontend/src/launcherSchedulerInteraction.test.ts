/**
 * ランチャー管理画面とスケジューラー画面を DOM へ描画し、操作のあとの API 呼び出しと表示を検証するテスト。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { appSettings, launcherStatus, schedulerSettings } from "./testing/apiFixtures.ts";
import { withApp, type AppHarness } from "./testing/appHarness.ts";
import { click, findBySelector, findByText, httpError, normalizeText, selectOption, typeInto } from "./testing/dom.ts";
import { closeRenderer } from "./testing/render.ts";

test.after(() => closeRenderer());

// ---- ランチャー

function launcherButton(app: AppHarness, label: string): HTMLButtonElement {
  const button = [...app.container.querySelectorAll<HTMLButtonElement>(".launcher-actions-card button")].find(
    (item) => normalizeText(item.textContent) === label,
  );
  assert.ok(button, `${label} ボタンが表示される`);
  return button;
}

test("ランチャー画面は、状態・PID・自動起動・ログを表示する", async () => {
  await withApp(
    {
      routes: {
        "GET /api/launcher/status": launcherStatus({
          status: "running",
          is_running: true,
          pid: 4321,
          autostart: true,
          logs: ["started", "ready"],
        }),
      },
      page: "ランチャー",
    },
    async (app) => {
      const status = normalizeText(findBySelector(app.container, ".launcher-status-card").textContent);

      assert.match(status, /状態: running/);
      assert.match(status, /PID: 4321/);
      assert.match(status, /自動起動: 有効/);
      assert.equal(normalizeText(findBySelector(app.container, ".launcher-log-output").textContent), "started ready");
      assert.match(normalizeText(findBySelector(app.container, ".launcher-log-panel .section-header").textContent), /2\s*行/);
      assert.equal(launcherButton(app, "停止").disabled, false);
    },
  );
});

test("起動・再起動・停止のボタンは、それぞれの操作を要求して結果の状態を表示する", async () => {
  const running = launcherStatus({ status: "running", is_running: true, pid: 100 });
  await withApp(
    {
      routes: {
        "POST /api/launcher/start": running,
        "POST /api/launcher/restart": { ...running, pid: 200 },
        "POST /api/launcher/stop": launcherStatus(),
      },
      page: "ランチャー",
    },
    async (app) => {
      assert.equal(launcherButton(app, "停止").disabled, true, "止まっているあいだは停止を押せない");

      await click(launcherButton(app, "起動"));
      assert.equal(app.api.requestsTo("POST /api/launcher/start").length, 1);
      assert.match(app.notice(), /ランチャーを起動しました/);
      assert.match(normalizeText(findBySelector(app.container, ".launcher-status-card").textContent), /PID: 100/);

      await click(launcherButton(app, "再起動"));
      assert.match(app.notice(), /ランチャーを再起動しました/);
      assert.match(normalizeText(findBySelector(app.container, ".launcher-status-card").textContent), /PID: 200/);

      await click(launcherButton(app, "停止"));
      assert.match(app.notice(), /ランチャーを停止しました/);
      assert.match(normalizeText(findBySelector(app.container, ".launcher-status-card").textContent), /状態: stopped/);
    },
  );
});

test("ランチャーの操作に失敗したら、理由をエラーとして表示する", async () => {
  await withApp(
    { routes: { "POST /api/launcher/start": httpError(500, "ランチャーを起動できません") }, page: "ランチャー" },
    async (app) => {
      await click(launcherButton(app, "起動"));

      assert.match(app.error(), /ランチャーを起動できません/);
    },
  );
});

test("再読込ボタンで、最新の状態を読み込み直す", async () => {
  await withApp({ page: "ランチャー" }, async (app) => {
    const before = app.api.requestsTo("GET /api/launcher/status").length;

    await click(launcherButton(app, "再読込"));

    assert.equal(app.api.requestsTo("GET /api/launcher/status").length, before + 1);
  });
});

test("表示・非表示のショートカットは、選んだ時点で保存し、失敗したら元の選択へ戻す", async () => {
  await withApp(
    {
      routes: {
        "GET /api/index/settings": appSettings({ launcher_hotkey: "command_option" }),
        "PUT /api/index/settings": (request) => appSettings(request.body as Partial<ReturnType<typeof appSettings>>),
      },
      page: "ランチャー",
    },
    async (app) => {
      await selectOption(findBySelector<HTMLSelectElement>(app.container, "#launcher-hotkey"), "double_shift");

      assert.deepEqual(app.lastBody("PUT /api/index/settings"), { launcher_hotkey: "double_shift" });
      assert.equal(findBySelector<HTMLSelectElement>(app.container, "#launcher-hotkey").value, "double_shift");
      assert.match(app.notice(), /ショートカットを保存しました/);
    },
  );

  await withApp(
    { routes: { "PUT /api/index/settings": httpError(500, "保存できません") }, page: "ランチャー" },
    async (app) => {
      await selectOption(findBySelector<HTMLSelectElement>(app.container, "#launcher-hotkey"), "double_shift");

      assert.match(app.error(), /保存できません/);
      assert.equal(findBySelector<HTMLSelectElement>(app.container, "#launcher-hotkey").value, "command_option");
    },
  );
});

// ---- スケジューラー

async function openScheduler(app: AppHarness): Promise<HTMLElement> {
  await click(findBySelector(app.container, ".search-nav .menu-button"));
  await click(findByText(app.drawer(), ".settings-action-row > button", "スケジューラー"));
  return findBySelector(app.container, ".scheduler-panel");
}

function schedulerPaths(panel: HTMLElement): string[] {
  return [...panel.querySelectorAll(".scheduler-path-text")].map((item) => normalizeText(item.textContent));
}

test("スケジューラー画面は、保存済みの対象フォルダ・開始日時・状態・ログを表示する", async () => {
  await withApp(
    {
      routes: {
        "GET /api/index/scheduler": schedulerSettings({
          paths: ["/docs", "/work"],
          start_at: "2026-11-01T03:00:00+00:00",
          status: "idle",
          logs: [{ logged_at: "2026-10-01T00:00:00Z", level: "info", message: "フォルダのインデックスが完了しました。", folder_path: "/docs" }],
        }),
      },
    },
    async (app) => {
      const panel = await openScheduler(app);

      assert.deepEqual(schedulerPaths(panel), ["/docs", "/work"]);
      assert.match(findBySelector<HTMLInputElement>(panel, "#scheduler-start-at").value, /^2026-11-01T\d{2}:\d{2}$/);
      assert.match(normalizeText(findBySelector(panel, ".scheduler-log-list").textContent), /フォルダのインデックスが完了しました。/);
      assert.match(normalizeText(findBySelector(panel, ".scheduler-log-list").textContent), /\/docs/);
    },
  );
});

test("対象フォルダは、入力して追加・フォルダ選択で追加・削除ができ、同じパスは重ねて追加しない", async () => {
  await withApp({ routes: { "POST /api/folders/pick": { full_path: "/picked" } } }, async (app) => {
    const panel = await openScheduler(app);
    assert.match(normalizeText(findBySelector(panel, ".scheduler-path-list").textContent), /まだ対象フォルダはありません/);

    const pathInput = findBySelector<HTMLInputElement>(panel, "#scheduler-path-input");
    await typeInto(pathInput, "  /docs  ");
    await click(findByText(panel, ".scheduler-path-actions button", "追加"));
    assert.deepEqual(schedulerPaths(panel), ["/docs"]);
    assert.equal(findBySelector<HTMLInputElement>(panel, "#scheduler-path-input").value, "");

    await typeInto(findBySelector<HTMLInputElement>(panel, "#scheduler-path-input"), "/docs");
    await click(findByText(panel, ".scheduler-path-actions button", "追加"));
    assert.deepEqual(schedulerPaths(panel), ["/docs"]);

    await click(findByText(panel, ".scheduler-path-actions button", "選択"));
    assert.deepEqual(schedulerPaths(panel), ["/docs", "/picked"]);

    await click(findByText(findByText(panel, ".scheduler-path-item", "/docs"), "button", "削除"));
    assert.deepEqual(schedulerPaths(panel), ["/picked"]);
  });
});

test("空のパスは追加せず、エラーで知らせる", async () => {
  await withApp({}, async (app) => {
    const panel = await openScheduler(app);
    await click(findByText(panel, ".scheduler-path-actions button", "追加"));

    assert.match(app.error(), /スケジューラーに追加するパスを入力してください/);
  });
});

test("対象フォルダと開始日時がそろっていないと開始せず、不足を知らせる", async () => {
  await withApp({}, async (app) => {
    const panel = await openScheduler(app);
    const start = findByText(panel, ".scheduler-actions button", "");

    await click(start);
    assert.match(app.error(), /対象フォルダを 1 つ以上追加してください/);

    await typeInto(findBySelector<HTMLInputElement>(panel, "#scheduler-path-input"), "/docs");
    await click(findByText(panel, ".scheduler-path-actions button", "追加"));
    await click(start);
    assert.match(app.error(), /開始日時を入力してください/);
    assert.equal(app.api.requestsTo("POST /api/index/scheduler/start").length, 0);
  });
});

test("開始すると、対象フォルダと開始日時（タイムゾーンつき）を送り、開始を知らせる", async () => {
  await withApp(
    {
      routes: {
        "POST /api/index/scheduler/start": (request) => {
          const body = request.body as { paths: string[]; start_at: string };
          return schedulerSettings({ paths: body.paths, start_at: body.start_at, is_enabled: true, status: "scheduled" });
        },
      },
    },
    async (app) => {
      const panel = await openScheduler(app);
      await typeInto(findBySelector<HTMLInputElement>(panel, "#scheduler-path-input"), "/docs");
      await click(findByText(panel, ".scheduler-path-actions button", "追加"));
      await typeInto(findBySelector<HTMLInputElement>(panel, "#scheduler-start-at"), "2026-11-01T12:30");
      await click(findByText(panel, ".scheduler-actions button", ""));

      const body = app.lastBody("POST /api/index/scheduler/start") as { paths: string[]; start_at: string };
      assert.deepEqual(body.paths, ["/docs"]);
      assert.equal(new Date(body.start_at).getTime(), new Date(2026, 10, 1, 12, 30).getTime(), "入力した現地時刻を指す");
      assert.match(app.notice(), /スケジューラーを開始しました/);
    },
  );
});
