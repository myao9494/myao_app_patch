# アーキテクチャ（モジュール構成と責務）

バックエンドのモジュールがそれぞれ何を担当し、検索とインデックスのデータがどう流れるかをまとめる。
機能ごとの詳細仕様は各 `docs/*_spec.md` を参照。

## 全体像

```
ブラウザ (React) ─┐
ランチャー ───────┼─ HTTP ─▶ FastAPI (backend/app)
外部アプリ ───────┘              │
                                 ├─ 全文検索DB   backend/data/search.db            (SQLite + FTS5)
                                 ├─ ベクトルDB   backend/data/vector_index_<モデル名>.db (SQLite, モデルごと)
                                 └─ 設定ファイル backend/data/*.txt, config.json    (1 設定 1 ファイル)
```

- フロントエンドは `frontend/dist/` のビルド済み成果物を FastAPI が配信する。
- 全文検索DBとベクトルDBは別ファイルで、**ID 体系も別**（`files.id` と `documents.id`）。両者をつなぐキーはファイルパス。

## `backend/app` のモジュール

### `api/` — HTTP エンドポイント

リクエストの受け取りとレスポンス整形だけを行い、処理は `services/` と `vector/` に委譲する。
DB 接続は `api/deps.py` がリクエストごとに開閉する。

| ファイル | 役割 |
|---|---|
| `search.py` | 検索（`GET/POST /api/search`、`POST /api/search/indexed`）、クリック記録、gantt 入力画面オープン |
| `index.py` | インデックス状態・設定・検索対象フォルダ・スケジューラー・Everything 互換検索 |
| `vector.py` | モデルのロード / 状態、ベクトルインデックスの開始 / 中止 / 進捗 / 統計、削除候補の事前確認、ベンチマーク |
| `export.py` | AIインプット（HTML、マークダウン + 結合画像）の生成・保存、保存先設定 |
| `files.py` | ファイルの物理削除（`expected_path` による取り違え防止つき）、位置を Finder / Explorer で開く |
| `folders.py` / `launcher.py` | フォルダ選択ダイアログ、ランチャープロセスの制御 |

### `services/` — 全文インデックス・検索・設定

入口になるクラスは `IndexService`（インデックス）と `SearchService`（キーワード検索）の 2 つ。
どちらも「いつ・どの条件で処理するか」を決めるだけで、実際の処理は下の部品へ任せる。
部品どうしは公開された関数・メソッドだけで連携し、他のモジュールの `_` で始まる名前は呼ばない。

**インデックス**

| ファイル | 役割 |
|---|---|
| `index_service.py` | インデックス更新の入口（`IndexService`）。走査の要否の判断、設定の更新、検索対象とインデックス済みデータの操作を、下の部品へ振り分ける |
| `index_run_state.py` | 実行中フラグと中止要求（`index_runs` テーブル）。同時に走査を始められるのは 1 つだけ |
| `search_target_store.py` | 検索対象の登録・有効 / 無効・走査条件の保存と、再走査が必要かの判定（`targets` テーブル） |
| `indexed_file_store.py` | インデックス済みファイルの読み書きと削除（`files` / `file_segments` / `failed_files` テーブル） |
| `local_target_indexer.py` | ローカルフォルダの変更検知、本文抽出の並列実行、DB への直列書き込み |
| `file_walker.py` | フォルダ配下の対象ファイルの走査（`os.scandir`）。全文インデックスとベクトルインデックスが共用し、対象範囲を一致させる |
| `web_target_indexer.py` | Web ページの巡回（取得方法の選択、リンクを辿る範囲と深さの管理） |
| `web_pages.py` | Web ページの取得、HTML からのタイトル・本文・リンク・パンくず抽出、URL の正規化と巡回範囲の判定（DB に依存しない処理） |
| `index_scope.py` | 走査範囲（階層・拡張子・除外）とフォルダの包含関係の判定（純粋関数） |
| `index_cleanup.py` | 検索ルールの変更で対象外になったファイルを、全文検索DBと全モデル分のベクトルDBから取り除く |
| `exclude_rules.py` | 除外キーワードの解析と除外判定（全機能で共用する唯一の実装） |
| `app_settings_store.py` | 設定ファイルの正規化・読み書き（`AppSettingsStore`）、設定変更の合成（`merge_app_settings`） |

