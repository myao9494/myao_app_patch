# OR検索（OR / or）機能仕様書

## 概要
検索キーワードを `OR` または `or` で繋いだ場合に、指定したいずれかのキーワードを含むドキュメントを抽出する OR 検索機能を提供する。API および Web UI、ランチャーからの検索で共通して利用可能。

## 仕様
1. **演算子**:
   - `OR` および `or`（大文字・小文字不問）を OR 演算子として扱う。
   - 例: `apple OR banana`, `apple or banana` -> `apple` または `banana` を含むファイルがヒット。
2. **AND / OR の複合結合 (AND of ORs)**:
   - `OR` で接続された連続するキーワード群をひとつの「ORグループ（いずれか1つに一致）」とする。
   - 空白で区切られた ORグループ同士は「AND（すべてに一致）」として扱う。
   - 例: `report 2025 OR 2026` -> `report` AND (`2025` OR `2026`)
   - 例: `apple OR banana orange OR grape` -> (`apple` OR `banana`) AND (`orange` OR `grape`)
3. **除外語 (`-keyword`) との組み合わせ**:
   - `-keyword` は除外対象として抽出され、ORグループの条件を満たしつつ除外語を含まないファイルを返す。
   - 例: `alpha OR beta -archived` -> `alpha` または `beta` を含み、`archived` を含まないファイル。
4. **エスケープおよびフォールバック**:
   - `\OR` や `\or` は演算子ではなく通常の検索単語 `"OR"`, `"or"` として扱う。
   - `q="OR"` のように OR のみ入力された場合は、通常単語 `"OR"` として安全に検索する。
5. **他検索ターゲットとの連携**:
   - **同義語展開**: OR グループ内の各単語について同義語を展開し、グループ内の OR 候補に追加。
   - **フォルダ検索**: SQL WHERE 句でグループごとに `(lower(folder) LIKE ? OR ...)` を生成。
   - **gantt タスク検索**: タスク本文に対して全 OR グループのいずれかに一致するか判定。
   - **Web ページ検索**: ローカルファイルと同様に FTS5 / DB クエリエンジンで OR 検索可能。
   - **ハイライト**: スニペット生成時に全 OR キーワードをハイライト対象とする。

## 変更対象ファイル
- `backend/app/services/search_service.py`
- `backend/tests/test_search_service.py`
- `backend/tests/test_search_api.py`
- `AGENTS.md`
- `docs/or_search_spec.md`

---

# MSG / メールファイルアイコン仕様書

## 概要
`.msg`（Outlook メッセージファイル）および `.eml` の検索結果に対し、視認性の高い専用の Catppuccin スタイル封筒（メール）アイコン（`email.svg` / `email.png`）を表示する。

## 仕様
1. **デザイン & スタイル**:
   - Catppuccin スタイル準拠の線画封筒アイコン（16x16 viewBox、1px線幅、角丸）。
   - カラー: Outlook やメールを象徴する Catppuccin Blue（`#1E66F5`）。
   - 封筒の外枠角丸長方形と上部フラップの折れ線で構成。
2. **対象拡張子**:
   - `.msg`（Outlookメッセージ）
   - `.eml`（RFC 822 / MIMEメール）
3. **反映範囲**:
   - Web クライアント（React / Vite）: `frontend/src/fileIcon.ts`
   - デスクトップランチャー（macOS PyObjC / Python Flet）: `launcher/src/launcher_app/file_icons.py`
   - Windows WPF ランチャー（C#）: `launcher/windows/LocalSearchLauncher/SearchModels.cs`
4. **同梱アセット**:
   - SVG: `frontend/public/icons/catppuccin/email.svg`, `frontend/dist/icons/catppuccin/email.svg`, `launcher/src/launcher_app/assets/catppuccin/email.svg`
   - PNG (32x32): `launcher/windows/LocalSearchLauncher/Assets/catppuccin/email.png`, `launcher/windows/publish/folder/Assets/catppuccin/email.png`, `launcher/windows/publish/single-file/Assets/catppuccin/email.png`

---

# ベクトル検索・ハイブリッド検索・AIインプット仕様書

## 概要
`PoC_lag` の成果を統合し、埋め込みベクトルに基づくセマンティック検索と従来の FTS5 全文キーワード検索を融合した「ハイブリッド検索（既定）」、ランチャー（macOS Cocoa / Python Flet / Windows WPF）を含む検索方式切替、独立した高機能設定・監視画面「ベクトル管理」、および画像や図面（Excalidraw/draw.io）を自己完結インライン化してエクスポートする「AIインプット」画面を提供する。

