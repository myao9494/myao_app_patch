/**
 * ベクトル検索およびハイブリッド検索、新ページ（ベクトル管理・AIインプット）のフロントエンドUIテスト。
 **/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { search } from "./api/client.ts";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const searchBarPath = path.join(currentDirectory, "components", "SearchBar.tsx");
const resultsListPath = path.join(currentDirectory, "components", "ResultsList.tsx");
const appPath = path.join(currentDirectory, "App.tsx");
const appStylesPath = path.join(currentDirectory, "styles", "app.css");

test("search は search_type をそのまま API へ渡す", async () => {
  const originalFetch = globalThis.fetch;
  let requestedBody: any = null;

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestedBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(
      JSON.stringify({
        total: 0,
        items: [],
        has_more: false,
        next_offset: null,
        used_existing_index: false,
        background_refresh_scheduled: false,
        search_type: "hybrid",
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  try {
    await search({
      q: "テスト",
      full_path: "/docs",
      refresh_window_minutes: 0,
      search_type: "hybrid",
    });
    assert.equal(requestedBody?.search_type, "hybrid");

    await search({
      q: "テスト",
      full_path: "/docs",
      refresh_window_minutes: 0,
      search_type: "vector",
    });
    assert.equal(requestedBody?.search_type, "vector");

    await search({
      q: "テスト",
      full_path: "/docs",
      refresh_window_minutes: 0,
      search_type: "keyword",
    });
    assert.equal(requestedBody?.search_type, "keyword");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SearchBar には検索方式（ハイブリッド / ベクトル / 通常）の切り替えUIが含まれる", () => {
  const source = readFileSync(searchBarPath, "utf-8");
  assert.match(source, /searchType/);
  assert.match(source, /onSearchTypeChange/);
  assert.match(source, /search-type-toggle/);
  assert.match(source, /ハイブリッド/);
  assert.match(source, /ベクトル/);
  assert.match(source, /通常/);
});

test("ResultsList には一致理由バッジと核心文の表示が含まれる", () => {
  const source = readFileSync(resultsListPath, "utf-8");
  assert.match(source, /match_source/);
  assert.match(source, /salient_sentence/);
  assert.match(source, /result-match-badge/);
  assert.match(source, /result-salient-sentence/);
});

test("App.tsx には「ベクトル管理」と「AIインプット」のページタブと画面描画が含まれる", () => {
  const source = readFileSync(appPath, "utf-8");
  assert.match(source, /"vector-management"/);
  assert.match(source, /"ai-input"/);
  assert.match(source, /ベクトル管理/);
  assert.match(source, /AIインプット/);
  assert.match(source, /<VectorManagementPage/);
  assert.match(source, /<AiInputPage/);
});

test("app.css には検索方式トグルと一致バッジ、核心文のスタイルが定義されている", () => {
  const source = readFileSync(appStylesPath, "utf-8");
  assert.match(source, /\.search-type-toggle\s*\{/);
  assert.match(source, /\.result-match-badge\s*\{/);
  assert.match(source, /\.result-salient-sentence\s*\{/);
});

test("AiInputPage には PoC 準拠のドラッグ選択・5種プリセット・デュアルタブ・トークン概算が含まれる", () => {
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const source = readFileSync(aiInputPath, "utf-8");

  // ドラッグ選択 & Shift解除
  assert.match(source, /handleCheckboxMouseDown/);
  assert.match(source, /handleRowMouseEnter/);
  assert.match(source, /dragModeRef/);
  assert.match(source, /isDragging/);
  assert.match(source, /Shift/);

  // 5種プロンプトプリセット
  assert.match(source, /根拠付き/);
  assert.match(source, /修正・推敲/);
  assert.match(source, /要約/);
  assert.match(source, /課題・リスク/);
  assert.match(source, /カスタム/);

  // プレビューとコードのデュアルタブ
  assert.match(source, /previewTab/);
  assert.match(source, /iframe/);
  assert.match(source, /HTMLソース/);

  // ダウンロードとコピー
  assert.match(source, /handleDownload/);
  assert.match(source, /copyHtmlCode/);

  // トークン概算・サマリー
  assert.match(source, /トークン/);

  // 除外キーワード連携
  assert.match(source, /exclude_keywords|excludeKeywords/);
});

test("VectorManagementPage には PoC 準拠のモデル別バッジ・差分/全件更新・辞書エディタ・ベンチマークパネルが含まれる", () => {
  const vectorMgmtPath = path.join(currentDirectory, "components", "VectorManagementPage.tsx");
  const source = readFileSync(vectorMgmtPath, "utf-8");

  // モデル別バッジ
  assert.match(source, /getModelStatsBadge/);
  assert.match(source, /ruri-v3-30m/);
  assert.match(source, /ruri-v3-310m/);

  // 差分インデックス更新 ⚡ vs 全件再作成 🔄
  assert.match(source, /差分インデックス更新/);
  assert.match(source, /全件再/);

  // 類似語・専門用語の一元管理案内
  assert.match(source, /類似語・専門用語は/);
  assert.match(source, /検索ルール管理/);

  // 単一ファイルベンチマーク & 意地悪テストプリセット
  assert.match(source, /EVIL_PRESETS/);
  assert.match(source, /超長文/);
  assert.match(source, /特殊記号/);
  assert.match(source, /見出し乱舞/);

  // 完了サマリー
  assert.match(source, /indexing_time_sec/);
  assert.match(source, /skipped_count/);
});

test("isExcludedByKeywords はファイル名に除外キーワードが含まれるファイルを確実に除外する", async () => {
  const { isExcludedByKeywords } = await import("./filterUtils.ts");

  const excludeKeywords = "node_modules\n.git\ngantt_diff_summary\nold";

  // 1. gantt_diff_summary を含むファイル名（部分一致）は除外されること
  assert.strictEqual(
    isExcludedByKeywords("/work/data/gantt_diff_summary.json", "gantt_diff_summary.json", excludeKeywords),
    true
  );
  assert.strictEqual(
    isExcludedByKeywords("/work/data/2026_gantt_diff_summary_v1.md", "2026_gantt_diff_summary_v1.md", excludeKeywords),
    true
  );
  assert.strictEqual(
    isExcludedByKeywords("/work/data/my_gantt_diff_summary_notes.txt", "my_gantt_diff_summary_notes.txt", excludeKeywords),
    true
  );

  // 2. 通常のファイルは除外されないこと
  assert.strictEqual(
    isExcludedByKeywords("/work/notes/normal_project.md", "normal_project.md", excludeKeywords),
    false
  );

  // 3. old は older.md などの通常単語に誤爆せず、old.md や old_data.txt のみを除外すること
  assert.strictEqual(
    isExcludedByKeywords("/work/notes/older.md", "older.md", excludeKeywords),
    false
  );
  assert.strictEqual(
    isExcludedByKeywords("/work/notes/old.md", "old.md", excludeKeywords),
    true
  );
  assert.strictEqual(
    isExcludedByKeywords("/work/notes/old_data.txt", "old_data.txt", excludeKeywords),
    true
  );
});

test("VectorManagementPage は現在アクティブ（稼働中）なモデルを優先ハイライトし、稼働状態と選択状態を同期・識別できる", () => {
  const vectorMgmtPath = path.join(currentDirectory, "components", "VectorManagementPage.tsx");
  const source = readFileSync(vectorMgmtPath, "utf-8");

  // アクティブ判定関数の存在
  assert.match(source, /isModelActive/);

  // アクティブバッジ表示（稼働中 / アクティブ）
  assert.match(source, /稼働中|アクティブ/);

  // modelStatus からの自動選択同期ロジック
  assert.match(source, /setSelectedModelType/);
  assert.match(source, /current_model|model_path/);

  // アクティブモデルに対する強調枠線・グロースタイル
  assert.match(source, /boxShadow|rgba\(16,\s*185,\s*129|rgba\(56,\s*189,\s*248/);
});

test("VectorManagementPage はインデックス作成中の状態を一目で把握できるインジケーター・バッジ・進行中UIを表示する", () => {
  const vectorMgmtPath = path.join(currentDirectory, "components", "VectorManagementPage.tsx");
  const source = readFileSync(vectorMgmtPath, "utf-8");

  // refreshData 内で fetchVectorIndexProgress を初期取得していること
  assert.match(source, /const \[st, stats, prog\]/);

  // ヘッダーで「ベクトルインデックス作成中」であることを示すバッジ表示
  assert.match(source, /ベクトルインデックス作成中/);

  // インデックス作成中の視覚的バッジ（スピンアイコンやパルス）
  assert.match(source, /spin/);
});

test("App.tsx は検索ルール管理で類似語・専門用語リストを一元管理し、意味・解説の入力と表示に対応する", () => {
  const appPath = path.join(currentDirectory, "App.tsx");
  const source = readFileSync(appPath, "utf-8");

  // 類似語・専門用語リストの見出しと検索欄
  assert.match(source, /類似語・専門用語リスト/);
  assert.match(source, /類似語・専門用語を検索/);

  // コロン付きエントリの分解・解説アイコン表示
  assert.match(source, /item\.includes\(":"\)/);
  assert.match(source, /💬/);

  // 追加モーダルでの類似語および意味・解説入力欄
  assert.match(source, /newSynonymDesc/);
  assert.match(source, /意味・解説（専門用語としての説明、任意）/);
});

test("VectorManagementPage はヘッダー最上部に稼働デバイス（GPU MPS / CUDA / CPU）を常時表示する", () => {
  const vectorMgmtPath = path.join(currentDirectory, "components", "VectorManagementPage.tsx");
  const source = readFileSync(vectorMgmtPath, "utf-8");

  // ヘッダー最上部のデバイスバッジ
  assert.match(source, /GPU稼働中|GPU加速/);
  assert.match(source, /Apple Silicon/);
  assert.match(source, /CUDA/);
  assert.match(source, /CPU稼働中|CPU \(フォールバック\)/);
  assert.match(source, /modelStatus\.device/);
});

test("VectorManagementPage はベクトルエンジン状態（FAISS高速 / NumPyフォールバック）を表示し未導入時は案内する", () => {
  const vectorMgmtPath = path.join(currentDirectory, "components", "VectorManagementPage.tsx");
  const source = readFileSync(vectorMgmtPath, "utf-8");

  // FAISS 導入時・NumPy フォールバック時のエンジンバッジ表示
  assert.match(source, /has_faiss/);
  assert.match(source, /FAISS/);
  assert.match(source, /NumPy/);
  // 未導入時のインストール案内（pip install faiss-cpu 等）
  assert.match(source, /faiss-cpu/);
});

test("AiInputPage と APIクライアントは呼び出されるメールの追加オプション（include_linked_emails）に対応する", () => {
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");

  // チェックボックス「アウトプットに呼び出されるメールを追加する」のラベル
  assert.match(aiInputSource, /アウトプットに呼び出されるメールを追加する/);
  // state定義
  assert.match(aiInputSource, /includeLinkedEmails/);

  const clientPath = path.join(currentDirectory, "api", "client.ts");
  const clientSource = readFileSync(clientPath, "utf-8");

  // generateAiHtml および downloadAiHtml に include_linked_emails が定義されていること
  assert.match(clientSource, /include_linked_emails/);
});