**検索**

| ファイル | 役割 |
|---|---|
| `search_service.py` | キーワード検索の入口（`SearchService`）。検索前のインデックス更新 → 検索 → 検索後の Obsidian 同期の順に進める |
| `search_dispatcher.py` | 検索方式（keyword / vector / hybrid）の振り分け。ベクトル結果の絞り込み、`files.id` への解決、ハイブリッドのページング |
| `search_refresh.py` | 検索前のインデックス更新（既存インデックスがあれば検索は待たせず、更新をバックグラウンドへ回す） |
| `fts_search.py` | FTS5 を使う通常の全文検索（高速ページング、除外条件があるときの全件取得、フォルダ名検索） |
| `regex_search.py` | 正規表現検索 |
| `search_query.py` | 検索語の解析（AND / `OR` / `-除外語`、類似語の展開、FTS5 へ渡す語の引用符付け） |
| `search_sql.py` | 検索用 SQL の組み立て（候補の絞り込み CTE、検索語ごとの一致、並び順） |
| `search_result_items.py` | 検索結果モデルの組み立て、除外判定、並び替え、ページ切り出し |
| `search_snippets.py` | 抜粋（スニペット）の生成と強調 |
| `hybrid_search_service.py` | RRF による順位融合と、パス比較キーの生成 |
| `gantt_search.py` | gantt アプリのタスク検索（インデックスを使わず、その都度問い合わせる） |
| `obsidian_access_sync.py` | Obsidian（sidebar-explorer）の利用状況を、検索順位の補助スコアとして取り込む |
| `search_benchmark.py` | 検索速度の計測 |

**変更追跡・その他**

| ファイル | 役割 |
|---|---|
| `change_tracking_service.py` | macOS FSEvents の受信、dirty 対象のバックグラウンド差分更新 |
| `windows_change_tracking.py` | Windows の USN Change Journal / ReadDirectoryChangesW |
| `change_relevance.py` | 変更通知がどの検索対象のインデックスに影響するかの判定 |
| `scheduler_service.py` / `scheduler_worker.py` | 定時インデックス（別プロセスで実行） |
| `background_tasks.py` | 応答を待たせない後処理（検索後の再インデックス、Obsidian 同期）を実行するスレッドの管理 |
| `path_service.py` | パスの正規化（Windows UNC を含む）、子孫パスの範囲検索用の境界計算 |
| `cjk_bigram.py` | 日本語の部分一致を補う bi-gram |
| `web_browser_fetcher.py` | Edge / Chrome を使った Web ページ取得 |
| `launcher_service.py` | ランチャープロセスの起動・停止 |

### `vector/` — ベクトル検索と AIインプット