## 仕様
1. **検索方式の3択と既定値**:
   - 検索方式は `hybrid`（ハイブリッド [既定]）、`vector`（ベクトル検索）、`keyword`（通常キーワード検索）の3つから選択可能。
   - Web UI および全ランチャー（macOS Cocoa / Python Flet / Windows WPF）のデフォルトは必ず `hybrid` とする。
2. **全デスクトップランチャーでの検索方式切替 & 表示**:
   - **macOS Cocoa 版**: 上部バーに `NSSegmentedControl`（🔀 ハイブリッド / 🔮 ベクトル / 🏷️ 通常）を配置。結果カードに一致バッジ（🌟両方一致 / 🔮意味一致 / 🏷️通常一致）と核心文（`salient_sentence`）を表示。
   - **Python Flet 版**: 検索バー横にドロップダウンを配置。一致バッジと核心文を表示。
   - **Windows WPF 版**: 検索窓右側に `SearchTypeCombo` を配置。一致バッジと核心文を表示。
3. **検索対象ファイル & フォルダ**:
   - Markdown（`.md`）に限定せず、登録済みの全フォルダおよび選択された全拡張子（PDF, Word, Excel, TXT, JSON, MSG 等）を走査。
   - 本文抽出可能ファイルは意味単位でスライディングチャンキング。
   - 画像・音声等の本文なし拡張子は「ファイル名」をベクトル化し、意味検索でもヒット可能にする。
4. **ハイブリッド融合アルゴリズム**:
   - RRF (Reciprocal Rank Fusion, $k=60$) により、キーワード順位とベクトル類似度順位を公平に合成。
   - 各結果に `match_source`（`both` [両方一致], `vector` [意味一致], `keyword` [キーワード一致]）、核心文（`salient_sentence`）、融合スコア・意味類似度を付与。
5. **差分インデックス同期**:
   - 全文インデックスの作成・更新完了時（`index_service`）に、連動して自動でベクトルインデックスの差分更新（`vector_state.sync_index`）を実行。
   - ファイルの更新日時（mtime）および SHA256 ハッシュによるスキップ判定で高速同期。
6. **ベクトル管理画面（PoC 同等以上の高機能版）**:
   - **モデル別バッジ**: 軽量/標準/高精度モデルごとのインデックス登録件数、DBサイズ（MB）、未インデックス状態をバッジ表示。
   - **差分更新 ⚡ vs 全件再作成 🔄**: 変更ファイルのみ高速同期する差分更新ボタンと全件再作成ボタンを明示的に分離。
   - **進捗バー & 完了サマリー**: リアルタイム進捗率表示、完了時の追加・更新・スキップ・削除件数、所要時間、DBサイズサマリー。
   - **類似語・専門用語の一元連携**: 辞書エディタを個別に持たず、「検索ルール管理」の「類似語・専門用語リスト」と完全統合。
   - **単一ファイルベンチマーク**: 意地悪テストプリセット4種（長文、空、特殊文字、見出し多用）によるチャンキング・推論・DB保存のミリ秒測定。
7. **AIインプット画面（PoC 同等以上の高機能版）**:
   - **ドラッグ範囲選択**: マウスドラッグによる連続選択、Shift+ドラッグによる選択解除。
   - **プロンプトプリセット5種**: 統合サマリー、課題・ToDo、Q&A、設計・実装計画、差分・変更点。
   - **デュアルタブ切替**: プレビュー（iframe表示）と HTML ソースのタブ切替。
   - **タイトル自動生成 & トークン概算**: 選択ドキュメント群からタイトルを自動推定し、概算トークン数をリアルタイム計算。
   - **画像・図面インライン化**: PNG/JPG/SVG/Excalidraw/draw.io の Base64 インライン統合。
