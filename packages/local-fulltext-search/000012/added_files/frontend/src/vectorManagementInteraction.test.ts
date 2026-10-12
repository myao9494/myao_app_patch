/**
 * ベクトル管理画面を DOM へ描画し、操作のあとの API 呼び出しと表示を検証するテスト。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { appSettings } from "./testing/apiFixtures.ts";
import { click, findBySelector, findByText, installDom, installFetchStub, mount, normalizeText, queryAllByText } from "./testing/dom.ts";
import { closeRenderer, loadSourceModule } from "./testing/render.ts";
import type { VectorIndexProgress, VectorIndexStats, VectorModelStatus } from "./types.ts";

type PageModule = typeof import("./components/VectorManagementPage.tsx");

test.after(() => closeRenderer());

const modelStatus: VectorModelStatus = {
  loaded: true,
  model_path: "/models/ruri-v3-30m",
  current_model: "ruri-v3-30m",
  dim: 256,
  is_mock: false,
  default_light_path: "/models/ruri-v3-30m",
  default_standard_path: "/models/ruri-v3-310m",
  light_available: true,
  standard_available: true,
  device: "cpu",
  device_name: "CPU",
  has_faiss: true,
};

const indexStats: VectorIndexStats = { document_count: 3, chunk_count: 9, db_size_bytes: 1024, db_size_mb: 0.01, models: {} };

const idle: VectorIndexProgress = { is_indexing: false, progress: null, last_result: null };

const lastResult = {
  total_files: 5,
  new_count: 2,
  updated_count: 0,
  skipped_count: 0,
  deleted_count: 0,
  document_count: 2,
  chunk_count: 4,
  indexing_time_sec: 1.5,
  embedding_time_sec: 1.0,
  db_size_mb: 0.02,
};

async function openPage(routes: Parameters<typeof installFetchStub>[0] = {}) {
  const dom = installDom();
  const api = installFetchStub({
    "GET /api/vector/model/status": modelStatus,
    "GET /api/vector/index/stats": indexStats,
    "GET /api/vector/index/progress": idle,
    "GET /api/index/settings": appSettings(),
    ...routes,
  });
  const { VectorManagementPage } = await loadSourceModule<PageModule>("/src/components/VectorManagementPage.tsx");
  const view = await mount(VectorManagementPage, { confirmIndexDeletion: false });
  return {
    api,
    dom,
    view,
    close: async () => {
      await view.unmount();
      api.restore();
      dom.close();
    },
  };
}

test("インデックス作成中は中止ボタンを表示し、押すと中止を要求する", async () => {
  const page = await openPage({
    "GET /api/vector/index/progress": {
      is_indexing: true,
      progress: {
        processed_files: 2,
        total_files: 10,
        progress_pct: 20,
        current_file: "note.md",
        elapsed_sec: 3,
        estimated_remaining_sec: 12,
      },
      last_result: null,
    },
    "POST /api/vector/index/cancel": { cancel_requested: true },
  });
  try {
    await click(findByText(page.view.container, "button", "中止"));

    assert.equal(page.api.requestsTo("POST /api/vector/index/cancel").length, 1);
    assert.match(normalizeText(page.view.container.textContent), /中止を要求しました/);
  } finally {
    await page.close();
  }
});

test("インデックスを作成していないときは中止ボタンを表示しない", async () => {
  const page = await openPage();
  try {
    assert.deepEqual(queryAllByText(page.view.container, "button", "中止"), []);
  } finally {
    await page.close();
  }
});

test("中止で終わった結果は、完了ではなく中止として表示する", async () => {
  const page = await openPage({
    "GET /api/vector/index/progress": { is_indexing: false, progress: null, last_result: { ...lastResult, cancelled: true } },
  });
  try {
    const text = normalizeText(page.view.container.textContent);

    assert.match(text, /中止しました/);
    assert.doesNotMatch(text, /更新完了|再インデックス完了/);
  } finally {
    await page.close();
  }
});

test("全件再インデックスは、既存のインデックスが残ることを確認してから開始する", async () => {
  const page = await openPage({ "POST /api/vector/index/start": { message: "started", target_folders: ["/docs"] } });
  try {
    await click(findByText(page.view.container, "button", "全件再インデックス"));

    const started = page.api.requestsTo("POST /api/vector/index/start");
    assert.equal(started.length, 1);
    assert.equal((started[0].body as { force_reindex: boolean }).force_reindex, true);
    assert.match(page.dom.dialogs[0], /作り直します/);
    assert.match(page.dom.dialogs[0], /置き換わるまで残ります/);
    assert.doesNotMatch(page.dom.dialogs[0], /完全に初期化/);
  } finally {
    await page.close();
  }
});

test("全件再インデックスの確認を断ると、何も開始しない", async () => {
  const page = await openPage();
  try {
    page.dom.setConfirmAnswer(false);
    await click(findByText(page.view.container, "button", "全件再インデックス"));

    assert.equal(page.api.requestsTo("POST /api/vector/index/start").length, 0);
  } finally {
    await page.close();
  }
});

test("検証用プリセットは本文を送って測定し、ファイルやインデックスを更新する API は呼ばない", async () => {
  const page = await openPage({
    "POST /api/vector/benchmark/text": {
      relative_path: "sample_benchmark.md",
      status: "measured",
      chunk_count: 26,
      io_hash_time_ms: 0,
      chunking_time_ms: 1.2,
      embedding_time_ms: 30.5,
      db_time_ms: 0,
      total_time_ms: 31.7,
    },
  });
  try {
    await click(findByText(page.view.container, "button", "超長文"));

    const measured = page.api.requestsTo("POST /api/vector/benchmark/text");
    assert.equal(measured.length, 1);
    const body = measured[0].body as { name: string; content: string };
    assert.equal(body.name, "sample_benchmark.md");
    assert.ok(body.content.includes("第25セクション"), "プリセットで作った本文を送る");
    assert.equal(page.api.requestsTo("POST /api/vector/index/update-file").length, 0);
    const text = normalizeText(page.view.container.textContent);
    assert.match(text, /チャンク数: 26/);
    assert.match(text, /31\.7 ms \(26 chunks\)/, "履歴にもチャンク数を表示する");
  } finally {
    await page.close();
  }
});

test("ファイルパスを指定した測定は、そのファイルの差分更新を実行して結果を表示する", async () => {
  const page = await openPage({
    "POST /api/vector/index/update-file": {
      relative_path: "sample_benchmark.md",
      status: "updated",
      chunk_count: 4,
      io_hash_time_ms: 0.4,
      chunking_time_ms: 0.8,
      embedding_time_ms: 12,
      db_time_ms: 1.1,
      total_time_ms: 14.3,
    },
  });
  try {
    await click(findByText(page.view.container, "button", "差分更新を実行"));

    const updated = page.api.requestsTo("POST /api/vector/index/update-file");
    assert.equal(updated.length, 1);
    assert.deepEqual(updated[0].body, { file_path: "sample_benchmark.md" });
    assert.match(normalizeText(page.view.container.textContent), /14\.3 ms \(4 chunks\)/);
  } finally {
    await page.close();
  }
});

function headerText(container: ParentNode): string {
  return normalizeText(container.textContent);
}

test("推論に使う装置を、GPU（Apple Silicon / CUDA）か CPU かで見分けられるように表示する", async () => {
  const cases: Array<[Partial<VectorModelStatus>, RegExp]> = [
    [{ device: "mps", device_name: "Apple Silicon GPU (Metal)" }, /GPU稼働中: Apple Silicon \(Metal\)/],
    [{ device: "cuda:0", device_name: "NVIDIA RTX 4090" }, /GPU稼働中: NVIDIA RTX 4090/],
    [{ device: "cpu", device_name: "CPU" }, /CPU稼働中 \(フォールバック\)/],
  ];
  for (const [status, expected] of cases) {
    const page = await openPage({ "GET /api/vector/model/status": { ...modelStatus, ...status } });
    try {
      assert.match(headerText(page.view.container), expected);
    } finally {
      await page.close();
    }
  }
});

test("検索エンジンが FAISS か NumPy かを表示し、FAISS が無いときは導入方法を案内する", async () => {
  const withFaiss = await openPage();
  try {
    assert.match(headerText(withFaiss.view.container), /エンジン: FAISS \(高速\)/);
  } finally {
    await withFaiss.close();
  }

  const withoutFaiss = await openPage({ "GET /api/vector/model/status": { ...modelStatus, has_faiss: false } });
  try {
    assert.match(headerText(withoutFaiss.view.container), /エンジン: NumPy \(フォールバック \/ faiss未導入\)/);
    const badge = [...withoutFaiss.view.container.querySelectorAll<HTMLElement>("[title]")].find((element) =>
      (element.getAttribute("title") ?? "").includes("faiss-cpu"),
    );
    assert.ok(badge, "pip install faiss-cpu の案内を表示する");
  } finally {
    await withoutFaiss.close();
  }
});

test("インデックス作成中は、画面の見出しにも作成中であることを表示する", async () => {
  const page = await openPage({
    "GET /api/vector/index/progress": {
      is_indexing: true,
      progress: { processed_files: 1, total_files: 4, progress_pct: 25, current_file: "a.md", elapsed_sec: 1, estimated_remaining_sec: 3 },
      last_result: null,
    },
  });
  try {
    const text = headerText(page.view.container);

    assert.match(text, /ベクトルインデックス作成中/);
    assert.match(text, /1 \/ 4 ファイル \(25%\)/);
    assert.match(text, /a\.md/);
  } finally {
    await page.close();
  }
});

test("読み込み済みのモデルを稼働中として示し、別のモデルを選ぶと未ロードの選択として示す", async () => {
  const page = await openPage();
  try {
    const cardText = (model: string): string =>
      normalizeText(findBySelector(page.view.container, `.vector-model-card[data-model='${model}']`).textContent);
    assert.match(cardText("light"), /稼働中 \(アクティブ\)/);
    assert.doesNotMatch(cardText("standard"), /稼働中 \(アクティブ\)/);
    assert.match(headerText(page.view.container), /ロード済 \(256次元 \/ ruri-v3-30m\)/);

    await click(findBySelector(page.view.container, ".vector-model-card[data-model='standard']"));

    assert.equal(findBySelector(page.view.container, ".vector-model-card[data-model='standard']").getAttribute("aria-checked"), "true");
    assert.equal(findBySelector(page.view.container, ".vector-model-card[data-model='light']").getAttribute("aria-checked"), "false");
    assert.match(cardText("standard"), /選択中 \(未ロード\)/);
    assert.match(headerText(page.view.container), /選択したモデルをロードして切替/);
  } finally {
    await page.close();
  }
});

test("選んだモデルをロードすると、そのモデルのパスで読み込みを要求し、次元数を知らせる", async () => {
  const page = await openPage({ "POST /api/vector/model/load": { loaded: true, dim: 768 } });
  try {
    await click(findBySelector(page.view.container, ".vector-model-card[data-model='standard']"));
    await click(findByText(page.view.container, "button", "選択したモデルをロードして切替"));

    assert.equal((page.api.requestsTo("POST /api/vector/model/load")[0].body as { model_path: string }).model_path, "/models/ruri-v3-310m");
    assert.match(headerText(page.view.container), /モデルをロードしました \(768次元\)/);
  } finally {
    await page.close();
  }
});

async function openPageConfirming(routes: Parameters<typeof installFetchStub>[0]) {
  const dom = installDom();
  const api = installFetchStub({
    "GET /api/vector/model/status": modelStatus,
    "GET /api/vector/index/stats": indexStats,
    "GET /api/vector/index/progress": idle,
    "GET /api/index/settings": appSettings(),
    "POST /api/vector/index/start": { message: "started", target_folders: ["/docs"] },
    ...routes,
  });
  const { VectorManagementPage } = await loadSourceModule<PageModule>("/src/components/VectorManagementPage.tsx");
  const view = await mount(VectorManagementPage, { confirmIndexDeletion: true });
  return {
    api,
    dom,
    view,
    close: async () => {
      await view.unmount();
      api.restore();
      dom.close();
    },
  };
}

test("差分更新は、見つからなくなったファイルがあれば削除してよいかを確認し、許可されたときだけ削除を指示する", async () => {
  for (const [answer, expected] of [[true, true], [false, false]] as const) {
    const page = await openPageConfirming({
      "POST /api/vector/index/pending-deletions": { pending_deletions: ["/docs/gone.md"], count: 1 },
    });
    try {
      page.dom.setConfirmAnswer(answer);
      await click(findByText(page.view.container, "button", "差分インデックス更新"));

      assert.match(page.dom.dialogs[0], /\/docs\/gone\.md/);
      const started = page.api.requestsTo("POST /api/vector/index/start")[0].body as {
        force_reindex: boolean;
        clean_deleted_files: boolean;
      };
      assert.equal(started.force_reindex, false);
      assert.equal(started.clean_deleted_files, expected);
    } finally {
      await page.close();
    }
  }
});

test("差分更新で、消えたファイルが無ければ確認せず、削除も指示しない", async () => {
  const page = await openPageConfirming({
    "POST /api/vector/index/pending-deletions": { pending_deletions: [], count: 0 },
  });
  try {
    await click(findByText(page.view.container, "button", "差分インデックス更新"));

    assert.equal(page.dom.dialogs.length, 0);
    assert.equal((page.api.requestsTo("POST /api/vector/index/start")[0].body as { clean_deleted_files: boolean }).clean_deleted_files, false);
  } finally {
    await page.close();
  }
});

test("削除時の確認を無効にしているときは、差分更新で削除候補を調べず、削除も指示しない", async () => {
  const page = await openPage({ "POST /api/vector/index/start": { message: "started", target_folders: ["/docs"] } });
  try {
    await click(findByText(page.view.container, "button", "差分インデックス更新"));

    assert.equal(page.api.requestsTo("POST /api/vector/index/pending-deletions").length, 0);
    assert.equal((page.api.requestsTo("POST /api/vector/index/start")[0].body as { clean_deleted_files: boolean }).clean_deleted_files, false);
  } finally {
    await page.close();
  }
});
