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

  // デフォルトで呼び出されるメールを含める設定（初期値 true）になっていること
  assert.match(aiInputSource, /const\s*\[includeLinkedEmails,\s*setIncludeLinkedEmails\]\s*=\s*useState\(true\)/);
  // state定義
  assert.match(aiInputSource, /includeLinkedEmails/);

  const clientPath = path.join(currentDirectory, "api", "client.ts");
  const clientSource = readFileSync(clientPath, "utf-8");

  // generateAiHtml および downloadAiHtml に include_linked_emails が定義されていること
  assert.match(clientSource, /include_linked_emails/);
});

test("VectorManagementPage と APIクライアントは差分更新時の削除確認（pending-deletions と cleanDeletedFiles）に対応する", () => {
  const vectorMgmtPath = path.join(currentDirectory, "components", "VectorManagementPage.tsx");
  const vectorMgmtSource = readFileSync(vectorMgmtPath, "utf-8");
  const clientPath = path.join(currentDirectory, "api", "client.ts");
  const clientSource = readFileSync(clientPath, "utf-8");

  // APIクライアントに pending-deletions と cleanDeletedFiles があること
  assert.match(clientSource, /fetchVectorPendingDeletions/);
  assert.match(clientSource, /clean_deleted_files/);

  // VectorManagementPage で pending deletions の取得と確認ダイアログが含まれること
  assert.match(vectorMgmtSource, /fetchVectorPendingDeletions/);
  assert.match(vectorMgmtSource, /cleanDeletedFiles/);
});

test("並び替えにハイブリッドスコア順・ベクトル類似度順・通常検索スコア順が追加され、default時はハイブリッド順位が最優先される", () => {
  const searchBarSource = readFileSync(searchBarPath, "utf-8");
  const appSource = readFileSync(appPath, "utf-8");

  // SearchBar に各スコア順の選択肢が存在すること
  assert.match(searchBarSource, /<option value="hybrid_score">ハイブリッドスコア順<\/option>/);
  assert.match(searchBarSource, /<option value="vector_score">ベクトル類似度順<\/option>/);
  assert.match(searchBarSource, /<option value="keyword_score">通常検索スコア順<\/option>/);

  // App.tsx の sortSearchResults で hybrid_score が優先されるロジックが存在すること
  assert.match(appSource, /hybridDifference/);
  assert.match(appSource, /item\.hybrid_score/);
  assert.match(appSource, /item\.vector_score/);
  assert.match(appSource, /item\.keyword_score/);
});

test("AiInputPage の検索ボックス右側に他（SearchBar）と同様の拡張子フィルター（extension-filter-input）が備わっている", () => {
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const source = readFileSync(aiInputPath, "utf-8");

  // extension-filter-input クラスの入力欄が存在すること
  assert.match(source, /extension-filter-input/);
  // 他（SearchBar）と同様の placeholder と title, aria-label を備えること
  assert.match(source, /placeholder="md excalidraw"/);
  assert.match(source, /title="拡張子フィルタ \(例: md, -png, -\.jpg\)"/);
  assert.match(source, /aria-label="検索拡張子フィルタ"/);
  // 拡張子フィルタのトークン解析またはフィルタリング関数が利用されていること
  assert.match(source, /filterSearchResultsByExtensions/);
  // search API 呼び出しに types パラメータとして渡されていること
  assert.match(source, /types:\s*extensionFilterText/);
});

