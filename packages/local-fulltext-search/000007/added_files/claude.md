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
4. **ハイブリッド融合アルゴリズム & スコア正規化 & 並び替え**:
   - RRF (Reciprocal Rank Fusion, $k=60$) により、キーワード順位とベクトル類似度順位を公平に合成。
   - 理論最大スコア（両方1位: $S_{\max} = \frac{w_v+w_k}{k+1}$）で正規化し、UI上で直感的な $0\% \sim 100\%$（両方1位で100%、片方1位で約50%）の融合スコアを表示。
   - 各結果に `match_source`（`both` [両方一致], `vector` [意味一致], `keyword` [キーワード一致]）、核心文（`salient_sentence`）、正規化融合スコア・意味類似度を付与。
   - 並び替えに「ハイブリッドスコア順 (`hybrid_score`)」「ベクトル類似度順 (`vector_score`)」「通常検索スコア順 (`keyword_score`)」を追加。
   - デフォルト（`default`）並び替え選択時は、ハイブリッド検索結果に対してハイブリッド順位（`hybrid_score` 降順）を最優先で表示。
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
   - **拡張子フィルター**: 質問・キーワード入力欄の右隣にメイン画面（SearchBar）と同様の拡張子フィルター入力欄（`md excalidraw`、`-png`、`-.jpg` 等の包含・除外）を配置。デフォルト値として `md` が事前設定され、メイン画面で拡張子が入力されていた場合はその値を引き継ぎ、未入力時は `md` に自動フォールバック。API検索（`types` パラメータ）および候補ドキュメント一覧のリアルタイム動的絞り込み（`filterSearchResultsByExtensions`）に完全連動。
   - **上部HTML作成ボタン**: 候補選択後、下までスクロールすることなく即座にHTMLを生成できるよう、ステップ2（候補ノート選択）のヘッダー右側（全選択・全解除ボタンの横）にグラデーションスタイルの「🚀 AI用HTMLファイルを生成する」ボタンを配置。
   - **ドラッグ範囲選択**: マウスドラッグによる連続選択、Shift+ドラッグによる選択解除。
   - **プロンプトプリセット5種**: 統合サマリー、課題・ToDo、Q&A、設計・実装計画、差分・変更点。
   - **デュアルタブ切替**: プレビュー（iframe表示）と HTML ソースのタブ切替。
   - **タイトル自動生成 & トークン概算**: 選択ドキュメント群からタイトルを自動推定し、概算トークン数をリアルタイム計算。
   - **画像・図面インライン化**: PNG/JPG/SVG/Excalidraw/draw.io の Base64 インライン統合。
   - **特大プレビュー＆ファイル選択・順序並び替えモーダル（左右2カラム・リアルタイム連動）**:
     - **フルスクリーン最大化表示 (`width: 100vw; height: 100vh; padding: 0;`)**: HTML生成時に画面全体を余白なく使い切るフルスクリーンモーダルを展開。大画面でもプレビュー・ソースコードの視認領域を極限まで最大化。
     - **左側ペイン**: `iframe` によるフルスクリーンHTMLプレビューおよび生HTMLソース表示。
     - **右側ペイン（対象ファイル選択 & ドキュメント順序並び替え）**:
       - 各ドキュメントにドラッグハンドル（`⋮⋮`）、順位バッジ（`#1`, `#2`...）および「▲」「▼」移動ボタンを配置。
       - **ドラッグ＆ドロップ並び替え**: ドキュメントアイテムを直接掴んで任意の位置へドロップするだけで直感的に順番を移動可能。ドラッグ中の半透明化、ドロップ先の青色ハイライトインジケーターを表示。
       - 並び替えた順序、またはチェックボックスのON/OFFに応じてデバウンス（200ms）でバックエンド `generateAiHtml` を自動呼び出し、目次（TOC）および本文の出力順序をリアルタイムに再生成。
     - **ローカル保存＆パスコピー**: `POST /api/export/ai-html/save` APIによりユーザーのダウンロードフォルダへ直接安全保存し、**その絶対ファイルパスを即座にクリップボードへ自動コピー**（チャットAIやCursor、ターミナルへ `Command + V` で即投入可能）。保存されるHTMLもモーダルで並び替えた順序をそのまま保持。
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
    - **永続化**: ユーザーがモデル（超軽量 `ruri-v3-30m` / 標準 `ruri-v3-310m` 等）を選択・ロードした際、その設定が `backend/data/config.json`（またはルート `config.json`）に自動保存される。`mock_model` 等のテスト用ダミーモデルは保存せず設定ファイルの汚染を防止する。
    - **起動時自動復元**: バックエンドサーバーの起動時（`main.py` の `lifespan` 内）に、`config.json` に有効な記録が残っている場合のみ設定モデルを自動検知してロードを完了させる。初回起動時や未選択時（記録なし）はモデルを自動ロードせず、未ロード状態で安全に待機する。
    - **即時検索**: サーバー再起動直後であっても、記録が残っていればユーザーが手動でリロードする手間を一切かけずに、そのままハイブリッド検索・ベクトル検索・AIインプットを即座に実行できる。
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
4. **Outlook MSG の CP932 ベストエフォートデコード (`parse_msg_file`, `decode_best_effort_text`, `mojibake_score`)**:
   - `obsidian-dagnetz` の `RegisterCustomCommands.md` に準拠し、コードページが 1252 とマークされつつ日本語（CP932/Shift_JIS）が格納されているメールファイルでの `UnicodeDecodeError`（cp1252 / charmap）を完全に防止。
   - `openMsg` 失敗時の `overrideEncoding="cp932"` 自動再試行。
   - 属性取得失敗時の生ストリーム（`getStream`）直接読み取り（`001F` は `utf-16le`、`001E` は CP932 優先ベストエフォートデコード）。
   - `mojibake_score` による文字化け判定により、最も自然な日本語テキストを採用。
   - HTML本文の `<meta charset="...">` を検出して正確にデコードし、プレーンテキストが空の場合はHTMLからタグを除去してプレーン本文を自動補完。
   - 検索インデックス作成用テキスト抽出（`text_extractor.py` の `_extract_msg_text`）にも同様の `overrideEncoding="cp932"` 再試行を適用し、メール内容を漏れなくインデックス。