8. **除外キーワードのファイル名部分一致厳格適用（通常検索・ハイブリッド・ベクトル・AIインプット）**:
   - **ファイル名に対する除外フィルタ**: 除外キーワードは本文（中身）ではなく、ファイル名（またはパス）に対する除外フィルタとして機能する。
   - **ファイル名部分一致の完全除外**: 検索結果として検出されたアイテムのファイル名（またはステム）に除外キーワードが含まれている場合（例: `gantt_diff_summary` に対する `gantt_diff_summary.json`, `2026_gantt_diff_summary_v1.md`, `my_gantt_diff_summary_notes.txt` 等）、通常検索・ハイブリッド検索・ベクトル検索・AIインプット画面のすべてで確実に除外される。
   - **誤除外防止（記号/単語境界ガード）**: `old`, `env`, `bin`, `git` などの4文字以下の短い英数字キーワードについては、`older`, `environment`, `digital`, `combine` などの一般的な単語への過剰除外を防ぐため、記号/単語境界でのみ一致判定する。
   - **AIインプット画面連携**: 検索結果からの初期候補受け渡し時、設定非同期読み込み時、および画面内での候補検索実行時のすべてでファイル名除外キーワードを厳格に適用。
9. **モデル切替とインデックス開始の自動連動**:
   - ベクトル管理画面でモデルカード（超軽量 / 標準）を選択後、明示的なモデルロードボタンを押さずに「⚡ 差分更新」や「🔄 全件再作成」を押下した場合でも、選択されたモデルが未ロードまたは別モデルであれば自動的にロードしてからインデックス作成を開始する。
   - バックエンド API（`/api/vector/index/start`）は `model_path` を受け取り、指定されたモデルのロードを保証した上でインデックス同期を実行する。また、対象フォルダ未指定時は DB 内の有効なローカル検索対象フォルダを安全に取得して同期対象とする。
10. **アクティブ（稼働中）モデルの視覚的強調ハイライトと自動同期**:
   - ベクトル管理画面において、現在バックエンドでロードされ稼働中のモデルを「🟢 稼働中 (アクティブ)」バッジ、鮮やかなアクセント発光枠線（`boxShadow`）、背景透過ハイライトによって視覚的に最優先で強調表示する。
   - 画面ロード時およびデータ更新時に、現在稼働中のモデルに合わせて選択状態（`selectedModelType`）を自動同期し、非稼働モデルが誤ってアクティブとしてハイライトされることを防止する。
   - ユーザーが別モデルをクリックして切り替えようとしている際は、「👉 選択中 (未ロード)」バッジおよび点線枠線で区別し、ロードボタンのラベルも「🚀 選択したモデルをロードして切替」に動的に変化させる。
11. **インデックス作成中のリアルタイム状態可視化**:
   - 初期ロード時（`refreshData`）および定期ポーリングにより `fetchVectorIndexProgress` を取得し、インデックス作成中（`is_indexing`）であれば即座に検知する。
   - ページヘッダー最上部に「🔄 ベクトルインデックス作成中... (XX%)」バッジをパルス表示し、どこからでも一目で把握可能にする。
   - インデックス管理パネルおよび稼働中モデルカードに発光枠線および同期中スピナーを表示し、更新ボタンもローディング状態として排他制御する。
12. **モデル選択の永続化 (`config.json`) と起動時自動復元・即時検索**:
   - **永続化**: ユーザーがモデル（超軽量 `ruri-v3-30m` / 標準 `ruri-v3-310m` 等）を選択・ロードした際、その設定が `backend/data/config.json`（またはルート `config.json`）に自動保存される。
   - **起動時自動復元**: バックエンドサーバーの起動時（`main.py` の `lifespan` 内）に `config.json` から設定モデルを検知し、自動的にメモリ上にロードを完了させる（設定ファイルが存在しない場合はデフォルトの超軽量モデルに安全にフォールバック）。
   - **即時検索**: サーバー再起動直後であっても、ユーザーがベクトル管理画面等でモデルを再ロードする手間を一切かけずに、そのままハイブリッド検索・ベクトル検索・AIインプットを即座に実行できる。
