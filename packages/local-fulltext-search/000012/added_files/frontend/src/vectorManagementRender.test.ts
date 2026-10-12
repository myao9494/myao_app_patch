/**
 * ベクトル管理画面を、状態を与えて描画するテスト。
 * ブラウザーを使わないサーバー描画のため、検証できるのは表示内容だけ（操作や通信は行わない）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";

import { closeRenderer, installBrowserStubs, loadSourceModule, renderToHtml, visibleText } from "./testing/render.ts";
import type { UseVectorManagementResult } from "./hooks/useVectorManagement.ts";
import type { VectorIndexProgress, VectorIndexStats, VectorModelStatus } from "./types.ts";

test.before(() => installBrowserStubs());
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
  device: "mps",
  device_name: "Apple Silicon GPU (Metal)",
  mps_available: true,
  has_faiss: true,
};

const indexStats: VectorIndexStats = {
  document_count: 120,
  chunk_count: 480,
  db_size_bytes: 4_194_304,
  db_size_mb: 4,
  models: {
    "ruri-v3-30m": { document_count: 120, chunk_count: 480, db_size_bytes: 4_194_304, db_size_mb: 4 },
    "ruri-v3-310m": { document_count: 0, chunk_count: 0, db_size_bytes: 0, db_size_mb: 0 },
  },
};

async function renderVectorPart(
  modulePath: string,
  exportName: string,
  overrides: Partial<UseVectorManagementResult>,
): Promise<string> {
  const { useVectorManagement } = await loadSourceModule<typeof import("./hooks/useVectorManagement.ts")>(
    "/src/hooks/useVectorManagement.ts",
  );
  const module = await loadSourceModule<Record<string, (props: { vector: UseVectorManagementResult }) => JSX.Element>>(
    modulePath,
  );
  return renderToHtml(
    () => createElement(module[exportName], { vector: { ...useVectorManagement({ confirmIndexDeletion: true }), ...overrides } }),
    {},
  );
}

test("モデルごとのバッジは、インデックス済みなら件数と容量を、無ければ未インデックスを表示する", async () => {
  const { ModelStatsBadge } = await loadSourceModule<typeof import("./components/vectorManagement/ModelStatsBadge.tsx")>(
    "/src/components/vectorManagement/ModelStatsBadge.tsx",
  );

  assert.match(
    visibleText(renderToHtml(ModelStatsBadge, { modelType: "light", indexStats })),
    /インデックス済: 120件 \(4MB\)/,
  );
  assert.match(visibleText(renderToHtml(ModelStatsBadge, { modelType: "standard", indexStats })), /未インデックス/);
  assert.match(visibleText(renderToHtml(ModelStatsBadge, { modelType: "light", indexStats: null })), /未インデックス/);
});

test("モデル選択パネルは、軽量と標準の両モデルと、それぞれのインデックス状況を表示する", async () => {
  const text = visibleText(
    await renderVectorPart("/src/components/vectorManagement/VectorModelPanel.tsx", "VectorModelPanel", {
      modelStatus,
      indexStats,
    }),
  );

  assert.match(text, /ruri-v3-30m/);
  assert.match(text, /ruri-v3-310m/);
  assert.match(text, /インデックス済: 120件/);
  assert.match(text, /未インデックス/);
});

test("インデックス管理パネルは、実行中は進捗を、完了後は結果の内訳を表示する", async () => {
  const running: VectorIndexProgress = {
    is_indexing: true,
    progress: {
      processed_files: 30,
      total_files: 120,
      progress_pct: 25,
      current_file: "/vault/notes/design.md",
      elapsed_sec: 12,
      estimated_remaining_sec: 36,
    },
    last_result: null,
  };
  const finished: VectorIndexProgress = {
    is_indexing: false,
    progress: null,
    last_result: {
      total_files: 120,
      new_count: 7,
      updated_count: 3,
      skipped_count: 110,
      deleted_count: 0,
      document_count: 120,
      chunk_count: 480,
      indexing_time_sec: 9.5,
      embedding_time_sec: 6.1,
      db_size_mb: 4,
    },
  };
  const panel = "/src/components/vectorManagement/VectorIndexPanel.tsx";

  const runningText = visibleText(
    await renderVectorPart(panel, "VectorIndexPanel", { indexProgress: running, currentProg: running.progress }),
  );
  assert.match(runningText, /30\s*\/\s*120/);
  assert.match(runningText, /design\.md/);

  const finishedText = visibleText(
    await renderVectorPart(panel, "VectorIndexPanel", { indexProgress: finished, lastResult: finished.last_result }),
  );
  assert.match(finishedText, /差分インデックス更新/);
  assert.match(finishedText, /全件再/);
  for (const value of ["7", "3", "110", "480"]) {
    assert.match(finishedText, new RegExp(`(^|\\D)${value}(\\D|$)`), `結果の内訳に ${value} が表示される`);
  }
});

test("稼働状況の見出しは、類似語・専門用語の管理場所を案内する", async () => {
  const text = visibleText(
    await renderVectorPart("/src/components/vectorManagement/VectorStatusHeader.tsx", "VectorStatusHeader", { modelStatus }),
  );

  assert.match(text, /類似語・専門用語は\s*「検索ルール管理」\s*で一元管理/);
  assert.match(text, /GPU稼働中: Apple Silicon/);
  assert.match(text, /FAISS/);
});

test("ベンチマークパネルは、意地悪な入力のプリセットを選べる", async () => {
  const text = visibleText(
    await renderVectorPart("/src/components/vectorManagement/VectorBenchmarkPanel.tsx", "VectorBenchmarkPanel", {}),
  );

  for (const preset of ["超長文", "特殊記号", "見出し乱舞"]) {
    assert.match(text, new RegExp(preset));
  }
});