| ファイル | 役割 |
|---|---|
| `state.py` | モデル・検索器・辞書を保持するシングルトン（`vector_state`）。モデル選択の永続化と起動時復元、差分同期の入口（同時実行は 1 つ、待たされた要求の後追い実行、中止） |
| `embedder.py` | ローカルモデルでの Embedding 生成。デバイス自動選択（CUDA / MPS / CPU）と CPU フォールバック。インデックス作成の推論は小分けにして検索クエリを優先する |
| `inference_gate.py` | 推論の順番待ち。推論を 1 つずつ実行し、検索クエリをインデックス作成の推論より先に通す |
| `indexer.py` | 対象フォルダの走査（`services/file_walker`）、差分検知（mtime + サイズ → SHA-256）、チャンク化、ベクトル化、保存 |
| `db.py` | ベクトルDBのスキーマと読み書き。`open_db()`（必ず閉じる接続）、`save_document_with_chunks()`（1 トランザクション） |
| `searcher.py` | FAISS（未導入時は NumPy）による類似検索、スコア補正、核心文の抽出。インデックスは作り直し終えてから差し替える |
| `faiss_index.py` | FAISS / NumPy のインデックス実装 |
| `chunker.py` / `dictionary.py` | チャンク分割、類似語・専門用語辞書によるクエリ補強 |
| `html_exporter.py` | AIインプットの HTML 組み立て、Markdown / Dataview の変換 |
| `figure_assets.py` | ノートが参照する画像・図面（PNG / SVG / draw.io / Excalidraw）の探索と Base64 インライン化 |
| `export_timing.py` | 書き出しの段階別所要時間の計測とレポート出力（`export_timing.log`） |
| `output_limits.py` | 社内AIの上限（テキスト 20 万文字・ファイル 4.5MB）。テキストの分割と注記、HTML の文字数（埋め込み画像を除く）、保存ファイルの読み直し確認 |
| `html_size_fitting.py` | AI用HTMLを上限に収める（節の境目での分割と、埋め込み画像の縮小・JPEG 化） |
| `export_guard.py` | 書き出しの項目（ノート・リンク先・画像・図面・メール）ごとの時間制限（既定 10 秒）と、見つからない・時間切れ・エラーで飛ばした項目の記録（`skipped_links`） |
| `file_name_index.py` | 画像・リンク先ノート・メールの同名ファイル探索。書き出し 1 回の間は根フォルダごとの走査結果（ファイル名索引）を共有し、同じフォルダを繰り返し走査しない |
| `image_data_url.py` | 画像ファイル・SVG テキストの Data URL 化（SVG はライトテーマ向けに補正） |
| `excalidraw_drawing.py` / `excalidraw_cache.py` | Excalidraw の図面データの取り出しと SVG 描画、書き出し済みキャッシュ画像の探索 |
| `email_links.py` | ノートからリンクされているメールファイル（MSG / EML）の抽出 |
| `email_parsing.py` | メールの解析（CP932 ベストエフォートデコード、本文・添付画像の取り出し） |
| `email_html.py` | メール本文のサニタイズと HTML 化 |
| `email_recipients.py` | メール本文から宛先（To・CC・BCC）の行を除く（HTML 書き出しと Markdown 書き出しで共用） |
| `ai_export_css.py` | AIインプット用 HTML のスタイルシート |
| `markdown_image_exporter.py` / `link_expander.py` | マークダウン + 結合画像の生成、ノート間リンクの再帰展開 |
| `model_bundler.py` | 分割配布されたモデルファイルの結合 |

### その他

| ファイル | 役割 |
|---|---|
| `main.py` | アプリ生成、起動時処理（スキーマ初期化、中断されたインデックス状態の回復、変更追跡・スケジューラー・ランチャーの開始、保存済みモデルの復元）、ログ設定 |
| `runtime_env.py` | OpenMP / BLAS / Tokenizers のスレッド設定。`app` パッケージの import 時に適用される |
| `config.py` | 待受ホスト・ポート、データ保存先、設定ファイル名（環境変数 `SEARCH_APP_*`） |
| `db/connection.py` / `db/schema.py` | 全文検索DBの接続生成、スキーマ定義とマイグレーション（足りない列の追加、移行できない DB の退避）、削除で空いたページの回収 |
| `db/maintenance.py` | DB の空き領域回収（FTS5 索引の統合 + VACUUM）。`backend/compact_db.py` から実行する |
| `extractors/` | ファイル種別ごとのテキスト抽出、Obsidian フロントマターの解析 |

## `frontend/src` のモジュール

画面の状態と操作は `hooks/` のカスタムフックが持ち、表示は `pages/` と `components/` のコンポーネントが行う。
コンポーネントは、フックの戻り値を props として受け取って表示するだけにする（自分では API を呼ばない）。
フックどうしは、相手の状態を直接書き換えない。相手が公開する操作（`rules.addExcludeKeyword`、`search.clearResults`、
`targets.addSearchTarget` など）を、`App.tsx` で引数として渡してつなぐ。