13. **類似語・専門用語の一元管理（`synonym_groups.txt`）**:
   - **単一データソースでの一元管理**:
     - 従来の「同義語（類義語）リスト」とベクトル検索用の「専門用語辞書」を完全統合。
     - 単一の設定ファイル（`backend/data/synonym_groups.txt`）およびWeb画面の「検索ルール管理 > 類似語・専門用語リスト」から編集・保存を一元的に行う（ベクトル管理画面側の個別エディタは廃止）。
   - **データフォーマット**:
     - `用語1,用語2,... : 意味・解説`（コロン以降の解説文は任意入力）。
     - 解説を付与しない行は従来通りの同義語として動作し、上位互換性を維持。
   - **通常検索（キーワード検索）と意味検索（ベクトル・ハイブリッド）の責務分離**:
     - **通常検索時**: コロンより前の類似語（`用語1, 用語2, ...`）のみを抽出し、検索クエリの OR 展開に利用。意味・解説の文章は通常検索のキーワード展開に混入させない。
     - **意味検索時（ハイブリッド/ベクトル/AIインプット）**: コロン前後の用語群および解説文を専門用語辞書（Glossary）としてロード。表記揺れ・意味展開に活用。
   - **即時ホットリロード**:
     - 検索ルール管理画面で類似語・専門用語を保存（`PUT /api/index/settings`）すると、`IndexService` の同義語キャッシュ更新に加え、`vector_state.reload_glossary()` が自動呼出され、ベクトル辞書も即座に同期・ホットリロードされる。
14. **GPU (Mac MPS / Windows RTX A500 CUDA) 自動活用 & CPUフォールバック**:
    - **デバイス自動検出**:
      - 環境変数 `VECTOR_DEVICE` があればそれを最優先（`cpu`, `cuda`, `mps`, `auto` など）。
      - Windows / Linux 環境: `torch.cuda.is_available()` を検知し、NVIDIA RTX A500 等の CUDA GPU で自動高速化。
      - Mac 環境: `torch.backends.mps.is_available()` を検知し、Apple Silicon Metal GPU (MPS) で自動高速化（実機ベンチマークで CPU 比約7.2倍高速化）。
      - 非対応環境: 安全に `cpu` を自動選択。
    - **ロード時・推論時の自己修復フォールバック**:
      - モデルロード時またはエンコード実行時に、GPU ドライバ異常やメモリ不足（OOM）などの例外が発生した場合、プロセスを終了させずに警告ログを出力し、自動的に `cpu` へシームレスにフォールバックして処理を完遂。
    - **バッチ処理最適化**:
      - GPU（MPS/CUDA）の並列計算能力を活かし、チャンク埋め込み時のバッチ処理で高速化。
    - **UI可視化**:
      - ベクトル管理画面の最上部ヘッダーおよびモデル選択パネルに、稼働デバイスバッジ（`⚡ GPU稼働中: Apple Silicon (Metal)` / `⚡ GPU稼働中: NVIDIA RTX A500 (CUDA)` / `💻 CPU稼働中 (フォールバック)`）とデバイス名を常時表示。
    - **Windows NVIDIA GPU (RTX A500) 配布・セットアップ対応**:
      - `backend/requirements.txt` に Windows GPU 手順を明記。
      - `backend/requirements-cuda.txt` を新設し、PyTorch 公式 CUDA 12.4 対応 wheel の自動取得に対応。
      - ルートに `setup_windows_cuda.bat` を新設し、ワンクリックで仮想環境作成から CUDA 版 PyTorch インストール・動作確認までを一括実行可能に。
      - `start_windows.bat` 起動時にコンソールへ現在の稼働デバイス（CUDA GPU または CPU）を出力。

---

# デスクトップランチャー単一インスタンス保証 & Escape / トグル安定化仕様書

## 概要
バックエンド再起動や手動起動時にランチャープロセス（`launcher_app.main`）が多重起動し、同一座標に重なってウィンドウが表示されることで「Command + Option を押しても消えない」現象を防止するため、ファイル排他ロックによる単一インスタンス保証、全域での Escape キー捕捉、およびトグル状態フラグの同期を導入。

## 仕様
1. **単一インスタンス（Single Instance）ガード**:
   - `launcher_app/main.py` に `acquire_single_instance_lock()` を実装。
   - macOS / Linux では `fcntl.flock(LOCK_EX | LOCK_NB)`、Windows では `msvcrt.locking(LK_NBLCK)` によるクロスプラットフォーム排他ロックを採用。
   - 既に別プロセスがロックを保持している場合、重複起動せずに警告ログを出力して直ちに `sys.exit(0)` で正常終了する。
2. **Escape キー全域捕捉 & 画面復帰**:
   - `LauncherPanel.keyDown_` にて Escape キー（keyCode 53 または `\x1b`）を最優先で直接捕捉。
   - フォーカスが検索入力欄・ボタン・チェックボックス・セグメント等のどこにあっても、確実に動作する。
   - gantt メモ画面表示中は検索画面へ復帰（`_switch_screen("search")`）。
   - 検索画面表示中はパネルを確実に非表示化（`hide_panel()`）。