5. **HTML統合 & 目次連携 (`export_documents_to_html`)**:
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
2. **設定ファイルの環境別個別保持と Git 除外 (`.gitignore`)**:
   - `synonym_groups.txt`（専門用語辞書）、`exclude_keywords.txt`、`index_selected_extensions.txt`、`config.json` 等の設定ファイルは、各端末・環境固有のパスや設定を含むため Git 管理から除外し（`.gitignore`）、環境ごとに個別に保持する。
   - ディレクトリ構造維持用の `backend/data/.gitkeep` および参考用設定例 `*.example` のみを Git 追跡対象とする。
   - 設定ファイルが未作成の環境では、バックエンド起動時や読み込み時にデフォルト設定が自動生成される。
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

---

# ベクトルインデックスの差分検知 & 除外キーワード完全連動・クリーンアップ仕様書

## 概要
ベクトルインデックスの差分同期において、未変更ファイルの不要な Embedding 計算を2段階でスキップするとともに、設定された除外キーワード（`exclude_keywords.txt`）を Web UI からの差分同期（⚡）や全件再作成（🔄）時にも厳格に適用し、除外対象が誤って再インデックスされるのを防止する。また、除外キーワード変更時には既存の全ベクトルDBから除外対象ファイルを即座に自動パージ（クリーンアップ）する。

## 仕様
1. **2段階の差分検知スキップ (`VectorIndexManager.index_all`)**:
   - 第1段階: ベクトルDBの `(mtime, size)` とファイルシステムの更新日時・サイズを比較し、完全一致なら即座にスキップ。
   - 第2段階: `mtime` や `size` が変化していても、SHA-256 ハッシュを計算して比較し、ハッシュが一致していればスキップ。
   - 新規またはハッシュ変更時のみテキスト抽出・チャンキング・Embedding生成を実行。
2. **除外キーワード自動解決 (`VectorState.sync_index`, `_run_vector_indexing`)**:
   - Web UI からの実行時など `exclude_keywords` が未指定（`None`）の場合、`AppSettings`（`exclude_keywords.txt`）から自動取得して適用。