```
App.tsx                 フックを 1 度だけ呼び、フックどうしをつないで各画面へ渡す（画面共通の状態: 表示中のページ・メッセージ・設定ドロワーの開閉）
├─ hooks/               画面ごとの状態と操作
├─ pages/               ページ単位の表示
└─ components/          ページをまたいで使う部品と、大きな画面の構成部品
```

**フック（`hooks/`）**

| ファイル | 役割 |
|---|---|
| `useSearch.ts` | 検索条件と検索結果、ページの追加読み込み、インデックス更新後の自動再検索、起動 URL による自動検索 |
| `useRuleManagement.ts` | 検索ルール管理（除外キーワード・類似語・インデックス対象拡張子）の編集、自動保存、元に戻す / やり直し |
| `useIndexedTargets.ts` | インデックス済みフォルダ・検索対象フォルダ一覧の絞り込み、選択、削除、再インデックス、有効 / 無効の切り替え |
| `useSearchTargetCoverage.ts` | 検索欄のフォルダが有効な検索対象に含まれるかの判定と、検索対象への追加（階層の欄が空なら無制限として登録） |
| `useGeneralSettings.ts` | 設定ドロワーの共有設定（Web 用の除外キーワード、Web の取得方法、Obsidian 連携先、gantt の親タスク、削除時の確認） |
| `useIndexStatus.ts` / `useFailedFiles.ts` | インデックスの実行状態と中止、失敗したファイル一覧 |
| `useScheduler.ts` / `useLauncher.ts` | スケジューラー、デスクトップランチャーの状態と操作 |
| `useVectorManagement.ts` | ベクトル管理（モデルの読み込み、インデックスの更新・中止と進捗、ベンチマーク） |
| `useAiCandidates.ts` / `useAiDocumentBuilder.ts` / `useAiExportFolder.ts` / `useAiExportOptions.ts` | AIインプット（候補の抽出と選択、HTML の生成とプレビューでの調整、保存先、出力オプション） |

**表示（`pages/`・`components/`）**

| ファイル | 役割 |
|---|---|
| `pages/SearchResultsPage.tsx` | 検索結果 |
| `pages/IndexedTargetsPage.tsx` | インデックス済みフォルダ / 検索対象フォルダ / インデックス済み Web ページ（3 画面で共用） |
| `pages/RuleManagementPage.tsx` / `SchedulerPage.tsx` / `LauncherPage.tsx` | 検索ルール管理、スケジューラー、ランチャー管理 |
| `components/TopNav.tsx` / `SettingsDrawer.tsx` | 上部のページ切り替えと検索欄、設定ドロワー |
| `components/SearchBar.tsx` / `ResultsList.tsx` | 検索欄、検索結果の一覧 |
| `components/VectorManagementPage.tsx` + `components/vectorManagement/` | ベクトル管理画面と、その構成部品（稼働状況、モデル選択、インデックス管理、ベンチマーク） |
| `components/AiInputPage.tsx` + `components/aiInput/` | AIインプット画面と、その構成部品（候補の抽出、候補の選択、生成結果、全画面プレビュー、保存先の設定、リンク先ノートのツリー） |

**画面に依存しない処理（`src/` 直下）**

| ファイル | 役割 |
|---|---|
| `api/client.ts` | バックエンド API の呼び出し。検索パラメータの型は `SearchRequestParams` に一本化している |
| `types.ts` / `appTypes.ts` / `appDefaults.ts` | API の型、画面で共有する型、設定を読み込む前の既定値 |
| `searchResultSort.ts` | 検索結果の並び替え（既定順はハイブリッド融合スコア優先） |
| `indexedTargetFilter.ts` | インデックス済みフォルダ・検索対象フォルダ一覧の絞り込みと並び順 |
| `settingsNormalization.ts` / `indexExtensions.ts` | 除外キーワード・類似語・gantt parent の正規化、インデックス対象拡張子の定義と正規化 |
| `dateInput.ts` | 日付・日時入力欄の値変換（ローカル時刻基準） |
| `searchTargetCoverage.ts` | 検索対象フォルダの包含判定 |
| `extensionFilter.ts` / `filterUtils.ts` / `aiInputCandidate.ts` | 拡張子フィルタ、除外キーワードによる絞り込み、AIインプット候補の判定と根拠文の整形 |
| `fileIcon.ts` / `clipboard.ts` / `launchParams.ts` | アイコン解決、クリップボードの安全コピー、起動 URL パラメータ |
| `openHub.ts` | 外部のファイルハブ（8001 番）でファイル・フォルダを開く URL の組み立て。検索結果一覧と AIインプットが共用する |
| `vectorBenchmarkPresets.ts` | ベクトル管理画面のベンチマークで使う、検証用の本文のプリセット |
| `testing/` | テスト用の補助（サーバー描画、DOM への描画と操作、API 応答のひな形）。アプリ本体からは import しない |