test("AiInputPage の拡張子フィルターはデフォルトで 'md' が設定される", () => {
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const source = readFileSync(aiInputPath, "utf-8");

  // initialExtensionFilter のデフォルト値が "md" であること
  assert.match(source, /initialExtensionFilter\s*=\s*["']md["']/);
  // 空文字や未指定時に "md" にフォールバックする初期化・同期ロジックが存在すること
  assert.match(source, /initialExtensionFilter(?:\.trim\(\))?\s*\|\|\s*["']md["']/);
});

test("AiInputPage に特大プレビュー＆ファイル選択モーダル（左右2カラム・除外連動・保存＆パスコピー）が備わっている", () => {
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");
  const clientPath = path.join(currentDirectory, "api", "client.ts");
  const clientSource = readFileSync(clientPath, "utf-8");
  const cssPath = path.join(currentDirectory, "styles", "app.css");
  const cssSource = readFileSync(cssPath, "utf-8");

  // 1. client.ts に saveAiHtmlToFile が定義されていること
  assert.match(clientSource, /export async function saveAiHtmlToFile/);
  assert.match(clientSource, /\/api\/export\/ai-html\/save/);

  // 2. AiInputPage に特大プレビューモーダル（ai-preview-modal）と左右2カラム（左: プレビュー, 右: ファイル選択）が存在すること
  assert.match(aiInputSource, /ai-preview-modal/);
  assert.match(aiInputSource, /ai-preview-pane/);
  assert.match(aiInputSource, /ai-file-selection-pane/);

  // 3. 右側ペインに対象ファイル選択チェックボックスリストと連動ロジックが存在すること
  assert.match(aiInputSource, /modalActivePaths/);
  assert.match(aiInputSource, /handleToggleModalFile/);

  // 4. モーダルに保存＆パスコピーボタンがあり、saveAiHtmlToFile および クリップボードコピーと連動すること
  assert.match(aiInputSource, /handleSaveHtmlAndCopyPath/);
  assert.match(aiInputSource, /saveAiHtmlToFile/);
  assert.match(aiInputSource, /copyTextToClipboard|navigator\.clipboard\.writeText/);

  // 5. 特大モーダルのスタイル（96vw / 92vh などの大画面スタイル）が css に定義されていること
  assert.match(cssSource, /\.ai-preview-modal/);
  assert.match(cssSource, /\.ai-preview-pane/);
  assert.match(cssSource, /\.ai-file-selection-pane/);
});

test("AiInputPage はステップ2上部にも「AI用HTMLファイルを生成する」ボタンを備える", () => {
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");

  // ステップ2のセクション内に上部HTML生成ボタンが存在すること
  assert.match(aiInputSource, /ステップ 2: AIにインプットするノートを選択/);
  // ステップ2ヘッダーのアクションエリアに handleGenerateHtml を呼ぶ生成ボタンが存在すること
  assert.match(aiInputSource, /btn-generate-html-top|ai-generate-top-btn|AI用HTMLファイルを生成する/);
  // handleGenerateHtml がステップ2のボタンでもトリガーされ、無効化制御があること
  const step2Area = aiInputSource.slice(aiInputSource.indexOf("ステップ 2: AIにインプットするノートを選択"));
  assert.match(step2Area.slice(0, 1000), /handleGenerateHtml/);
  assert.match(step2Area.slice(0, 1000), /AI用HTMLファイルを生成する/);
});

test("AiInputPage のモーダルはmdファイルの表示順序変更（並び替え）に対応し、順序に応じたHTML再生成を行う", () => {
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");
  const cssPath = path.join(currentDirectory, "styles", "app.css");
  const cssSource = readFileSync(cssPath, "utf-8");

  // 1. モーダル内の順序管理ステート modalOrderedPaths が存在すること
  assert.match(aiInputSource, /modalOrderedPaths/);

  // 2. アイテム順序を入れ替えるハンドラ handleMoveModalFile が存在すること
  assert.match(aiInputSource, /handleMoveModalFile/);

  // 3. モーダル右側リストに並び替えボタン（▲ / ▼、または ai-order-btn）が存在すること
  assert.match(aiInputSource, /ai-order-btn|ai-order-up|ai-order-down/);
  assert.match(aiInputSource, /▲|▼/);

  // 4. 並び替え後に regenerateModalHtml が呼び出されること
  assert.match(aiInputSource, /regenerateModalHtml/);

  // 5. app.css に並び替えボタン関連のスタイルが定義されていること
  assert.match(cssSource, /\.ai-order-btn/);
});

test("AiInputPage のプレビューモーダルは画面全体（100vw × 100vh）を使い切る最大化スタイルであること", () => {
  const cssPath = path.join(currentDirectory, "styles", "app.css");
  const cssSource = readFileSync(cssPath, "utf-8");

  // .ai-preview-modal-backdrop の余白が 0（パディングなし）で画面全体をフルスクリーン化していること
  assert.match(cssSource, /\.ai-preview-modal-backdrop[\s\S]*?padding:\s*0/);

  // .ai-preview-modal が 100vw × 100vh で max-width / max-height なしの最大サイズであること
  assert.match(cssSource, /\.ai-preview-modal[\s\S]*?width:\s*100vw/);
  assert.match(cssSource, /\.ai-preview-modal[\s\S]*?height:\s*100vh/);
});

test("AiInputPage のモーダル内ドキュメント一覧はドラッグ＆ドロップによる順序変更に対応する", () => {
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");
  const cssPath = path.join(currentDirectory, "styles", "app.css");
  const cssSource = readFileSync(cssPath, "utf-8");

  // 1. ドラッグ用のステート（draggedIndex など）が存在すること
  assert.match(aiInputSource, /draggedIndex|dragOverIndex/);

  // 2. ドロップ時の順序入れ替えハンドラ handleDropModalFile が存在すること
  assert.match(aiInputSource, /handleDropModalFile/);

  // 3. アイテムに draggable 属性および onDragStart, onDrop ハンドラが設定されていること
  assert.match(aiInputSource, /draggable/);
  assert.match(aiInputSource, /onDragStart/);
  assert.match(aiInputSource, /onDrop/);

  // 4. ドラッグハンドル（⋮⋮ または ai-drag-handle）が存在すること
  assert.match(aiInputSource, /ai-drag-handle|⋮⋮|::/);

  // 5. CSSにドラッグ中またはドロップ先用のスタイルが定義されていること
  assert.match(cssSource, /\.ai-drag-handle|\.is-dragging|\.is-drag-over/);
});

test("AiInputPage と APIクライアントはマークダウン＆結合画像エクスポート（2ファイル保存・フォルダを開く）に対応し、PDF機能は撤廃されている", () => {
  const clientPath = path.join(currentDirectory, "api", "client.ts");
  const clientSource = readFileSync(clientPath, "utf-8");
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");

  // 1. client.ts に saveAiBundleToFile と openExportFolder が定義されていること
  assert.match(clientSource, /export async function saveAiBundleToFile/);
  assert.match(clientSource, /export async function openExportFolder/);

  // 2. client.ts から downloadAiPdf と saveAiPdfToFile が完全に削除されていること
  assert.doesNotMatch(clientSource, /export async function downloadAiPdf/);
  assert.doesNotMatch(clientSource, /export async function saveAiPdfToFile/);

  // 3. AiInputPage に「2ファイルを保存」ボタンと「フォルダを開く」ボタンが存在すること
  assert.match(aiInputSource, /2ファイルを保存|handleSaveBundle/);
  assert.match(aiInputSource, /フォルダを開く|handleOpenFolder/);

  // 4. AiInputPage から PDF 関連の UI ボタンや関数が撤廃されていること
  assert.doesNotMatch(aiInputSource, /handleSavePdfAndCopyPath/);
  assert.doesNotMatch(aiInputSource, /handleDownloadPdf/);
});

test("AiInputPage と APIクライアントはトークン最適化（メールCC & DataviewJS除外）オプションに対応する", () => {
  const clientPath = path.join(currentDirectory, "api", "client.ts");
  const clientSource = readFileSync(clientPath, "utf-8");
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");

  // 1. client.ts に optimize_tokens パラメータが定義されていること
  assert.match(clientSource, /optimize_tokens\??:\s*boolean/);

  // 2. AiInputPage に optimizeTokens ステート（初期値 true）が定義されていること
  assert.match(aiInputSource, /const\s*\[optimizeTokens,\s*setOptimizeTokens\]\s*=\s*useState\(true\)/);

  // 3. AiInputPage に「トークン最適化」または「メールのCC」等のチェックボックスUIが存在すること
  assert.match(aiInputSource, /トークン最適化|メールのCC.*Dataview/);

  // 4. AiInputPage から optimize_tokens が API へ連携されていること
  assert.match(aiInputSource, /optimize_tokens:\s*optimizeTokens/);
});

test("AiInputPage はマークダウン元データ（生ファイル）をデフォルトで含めず（初期値 false）、トークン重複を抑止する", () => {
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");

  // includeRawMarkdown の初期値が false（非出力）であること
  assert.match(aiInputSource, /const\s*\[includeRawMarkdown,\s*setIncludeRawMarkdown\]\s*=\s*useState\(false\)/);
});

test("AiInputPage は copyTextToClipboard を利用し、PDFおよびHTML保存時にクリップボード権限エラーが発生しても保存成功状態を維持する", () => {
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");

  // 1. copyTextToClipboard がインポートされていること
  assert.match(aiInputSource, /import\s*\{\s*copyTextToClipboard\s*\}\s*from\s*["']\.\.\/clipboard["']/);

  // 2. handleSavePdfAndCopyPath で copyTextToClipboard を呼び出していること
  assert.match(aiInputSource, /copyTextToClipboard\(res\.saved_path\)/);

  // 3. クリップボード失敗時でも「PDF保存に失敗しました」とならないハンドリングが存在すること
  assert.match(aiInputSource, /setSavedPathFeedback.*(?:PDF保存完了|パス手動コピー)/);
});

test("AiInputPage のステップ1見出し横に保存先フォルダ設定ボタンとExplorerで開くボタンが備わり、設定がサーバーに永続化される", () => {
  const clientPath = path.join(currentDirectory, "api", "client.ts");
  const clientSource = readFileSync(clientPath, "utf-8");
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");

  // 1. client.ts に getAiExportConfig と saveAiExportConfig が定義されていること
  assert.match(clientSource, /export\s+async\s+function\s+getAiExportConfig/);
  assert.match(clientSource, /export\s+async\s+function\s+saveAiExportConfig/);

  // 2. AiInputPage のステップ1見出し横に保存先設定ボタンとExplorerで開くボタンが存在すること
  assert.match(aiInputSource, /ステップ 1: 質問・キーワードで関連候補ノートを抽出/);
  assert.match(aiInputSource, /保存先(?:設定|フォルダ)/);
  assert.match(aiInputSource, /Explorerで開く|フォルダを開く/);

  // 3. AiInputPage で初期ロード時に getAiExportConfig を呼び出し、設定保存時に saveAiExportConfig を呼び出していること
  assert.match(aiInputSource, /getAiExportConfig\(\)/);
  assert.match(aiInputSource, /saveAiExportConfig\(/);
});

test("AiInputPage の全解除ボタン横にデフォルト選択数インプットが備わり、初期値10で上位から自動選択され、設定がサーバーに永続化される", () => {
  const clientPath = path.join(currentDirectory, "api", "client.ts");
  const clientSource = readFileSync(clientPath, "utf-8");
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");

  // 1. client.ts の getAiExportConfig / saveAiExportConfig が default_select_count に対応していること
  assert.match(clientSource, /default_select_count/);

  // 2. AiInputPage の全解除ボタンの横にデフォルト選択数の入力インプットが存在すること
  assert.match(aiInputSource, /全解除/);
  assert.match(aiInputSource, /default-select-count-input|type=["']number["']/);
  assert.match(aiInputSource, /自動選択|デフォルト選択|上位選択|上位/);

  // 3. デフォルト選択数の初期値が 10 であること、または state 定義
  assert.match(aiInputSource, /defaultSelectCount|autoSelectCount/);
  assert.match(aiInputSource, /useState(?:<number>)?\(\s*10\s*\)/);

  // 4. 検索結果の上位から自動で選択するロジックが存在すること
  assert.match(aiInputSource, /slice\(\s*0\s*,\s*(?:defaultSelectCount|autoSelectCount|targetCount|newCount)\s*\)/);

  // 5. インプット値変更時や初期ロード時に saveAiExportConfig を通じてサーバーに永続化されること
  assert.match(aiInputSource, /default_select_count/);
});

test("AiInputPage から冗長な『ステップ 3: AIへの指示 & エクスポート設定』パネルが削除され、候補選択から直接生成・プレビュー・保存ができる", () => {
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");

  // ステップ 3: AIへの指示 & エクスポート設定 が削除されていること
  assert.doesNotMatch(aiInputSource, /ステップ 3: AIへの指示（共通プロンプト） & エクスポート設定/);
  assert.doesNotMatch(aiInputSource, /プロンプトテンプレート/);
  assert.doesNotMatch(aiInputSource, /AIへの指示文（自由にカスタマイズ可能）/);

  // ステップ 1 と ステップ 2 は存在すること
  assert.match(aiInputSource, /ステップ 1: 質問・キーワードで関連候補ノートを抽出/);
  assert.match(aiInputSource, /ステップ 2: AIにインプットするノートを選択/);
});

test("AiInputPage の HTMLプレビューから不要なAI指示・質問セクション（🎯 AIへの指示・質問）が排除され、promptが空で生成される", () => {
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");

  // 1. generateAiHtml 呼び出し時に fullPrompt や promptText を送らず、prompt: "" となっていること
  assert.doesNotMatch(aiInputSource, /【ユーザーの質問 \/ テーマ】/);
  assert.doesNotMatch(aiInputSource, /prompt:\s*fullPrompt/);
  assert.match(aiInputSource, /prompt:\s*["']["']/);
});

test("AiInputPage のモーダルに『obsidianのtopタグのみを出す』チェックボックスが備わり、topタグを持つノートのみの絞り込み表示とHTML再生成に対応する", () => {
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");

  // 1. モーダル内に「obsidianのtopタグのみを出す」チェックボックスが存在すること
  assert.match(aiInputSource, /obsidianのtopタグのみを出す/);
  assert.match(aiInputSource, /onlyTopTag/);

  // 2. has_obsidian_top_tag によるフィルタリング処理が存在すること
  assert.match(aiInputSource, /has_obsidian_top_tag/);

  // 3. 各アイテムに TOP バッジが表示されること
  assert.match(aiInputSource, /🏷️\s*TOP|TOP/);
});

test("AiInputPage のモーダル内で各Markdownファイルごとにリンク展開階層数を設定でき、デフォルトはtopタグあり5・他1であり、HTML生成および2ファイル保存に連携される", () => {
  const clientPath = path.join(currentDirectory, "api", "client.ts");
  const clientSource = readFileSync(clientPath, "utf-8");
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");

  // 1. client.ts の generateAiHtml および saveAiBundleToFile が file_depths に対応していること
  assert.match(clientSource, /generateAiHtml[\s\S]*?file_depths\?:/);
  assert.match(clientSource, /saveAiBundleToFile[\s\S]*?file_depths\?:/);

  // 2. AiInputPage のモーダル内各ノート行に階層数入力欄が存在すること
  assert.match(aiInputSource, /link-depth-input|file-depth-input|階層/);

  // 3. topタグが含まれている場合は 5、それ以外は 1 とするデフォルト階層数ロジックが存在すること
  assert.match(aiInputSource, /has_obsidian_top_tag.*?\?.*?5.*?:\s*1|5\s*:\s*1/);

  // 4. fileDepths の状態管理と、generateAiHtml / saveAiBundleToFile 呼び出し時に渡していること
  assert.match(aiInputSource, /fileDepths|file_depths/);
  assert.match(aiInputSource, /file_depths:\s*(?:fileDepths|currentDepths|activeDepths)/);
});

test("AiInputPage のモーダル内で階層展開されたリンク先ノート群（expanded_nodes）がファイル選択リストにツリープレビュー表示され、階層の指示とリアルタイム連動すること", () => {
  const typesPath = path.join(currentDirectory, "types.ts");
  const typesSource = readFileSync(typesPath, "utf-8");
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");

  // 1. types.ts に ExpandedNode 型と AiHtmlExportResponse の expanded_nodes が定義されていること
  assert.match(typesSource, /ExpandedNode/);
  assert.match(typesSource, /expanded_nodes\?:/);

  // 2. AiInputPage に expandedNodes の状態管理があり、APIレスポンスからセットされていること
  assert.match(aiInputSource, /expandedNodes/);
  assert.match(aiInputSource, /setExpandedNodes/);

  // 3. モーダル右ペインの各親ノートの下に展開された子ノード群がインデントツリー表示されること
  assert.match(aiInputSource, /ai-child-nodes-container|ai-child-node-item/);
  assert.match(aiInputSource, /↳/);
  assert.match(aiInputSource, /階層/);
});

test("AiInputPage のモーダル内で各子ノードに除外用チェックボックスがあり、カードクリックで8001ハブにリダイレクトして開けること", () => {
  const clientPath = path.join(currentDirectory, "api", "client.ts");
  const clientSource = readFileSync(clientPath, "utf-8");
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");

  // 1. client.ts が excluded_file_paths に対応していること
  assert.match(clientSource, /generateAiHtml[\s\S]*?excluded_file_paths\?:/);
  assert.match(clientSource, /saveAiBundleToFile[\s\S]*?excluded_file_paths\?:/);

  // 2. AiInputPage の子ノードアイテムにチェックボックスと除外ハンドラが存在すること
  assert.match(aiInputSource, /ai-child-node-item[\s\S]*?type="checkbox"/);
  assert.match(aiInputSource, /excludedChildPaths|handleToggleChildNode/);

  // 3. 親カードおよび子ノードカードのクリックで 8001 ハブを開く（openFileViaHub）処理が紐づいていること
  assert.match(aiInputSource, /openFileViaHub\(fullPath\)|openFileViaHub\(item\.full_path\)/);
  assert.match(aiInputSource, /openFileViaHub\(child\.full_path\)/);
});
test("AiInputPage のモーダル内でリンク展開ノート群がspoon_feeder2風の折りたたみ・展開可能なツリー表示（TreeNode/開閉トグル/すべて展開・折りたたみ）に対応すること", () => {
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");

  // 1. 開閉状態（collapsedRootPaths や collapsedNodes）を管理する state が存在すること
  assert.match(aiInputSource, /collapsedRootPaths|collapsedNodes|isTreeCollapsed/);

  // 2. 親ノートおよび子ノードに開閉トグルボタン（ai-tree-toggle-btn または tree-toggle）が存在すること
  assert.match(aiInputSource, /ai-tree-toggle-btn|tree-toggle/);
  assert.match(aiInputSource, /▼|▶|Chevron/);

  // 3. 一括操作用の「すべて展開」「すべて折りたたむ」ボタンが存在すること
  assert.match(aiInputSource, /すべて展開|全展開/);
  assert.match(aiInputSource, /すべて折りたたむ|全折りたたみ/);

  // 4. トグルボタン操作時に stopPropagation が呼ばれ、8001ハブクリックの誤発火を防いでいること
  assert.match(aiInputSource, /e\.stopPropagation\(\)[\s\S]*?toggle/i);
});

test("AiInputPage のステップ 2 候補ノート選択テーブルが画面縦幅（ビューポート）いっぱいに広がり、下部の余白が解消されていること", () => {
  const aiInputPath = path.join(currentDirectory, "components", "AiInputPage.tsx");
  const aiInputSource = readFileSync(aiInputPath, "utf-8");
  const appCssPath = path.join(currentDirectory, "styles", "app.css");
  const appCssSource = readFileSync(appCssPath, "utf-8");

  // 1. 固定の小さな 380px 制限（maxHeight: "380px"）が撤廃されていること
  assert.doesNotMatch(aiInputSource, /maxHeight:\s*["']380px["']/);

  // 2. ビューポートに連動した画面縦幅いっぱいの高さ（calc(100vh - ...)）がテーブルコンテナに適用されていること
  assert.match(aiInputSource, /100vh/);
  assert.match(aiInputSource, /ai-candidate-table-container|ai-results-table-container/);

  // 3. CSS またはスタイルに画面いっぱい用のクラスまたはスタイル定義が存在すること
  assert.match(aiInputSource + appCssSource, /ai-candidate-table-container|ai-results-table-container/);
});