3. **ホットキー押下中（継続中）の誤再トリガー防止 & 350ms クールダウン**:
   - `Command + Option` を押して非表示になった瞬間に指がまだキー上にある場合、watchdog 等で即座に再表示（点滅）されるのを防ぐため、`hotkey_activated` は `hide_panel()` 内ではなくキー解放（`active = False`）時のみリセットする。
   - `toggle_panel()` に 350ms の最小クールダウン間隔を設け、短時間のチャタリングや重複イベントによる即座の再表示（消えた直後に出る現象）を物理的に遮断。
4. **開発用スクリプトの残存プロセス強制終了 (`start_dev.sh`)**:
   - バックエンド起動フローにおいて、ポート 8079 の停止処理に加え、残存している `launcher_app.main` プロセスを `pgrep` で検知して確実に終了させる `kill_launcher` 関数を組み込み。

---

# Windows WPF ランチャー 発行・テスト仕様書

## 概要
ハイブリッド検索（既定）、ベクトル検索、通常キーワード検索の切替UI、および結果カードへの一致バッジ（🌟両方一致 / 🔮意味一致 / 🏷️通常一致）・核心文表示に対応した Windows WPF ランチャーを self-contained 形式で発行・ビルドする。

## 仕様
1. **発行成果物**:
   - `launcher/windows/publish/folder/LocalSearchLauncher.exe`（フォルダ配布版・推奨）
   - `launcher/windows/publish/single-file/LocalSearchLauncher.exe`（単一実行ファイル版）
2. **単体テスト (`LocalSearchLauncher.Tests`)**:
   - 外部NuGet依存なしで .NET 8 標準機能により動作。
   - 既定の検索リクエストが `searchType: "hybrid"` で `api/search` に送信されること、キーワード検索時に `api/search/indexed` に切り替わること、一致バッジおよび核心文の表示ロジック、検索方式の画面状態保持を検証。
3. **ビルド手順**:
   - `launcher/windows/publish.ps1` により Release ビルド・発行を自動実行。
4. **UI文字色・視認性**:
   - 検索方式選択ドロップダウン（`SearchTypeCombo`）および各選択項目（`ComboBoxItem`）の文字色を濃色黒（`#0F172A`）に設定し、白背景上での視認性を確保。

---

# FAISS未導入環境でのNumPy内積フォールバック仕様書

## 概要
`faiss`（`faiss-cpu`）が未インストールの環境（オフラインPCや依存パッケージ不足環境）であっても、アプリケーション起動（`app.main`）が阻害されず、通常検索・Web検索・Gantt検索が問題なく動作し、ベクトル内積検索も NumPy による高速内積計算（`np.dot`）へシームレスに自動フォールバックする。

## 仕様
1. **安全なインポートとフラグ判定**:
   - `app.vector.faiss_index` にて `import faiss` を try-except で保護し、失敗時は `HAS_FAISS = False` として検出。
2. **NumPy 内積フォールバック (`FaissVectorIndex`)**:
   - FAISS利用可能時: `faiss.IndexFlatIP` で高速内積検索。
   - FAISS未導入時: `np.dot` および `np.argpartition` を用いた等価なコサイン類似度（内積）上位K件検索を提供。
3. **ベクトルエンジン稼働状態の可視化 & UIガイダンス**:
   - バックエンド API（`GET /api/vector/model/status`）が `has_faiss: bool` を返却。
   - Web UI（ベクトル管理画面）のヘッダーおよびモデル選択カードにエンジン状態バッジ（`⚡ FAISS` vs `⚠️ NumPy (フォールバック)`）を表示。
   - `has_faiss === false` の場合は、モデル管理パネル内に FAISS 導入手順（`pip install -r backend/requirements.txt` または `pip install faiss-cpu`）の警告ガイダンスバナーを表示。
4. **検証**:
   - `backend/tests/test_faiss_fallback.py` および `backend/tests/test_vector_api.py` にてFAISS不在環境・強制NumPyフォールバック・APIレスポンスの正確性を担保。
   - `frontend/src/vectorSearchUi.test.ts` にてUIバッジ表示およびガイダンスバナー表示の単体テストをパス。

---

# 検索ルール管理への対象拡張子移設 & ベクトル検索適用仕様書