3. **厳格な除外判定共通化 (`VectorIndexManager.scan_files`)**:
   - 絶対パス指定（`/path/to/...`）、相対パス/ディレクトリ名指定、単語境界（トークン完全一致による誤爆防止）、隠し要素（`foo/.`）を全文検索側と同等に正しく除外。
4. **除外キーワード変更時の即時パージ (`IndexService._cleanup_excluded_keyword_files`)**:
   - 設定保存時に、`files` / `file_segments` / `failed_files` だけでなく、`settings.data_dir` 配下の全 `vector_index_*.db` からも除外対象ファイルを即座に DELETE。
5. **ドキュメント & テスト**:
   - ドキュメント: `docs/vector_search_spec.md`
   - テスト: `backend/tests/test_vector_exclude_keywords.py`

---

# インデックス削除確認（削除通知）& フォルダ追加・拡張子変更時のインデックス保持仕様書

## 概要
検索対象フォルダの追加時や検索対象拡張子の変更時に、既存のインデックスデータが不用意に全削除されてしまう問題を防ぎ、インデックスを削除する操作（除外拡張子ファイルの削除・フォルダインデックス削除・DB初期化等）の前にユーザー確認を行う「削除通知」設定を導入。

## 仕様
1. **検索対象フォルダ追加時のインデックス保護 (`IndexService.add_search_target`, `set_search_target_enabled`)**:
   - 新規ターゲット登録時に、グローバル設定（`exclude_keywords`, `index_selected_extensions`）および指定階層数（未指定時は上限なし `99999`）を確実に反映。
   - 新規フォルダを追加しても既存フォルダのインデックス済みファイル群（`files`, `file_segments`）は一切削除されず安全に保持。
2. **拡張子除外時のインデックス保持 & 選択的クリーンアップ (`IndexService.update_app_settings`)**:
   - 拡張子設定の保存時に無条件で実行されていた `_cleanup_excluded_extension_files` を、`clean_excluded_files: bool = True` が明示指定された場合のみ実行するように変更（既定値 `False` では削除しない）。
   - クリーンアップ対象を `source_type = 'local'` に限定し、Webページ等の別リソースを完全保護。
3. **ハンバーガーメニュー内の「削除通知」チェックボックス**:
   - 設定ドロワー内の「データベースを初期化」の上に「インデックス削除時に確認する（削除通知）」チェックボックス（既定値: `true` [ON]）を設置。
   - 設定値は `backend/data/confirm_index_deletion.txt` に永続化。
4. **確認ダイアログフロー**:
   - **有効 (ON)**: 拡張子を外して保存した際、除外された拡張子の既存インデックスを削除するかダイアログで確認。「OK」なら削除実行、「キャンセル」ならインデックスを保持したまま設定のみ保存。
   - **無効 (OFF)**: 確認ダイアログを出さず、既存インデックスも削除しない（`clean_excluded_files: false` で安全に保持）。
5. **ベクトル差分インデックス時の削除確認 & 許可なき削除の完全抑止 (`VectorIndexManager.index_all`, `VectorState.sync_index`, `VectorManagementPage`)**:
   - 会社の低スペック端末で半日かかる再インデックスの無駄を防ぐため、インデクサー既定値を `clean_deleted_files: bool = False` とし、ユーザーの許可なく既存インデックスを一切削除しない（フェイルセーフ）。
   - 差分更新前に `POST /api/vector/index/pending-deletions` で走査から外れた未インデックス化削除候補ファイルを事前照合。
   - 削除通知が有効（ON）かつ削除対象が存在する場合、ファイル名一覧付きで確認ダイアログを表示。
   - 「OK」なら `clean_deleted_files: true` で該当ファイルをパージ、「キャンセル」なら `clean_deleted_files: false` で削除のみスキップし、新規・更新ファイルの学習・同期を安全に継続。
6. **ドキュメント & テスト**:
   - ドキュメント: `docs/index_deletion_confirmation_spec.md`, `docs/index_deletion_confirmation_flow.excalidraw.md`
   - テスト: `backend/tests/test_index_service.py`, `backend/tests/test_index_api.py`, `backend/tests/test_vector_indexer.py`, `backend/tests/test_vector_api.py`, `backend/tests/test_vector_exclude_keywords.py`, `frontend/src/appSettingsStructure.test.ts`, `frontend/src/vectorSearchUi.test.ts`