## 検索の流れ

```
api/search.py
  └─ search_dispatcher.dispatch_search(params, service)
       ├─ keyword: SearchService.search / search_existing_index
       │             ├─ search_refresh  検索前のインデックス更新（必要なときだけ）
       │             ├─ fts_search / regex_search  ← search_query（検索語の解析）+ search_sql（SQL の組み立て）
       │             └─ obsidian_access_sync  検索後、バックグラウンドで利用状況を取り込む
       ├─ vector : VectorSearcher.search → VectorCandidateFilter で絞り込み → files.id へ解決
       └─ hybrid : キーワード結果（先頭から offset + limit 件）と ベクトル結果を取得
                   → 先頭 1 ページ分のキーワード結果とベクトル結果を RRF 融合
                   → 残りのキーワード結果を元の順位のまま後ろへ連結
                   → 全体順位から offset / limit で切り出し
```

- 各結果には一致理由として `match_type`（`both` / `vector_only` / `keyword_only`）と、そこから導出した `match_source`（`both` / `vector` / `keyword`）を付ける。Web UI と全ランチャーは `match_source` でバッジを表示する。
- `SearchService.search` は、条件に応じて検索前に差分インデックスを行う（`skip_refresh` 指定時と `search/indexed` では行わない）。
- ベクトル結果は、キーワード検索と同じ条件（除外キーワード、拡張子フィルタ、`-語`、有効な検索対象フォルダ配下、ファイルの実在）で絞り込む。
- 検索のあと、Obsidian 連携先が設定されていれば利用状況の同期をバックグラウンドで行う。
  `data.json` と Vault 配下のインデックスが前回から変わっていなければ DB への書き込みは省略する。

## インデックスの流れ

```
契機: 画面からの再インデックス / 検索前の差分更新 / 変更通知 (dirty) / スケジューラー
  └─ IndexService.ensure_fresh_target
       ├─ search_target_store  検索対象の登録、再走査が必要かの判定
       ├─ index_run_state      実行中フラグの取得（取れなければ 409）
       ├─ local_target_indexer 走査 (os.scandir) → 変更なしはスキップ → 本文抽出 (スレッド並列) → SQLite へ直列書き込み
       │   または web_target_indexer（Web の検索対象）
       ├─ indexed_file_store   見つからなくなったファイル・解消した失敗の後始末
       ├─ index_run_state      実行中フラグを下ろす
       └─ ベクトル同期が有効なら vector_state.sync_index（同じフォルダ・除外キーワード・階層数。差分のみで、削除はしない）
```

- 走査を開始できるのは同時に 1 つだけ。実行中フラグ（`index_runs.is_running`）は「未実行のときだけ立てる」1 つの UPDATE で取得する。
- 抽出に失敗し、その後も更新されていないファイルは、1 時間が過ぎるまで再抽出しない（画面からの再インデックスでは常に再試行する）。
- 変更通知は `change_relevance` で絞り込む。除外キーワードに該当するパス（`.git/` 配下など）だけの変更では dirty にしない。
- ベクトルインデックスは `indexer.VectorIndexManager` が作成する。走査は全文インデックスと同じ `file_walker` を使うので、対象範囲（除外・階層数・拡張子）が一致する。
  削除を伴う同期は、画面からの差分更新で利用者が許可した場合と、全件再作成が最後まで終わった場合に限る。