## 概要
インデックス対象拡張子の選択・追加・削除・保存UIを、ハンバーガーメニュー（設定ドロワー）から上部タブ「検索ルール管理」画面へ移設し、除外キーワード・類似語専門用語リスト・インデックス対象拡張子の3本柱として一元管理する。
また、ユーザーが選択・設定した拡張子（`index_selected_extensions`、`custom_content_extensions`、`custom_filename_extensions`）を、通常キーワード検索だけでなくベクトル検索（インデックス走査および検索フィルタ）へも完全に適用する。

## 仕様
1. **UI配置（検索ルール管理）**:
   - 「検索ルール管理」画面の `rule-management-grid` 内に第3のカード「**インデックス対象拡張子**」を新設。
   - ヘッダー操作: `選択件数`、`全選択`、`全解除`、`保存` ボタン。
   - 拡張子検索欄: 入力された文字列（例: `.md`）で標準拡張子および追加拡張子を即座に絞り込み表示。
   - 追加拡張子フォーム: 本文抽出用追加拡張子（`.py` / `.dat` 等）およびファイル名のみ追加拡張子（`.cae` / `.mesh` 等）のインライン追加。
   - リスト表示: 標準拡張子チェックボックス一覧、追加した本文用拡張子一覧（削除ボタン付き）、追加したファイル名のみ拡張子一覧（削除ボタン付き）。
   - 保存状態表示: `hasUnsavedIndexExtensions` に応じて「未保存の変更があります」または「保存済み」を表示。
2. **ハンバーガーメニュー（設定ドロワー）からの撤去**:
   - 設定ドロワー内の「対象拡張子」パネルを削除し、メニュー構造をスッキリ整理。
3. **ベクトル検索への適用**:
   - **インデックス作成時 (`VectorIndexManager.scan_files`)**:
     - `selected_extensions`（選択拡張子一覧）および追加拡張子（`custom_content_extensions`, `custom_filename_extensions`）を適用。
     - ユーザーがチェックを外した拡張子のファイルはベクトルDBへの走査・インデックス対象から除外され、追加した拡張子は正しくベクトル化される。
     - `VectorState.sync_index` は設定ファイルから自動で選択拡張子・カスタム拡張子をロードしてマネージャーへ渡す。
   - **検索時 (`_dispatch_search` in `app.api.search`)**:
     - 検索パラメータ（`extensions` または `index_types`）が指定された場合、キーワード検索と同様にベクトル検索結果（`v_res.results`）に対しても同一の拡張子フィルタリングを適用。
4. **検証**:
   - `backend/tests/test_vector_indexer.py`: 選択拡張子・カスタム拡張子による走査とインデックス制限のテスト。
   - `backend/tests/test_vector_search_extensions.py`: ベクトル検索結果に対する拡張子フィルタリングのテスト。
   - `frontend/src/appSettingsStructure.test.ts`: 検索ルール管理への移設と設定ドロワーからの撤去の検証。

---

# インデックス対象拡張子の除外厳格化 & クリーンアップ仕様書

## 概要
「検索ルール管理」の「インデックス対象拡張子」でチェックを外した（除外した）拡張子（例: `.json`）が、通常の全文検索インデックス作成（`IndexService`）およびベクトルインデックス同期（`VectorState` / `VectorIndexManager`）の走査・テキスト抽出・DB登録から完全にスキップされ、既存のインデックスデータからも即座にクリーンアップされる。

## 仕様
1. **全文インデックス走査時のフォールバック & フィルタリング (`IndexService.ensure_fresh_target`)**:
   - `types` 引数が未指定（`None`）または空文字列（`""`）の場合、全対応拡張子ではなくユーザーが設定・保存した `app_settings.index_selected_extensions` をフォールバックとして確実に適用する。
   - 呼び出し元や既存ターゲットから渡された `types` であっても、グローバル設定 `app_settings.index_selected_extensions` で除外された拡張子は確実に除外（交差フィルタリング）する。
2. **targets テーブルの selected_extensions 同期 (`IndexService._sync_local_target_selected_extensions`)**:
   - 検索ルール管理で拡張子設定が更新された際、全ターゲットの `selected_extensions` を新設定と同期し、除外された拡張子を除去する。
3. **除外拡張子ファイルの即時クリーンアップ (`IndexService._cleanup_excluded_extension_files`)**:
   - 設定保存時に、新設定で除外された拡張子を持つファイルを `files`、`file_segments`、`failed_files`、およびベクトルDBから即時削除する。