---

# 検索ボックスおよび拡張子フィルタのマイナス除外（-.png 等）機能仕様書

## 概要
検索ボックス（クエリ入力欄）および拡張子フィルタ入力欄において、マイナス記号（`-`）を付与したキーワードまたは拡張子（例: `-.png` や `-png`）を指定することで、該当する候補を検索結果から除外する機能を提供する。
Web UI、通常キーワード検索（FTS5）、正規表現検索、ベクトル検索、ハイブリッド検索（既定）、macOS Cocoa ネイティブランチャー、Python Flet ランチャー、Windows WPF ランチャーの全環境で一貫して動作する。

## 仕様
1. **検索ボックスでの除外記号 (`-.png` / `-keyword`)**:
   - `alpha -.png`: 「alpha」を含み、かつ「.png」を含まない候補を表示。
   - `-.png`（単体指定）: 「.png」を含まないすべての候補を表示（全スコープ対象から除外フィルタを適用）。
   - `-keyword`: 指定したキーワード（本文・ファイル名・フォルダパス）を含む候補を除外。
   - `\\-keyword` または `\\-.png`: バックスラッシュでエスケープされた場合は先頭の `-` を含む通常文字列として検索。
   - 全文検索（FTS5）、正規表現検索、ベクトル検索、ハイブリッド検索、gantt検索に完全連動。
   - ベクトル検索クエリにはポジティブ語のみが渡され、除外語のみの指定時はベクトル検索をスキップして高速かつ正確に応答。
2. **拡張子フィルタでの除外記号 (`-.png` / `-png`)**:
   - `-png` または `-.png`: ドットの有無に関わらず、`.png` 拡張子のファイルを除外。
   - `-png -jpg` または `-png, -jpg`: 複数指定による除外。
   - `md -png`: `.md` のみを対象とし、`.png` は除外。
   - バックエンド SQL レベルで `files.file_ext NOT IN (...)` を適用し、I/Oおよびメモリを最適化。
   - ベクトル検索・ハイブリッド検索の事後フィルタリングでも確実に除外。
   - Web UI のクライアントサイドフィルタリング（`filterSearchResultsByExtensions`）でも即時除外を反映。
3. **デスクトップランチャー連携**:
   - **macOS Cocoa 版 (`native_mac.py`)**: 検索窓（`search_field`）および拡張子欄（`extension_filter`）で `-.png` / `-png` がシームレスに機能。プレースホルダーとツールチップを `".md, -png"` に更新。
   - **Windows WPF 版 (`MainWindow.xaml`)**: 検索窓（`QueryBox`）および拡張子欄（`ExtensionBox`）で同様に機能。ToolTip を更新。
   - **Python Flet 版 (`app.py`)**: 検索窓および拡張子欄で同様に機能。ヒントテキストを更新。
4. **変更対象ファイル**:
   - `backend/app/extractors/text_extractor.py` (`parse_extension_filter`, `normalize_extension_filter`)
   - `backend/app/services/search_service.py` (`_split_search_terms`, `_build_common_filters`, `_search_with_fts`, `_search_folder_results`)
   - `backend/app/api/search.py` (`_dispatch_search` でのベクトル検索除外連動)
   - `frontend/src/extensionFilter.ts` (`parseSearchFilterTokens`, `filterSearchResultsByExtensions`)
   - `frontend/src/App.tsx` (`handleSearch` での `types` 送信)
   - `frontend/src/components/SearchBar.tsx` (拡張子フィルタの title 追加)
   - `launcher/src/launcher_app/ui/native_mac.py` (プレースホルダー・ツールチップ更新)
   - `launcher/src/launcher_app/ui/app.py` (ヒント更新)
   - `launcher/windows/LocalSearchLauncher/MainWindow.xaml` (ToolTip更新)
   - `launcher/windows/LocalSearchLauncher.Tests/Program.cs` (テスト追加)
   - `docs/extension_filter_spec.md`, `docs/negative_filter_flow.excalidraw.md`