- ベクトル同期は実行中フラグを下ろしたあとに行う。Embedding の生成中も、他のフォルダの走査は開始できる。
  ベクトル同期を行うのは、変更通知によるバックグラウンドの差分更新だけ（画面からの再インデックスと検索前の更新では行わない）。

## 設定の持ち方

- 利用者が変更する設定は `backend/data/` 配下のテキストファイル（1 設定 1 ファイル）で、`AppSettingsStore` が読み書きする。
- ベクトルモデルの選択は `backend/data/config.json`（`VectorState` が管理）。
- これらは端末ごとに異なるため Git 管理外。未作成なら既定値で自動生成される。

## 既知の課題

2026-10 のリファクタリングで、それまで挙げていた課題（スキーマ不一致時の自動リセット、ベクトルインデックスの中止不可・範囲の不一致、
ハイブリッド検索の件数、記号だけの除外キーワード、フックどうしの依存、ソースの文字列を調べるテストなど）は解消した。
現時点で残しているものは次のとおり。

### 動作に関わるもの

- **API に認証は無い**（設計上の前提）。`start_dev.sh` / `start_windows.bat` の既定の待受は `127.0.0.1`（自端末のみ）。
  `0.0.0.0` を明示して起動すると、同じネットワーク上の端末から検索・ファイル削除・インデックス初期化が可能になる。
- **検索結果の絞り込みに使う除外判定が、インデックス走査の判定より広い**。インデックス走査（`exclude_rules`）は名前キーワードを
  語の区切りで判定するが、ベクトル検索結果の絞り込み（`path_service.matches_exclude_keyword`）と AIインプットの候補
  （`frontend/src/filterUtils.ts`）は、5 文字以上のキーワードをファイル名の部分一致でも除外する。
  そのため `gantt_diff_summary` のようなキーワードは、`2026_gantt_diff_summary_v1.md` をインデックスには入れるが、
  ベクトル検索結果と AIインプットの候補からは外す。どちらへ寄せるかは、インデックスに入る範囲が変わるため未決定。
- **ハイブリッド検索の一致バッジ**は、先頭 1 ページ分のキーワード結果とだけ突き合わせて決める。キーワードでも一致するが
  順位が 2 ページ目以降のファイルがベクトル結果として先頭に出たときは「意味一致」と表示される（件数 `total` は重複なしで数える）。
- **ベクトルインデックスの削除候補**は、対象フォルダの指定に関係なくベクトルDB全体から求める。対象フォルダを一部だけ指定して
  削除を許可すると、指定外のフォルダの文書も削除候補になる（画面からの差分更新は常に全有効フォルダを指定する）。
- **DB の空き領域**は、インデックス済みフォルダの削除とインデックスの初期化のあとに自動で返す（新規に作った全文検索DBのみ）。
  FTS5 索引に残る削除済みデータの統合、以前の版で作った DB、ベクトルDBは、停止中に `python compact_db.py` を実行して回収する。

### 構造に関わるもの

- **`except Exception` が約 60 か所ある**。バックグラウンド処理の入口、1 ファイルの失敗で全体を止めないための囲み、
  外部ライブラリ（extract_msg・pypdf・python-pptx・Playwright・torch など、投げる例外を特定できないもの）の呼び出しで、
  いずれもログへ出すか、理由をコメントに書いている。新しく書くときは、原因を限定できる処理（ファイルの読み書き、JSON、パスの解決）では
  例外の種類を絞る。
- **フロントエンドのテストはレイアウトを検証できない**。jsdom は要素の位置や大きさを計算しないため、確かめられるのは
  表示内容・操作のあとの動き・適用されるスタイルの値まで。はみ出しや重なりなどの見た目は、ブラウザーで確認する。
- **Windows WPF ランチャー**（`launcher/windows/`）は、.NET SDK のある環境でしかビルド・テストできない。
  API の項目を変えるときは、Windows 環境での確認が別途必要になる。