4. **ベクトルインデックス同期の確実な連動 (`VectorState.sync_index`)**:
   - `IndexService` インスタンス化の修正およびフォールバック読み込みにより、アプリ設定の `index_selected_extensions` を確実に取得し、除外拡張子ファイルをスキップする。
5. **検証**:
   - `backend/tests/test_index_service.py`: `test_index_skips_extensions_excluded_in_app_settings`, `test_reindex_search_targets_respects_app_settings_excluded_extensions`, `test_update_app_settings_cleans_up_newly_excluded_extension_files`
   - `backend/tests/test_vector_state.py`: `test_vector_state_sync_index_respects_app_settings_excluded_extensions`

---

# AIインプット: 呼び出されたメール（MSG/EML）追加 & Base64画像埋め込み仕様書

## 概要
AIインプット画面（Chat AI Context Export）において、Markdownファイル内でリンクされているメールファイル（`.msg`, `.eml`, `winmail.dat` 等）を自動抽出し、生成される単一自己完結型HTMLの末尾に「APPENDIX: 呼び出されたメール (Linked Emails)」として構造化展開する。さらに、「🖼️ 画像・図面をBase64埋め込み」が有効な場合は、メール内のインライン画像および添付画像も Base64 Data URL として HTML 内へインライン埋め込みする。

## 仕様
1. **メールリンク検出 (`extract_linked_email_paths`)**:
   - Wikilink（`[[mail.msg]]`, `![[mail.msg]]`, `[[path/mail.eml|表示名]]`）および Markdown リンク（`[メール](mail.msg)`）からメール参照パスを検出・解決。
   - 重複を排除し、実在するファイルのみを抽出。
2. **Office/Outlook サニタイズ (`sanitize_outlook_html`)**:
   - `obsidian-dagnetz` の仕様に準拠し、Word/Outlookエンジン由来の条件付きコメント（`<!--[if ...]>`）、`<xml>`, `<o:p>`, `<w:...>`, `<head>`, `<style>` 等を完全除去し、文字化けやタグ露出を防止。
3. **本文・画像レンダリング (`render_email_to_html`)**:
   - 画像埋め込みOFF、または画像なし＆表なし＆プレーン本文ありの場合は、タグ混入のないプレーンテキスト本文を最優先。
   - 画像埋め込みON時、CID画像（`cid:...`）および添付画像を Base64 Data URL（`data:image/...;base64,...`）に変換してインライン置換。未配置画像は「メール内の画像」セクションとして末尾に配置。
4. **HTML統合 & 目次連携 (`export_documents_to_html`)**:
   - 目次（TOC）に「📎 APPENDIX: 呼び出されたメール ({N} 件)」およびアンカーリンクを追加。
   - 本文末尾に各メール（件名、送信者、宛先、日時、ファイルパス、本文、画像）をカード形式で配置。
5. **UI & API**:
   - AIインプット画面に「✉️ アウトプットに呼び出されるメールを追加する」チェックボックス（初期値: `true`）を配置。
   - `AiHtmlExportRequest` および API クライアントに `include_linked_emails: bool = True` を追加。
6. **ドキュメント & テスト**:
   - ドキュメント: `docs/ai_linked_emails_spec.md`, `docs/ai_linked_emails_flow.excalidraw.md`
   - テスト: `backend/tests/test_ai_html_linked_emails.py`, `frontend/src/vectorSearchUi.test.ts`

---

# .excalidraw.md の画像ファイル（図面アセット）取り扱い仕様書

## 概要
Obsidian Vault 内において、`明和高校.excalidraw.md` のような `.excalidraw.md` ファイルは拡張子こそ `.md` であるものの、実態は図面・画像アセットである。
`obsidian-dagnetz` の仕様・実装に準拠し、本システムにおいても `.excalidraw.md` を「文書」ではなく「画像・図面ファイル」として取り扱う。

## 仕様
1. **AIインプット文書収集からの除外 (`export_documents_to_html`)**:
   - `export_documents_to_html` において、対象ファイルが `.excalidraw.md` または `is_excalidraw_backed_markdown` の場合は文書記事（`<article>`）としての本文出力をスキップする（Excalidraw JSON や内部メタデータの生展開を防止）。
2. **Markdown ノート内リンクの画像置換 (`replace_obsidian_image_embeds`)**:
   - `![[xxx.excalidraw.md]]`（埋め込み）だけでなく、`[[xxx.excalidraw.md]]` や `[[xxx.excalidraw.md|300]]`、`[[xxx.excalidraw.md|別名]]`（`!` なしの通常リンク）も画像・図面として検知。
   - `.excalidraw-cache/` のプレビュー画像または動的生成 SVG を Base64 Data URL 化し、`<img>` タグへ置換する。
3. **AIインプット画面の候補選定 (`AiInputPage.tsx` / `aiInputCandidate.ts`)**:
   - 「ステップ 2: AIにインプットするノートを選択」の候補一覧から、`.excalidraw.md`、`.excalidraw`、`.drawio.svg`、画像拡張子等のアセットを文書候補から除外する。
4. **ファイル種別・アイコン表示**:
   - Web画面 (`fileIcon.ts`)、macOS/Flet ランチャー (`file_icons.py`)、Windows WPF ランチャー (`SearchModels.cs`) で、`.excalidraw.md` に対して `markdown.svg` ではなく `excalidraw.svg`（図面アイコン）を適用する。
5. **ドキュメント & テスト**:
   - ドキュメント: `docs/excalidraw_image_handling_spec.md`, `docs/excalidraw_image_flow.excalidraw.md`
   - テスト: `backend/tests/test_ai_html_excalidraw_image.py`, `frontend/src/fileIcon.test.ts`, `frontend/src/aiInputCandidate.test.ts`, `launcher/tests/test_file_icons.py`

---

# 社内制限環境（pip installのみ可能）自己完結運用 & モデル管理仕様書

## 概要
会社PCは外部通信（HuggingFace等からのモデルダウンロード）やビルドツール（Node.js, .NET SDK）が制限され、`pip install` 以外は実行できない環境である。
モデルファイルは別途ダウンロード・配置する運用に対応し、リポジトリを軽量に保ちつつ、`models/` または `backend/models/` への柔軟な配置自動検知、モデル未配置時の安全起動、UI/ランチャーのビルド済み同梱、設定ファイルのGit共有を提供する。

## 仕様
1. **モデルのローカル配置と柔軟な自動検知 (`VectorState.resolve_model_path`)**:
   - ベクトルモデル（数GB）は Git リポジトリにコミットせず `.gitignore` で除外。
   - モデルファイルは会社PC側で別途ダウンロード・配置（共有ドライブやUSB等）して運用する。
   - バックエンドは以下のどちらに置かれても自動検知してロードする：
     - `models/<モデル名>/`（例: `models/ruri-v3-30m`）
     - `backend/models/<モデル名>/`（例: `backend/models/ruri-v3-30m`）
   - 別マシン（Mac等）で保存された絶対パスが `config.json` に残っている場合でも、フォルダ名からローカルのディレクトリを自動解決。
   - モデルが未配置の場合でもバックエンドはクラッシュせず正常に起動し、通常キーワード検索（FTS5）が即座に利用可能。Web画面のベクトル管理ページで未配置状態を案内する。
2. **設定ファイルの Git 同期と端末固有キャッシュの分離 (`.gitignore`)**:
   - 端末固有DB（`*.db`, `*.db-*`）やログのみを除外。
   - `synonym_groups.txt`（専門用語辞書）、`exclude_keywords.txt`、`index_selected_extensions.txt`、`config.json` 等の設定ファイルを Git 追跡対象とし、会社PCでも設定・辞書が自動共有される。
3. **ビルド済み成果物の同梱**:
   - フロントエンド (`frontend/dist/`): FastAPI が配信するため社内PCで Node.js 不要。
   - Windows WPF ランチャー (`launcher/windows/publish/folder/` および `single-file/`): self-contained 同梱のため社内PCで .NET SDK 不要。
4. **Windows ワンクリックセットアップ**:
   - `setup_windows.bat`: CPU環境向けに `.venv` 作成と `pip install -r requirements.txt` を自動実行。
   - `setup_windows_cuda.bat`: NVIDIA GPU (RTX A500 等) 向けに CUDA 12.4 PyTorch を自動インストール。
   - `start_windows.bat`: `.venv` / `venv` を自動検出して起動。
5. **ドキュメント & テスト**:
   - ドキュメント: `docs/offline_environment_and_models.md`
   - テスト: `backend/tests/test_vector_state.py`




