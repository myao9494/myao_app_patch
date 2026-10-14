# Local Fulltext Search - 作業ガイド

ローカルの文書を FTS5 全文検索とベクトル検索（ハイブリッド既定）で横断検索するアプリ。
FastAPI バックエンド、React フロントエンド（ビルド済みをバックエンドが配信）、デスクトップランチャー（macOS Cocoa / Python Flet / Windows WPF）で構成する。

このファイルは **作業時に必ず守ること** と **どこに何が書いてあるか** だけを置く。
機能ごとの仕様は `docs/` に、コア仕様の要約は [`AGENTS.md`](AGENTS.md) に書く。ここへ機能仕様を追記しない。

## ドキュメントの置き場所

| 場所 | 役割 |
|---|---|
| [`AGENTS.md`](AGENTS.md) | コア仕様の要約と開発ルール |
| [`docs/architecture.md`](docs/architecture.md) | モジュール構成と責務、データの流れ |
| [`docs/testing.md`](docs/testing.md) | テストの実行方法と隔離の仕組み |
| `docs/*_spec.md` ほか | 機能別の詳細仕様（下の索引を参照） |
| [`docs/spec_history.md`](docs/spec_history.md) | 機能追加ごとの仕様書アーカイブ（経緯の確認用。現行仕様と食い違う箇所は冒頭の表を参照） |
| [`README.md`](README.md) | 利用者向けの起動・配布手順と API 概要 |

コードを変更したら、該当する `docs/` の仕様書を同じ変更の中で更新する。ドキュメントとコードが食い違ったらコードを正とする。

## 開発ルール

- **TDD**: 期待する入出力のテストを先に書き、失敗を確認してから実装する。
- **コメント**: 各ファイルの冒頭と主要な関数に、日本語で仕様を書く。
- **機能・性能を落とさない**: 既存の挙動を変える変更は、仕様書とテストを同時に直す。
- **フロントを変更したら** `frontend/dist/` を再ビルドしてコミットする（配布先に Node.js が無いため）。
- **WPF ランチャーを変更したら** `launcher/windows/publish.ps1` で `publish/` を更新する（配布先に .NET SDK が無いため）。

## テスト

```bash
cd backend && .venv/bin/python -m pytest          # バックエンド
cd frontend && npm test && npm run typecheck       # フロントエンド（テスト + 型検査）
cd launcher && PYTHONPATH=src ../backend/.venv/bin/python -m pytest tests   # Python ランチャー
```

- バックエンドのテストは `tests/conftest.py` が `settings.data_dir` と `vector_state` をテストごとの一時フォルダへ隔離する。
  実環境の `backend/data`（検索DB・設定ファイル・ベクトルDB）を読み書きするテストを書かない。
- テストファイルは単独でも通ること（`pytest tests/test_xxx.py`）。他のテストの副作用に依存しない。
- 本番コードにテスト用の分岐（クラス名や `mock` 判定で挙動を変える処理）を入れない。差し替えたいものは引数で注入する。
- フロントの画面は、DOM へ描画して操作するテスト（`*Interaction.test.ts`）で検証する。操作で作りにくい状態の表示は描画のテスト（`*Render.test.ts`）、計算は純粋関数のテストで確かめる。ソースの文字列を調べるテストは書かない。
- 詳細は [`docs/testing.md`](docs/testing.md)。

## 壊してはいけない約束

1. **許可なくインデックスやファイルを消さない**
   - ベクトルインデックスの削除は `clean_deleted_files=True`、除外拡張子の既存インデックス削除は `clean_excluded_files=True` が明示されたときだけ。
   - 到達不能な対象フォルダ（未接続のネットワークドライブ等）配下の文書は、削除候補にしない。
   - ファイルの物理削除 API は `expected_path` と `file_id` の指すパスが一致するときだけ削除する。
2. **`file_id` は全文検索DBの `files.id`**
   - ベクトルDBの `documents.id` は別の ID 体系。検索結果へ出す前に必ず `files.id` へ解決する（`search_dispatcher`）。
   - `files` に無いベクトル文書は負の合成 ID を割り当てる。
3. **除外判定は 1 か所**: フォルダ名・ファイル名・パス形式の除外規則は `app/services/exclude_rules.py` だけに置き、
   全文インデックス・ベクトルインデックス・検索結果の絞り込み・変更通知の判定で共用する。
4. **設定ファイルの読み書きは `AppSettingsStore`**（`app/services/app_settings_store.py`）経由。設定を読むためだけに `IndexService` を生成しない。
5. **ベクトルDBへの書き込みは 1 トランザクション**: 文書とチャンクは `save_document_with_chunks` でまとめて保存する。接続は `open_db()` で開いて必ず閉じる。
6. **torch / faiss より先に `app` を import する**: OpenMP の二重初期化で落ちないための環境変数を `app/runtime_env.py` が設定する。同じ設定を他の場所に書かない。
7. **検索方式の既定は `hybrid`**（Web UI と全ランチャー）。ベクトルモデル未配置でも起動し、キーワード検索は動く。
8. **一致バッジは `match_source`**（`both` / `vector` / `keyword`）: Web UI と全ランチャーが読む項目。バックエンドは `match_type` から必ず導出して返す。API の項目名を変えるときは、全クライアント（Web・Python ランチャー・WPF ランチャー）を同時に直す。
9. **ランチャーの検索は既定で既存DBだけを使う**（`POST /api/search/indexed`）。インデックス更新を待つのは「更新」チェック ON のときだけ。
10. **他のモジュールの `_` で始まる関数・メソッドを呼ばない**: 必要な処理は公開された関数として切り出す。`IndexService` / `SearchService` は入口で、処理は `services/` の部品が持つ。
11. **フロントの状態は `hooks/`、表示は `pages/`・`components/`**: コンポーネントの中に API 呼び出しや状態管理を書き足さない。フックは `App.tsx`（各画面の最上位）で 1 度だけ呼ぶ。フックどうしは相手の更新関数（setter）を受け取らず、相手が公開する操作（「除外キーワードを追加する」など）を受け取る。

## 構成の早見表

```
backend/app/
  api/         HTTP エンドポイント（薄く保ち、処理は services / vector へ委譲）
  services/    全文インデックス・検索・設定・変更追跡・スケジューラー（入口は IndexService / SearchService。処理は役割ごとの部品へ分ける）
  vector/      Embedding・ベクトルDB・ベクトル検索・AIインプットのエクスポート
  extractors/  ファイル種別ごとのテキスト抽出
  db/          全文検索DB（SQLite）の接続とスキーマ
frontend/src/  React。状態と操作は hooks/、表示は pages/ と components/、組み立ては App.tsx。dist/ はビルド済み成果物
launcher/      Python ランチャー（src/launcher_app）と Windows WPF ランチャー（windows/）
```

責務とデータの流れは [`docs/architecture.md`](docs/architecture.md) を参照。

## 機能別仕様の索引

| 分野 | 仕様書 |
|---|---|
| 全文検索・並び替え・OR / 除外語 | [`or_search_spec.md`](docs/or_search_spec.md)、[`infinite_depth.md`](docs/infinite_depth.md)、[`performance.md`](docs/performance.md) |
| ベクトル・ハイブリッド検索 | [`vector_search_spec.md`](docs/vector_search_spec.md) |
| 検索ルール（除外・類似語・拡張子） | [`extension_filter_spec.md`](docs/extension_filter_spec.md)、[`synonym_management.md`](docs/synonym_management.md)、[`index_deletion_confirmation_spec.md`](docs/index_deletion_confirmation_spec.md) |
| 変更追跡・スケジューラー | [`change_tracking.md`](docs/change_tracking.md)、[`scheduler.md`](docs/scheduler.md) |
| AIインプット（エクスポート） | [`ai_context_export_spec.md`](docs/ai_context_export_spec.md)、[`ai_markdown_image_export_spec.md`](docs/ai_markdown_image_export_spec.md)、[`ai_linked_emails_spec.md`](docs/ai_linked_emails_spec.md)、[`ai_context_token_optimization_spec.md`](docs/ai_context_token_optimization_spec.md)、[`excalidraw_image_handling_spec.md`](docs/excalidraw_image_handling_spec.md)、[`ai_html_excalidraw_image_spec.md`](docs/ai_html_excalidraw_image_spec.md)、[`clipboard_permission_fallback_spec.md`](docs/clipboard_permission_fallback_spec.md) |
| メール（MSG / EML） | [`msg_encoding_support.md`](docs/msg_encoding_support.md)、[`file_icons.md`](docs/file_icons.md) |
| Web ページ検索・gantt 連携 | [`web_page_search_spec.md`](docs/web_page_search_spec.md)、[`gantt_task_search.md`](docs/gantt_task_search.md)、[`gantt_launcher_ui.md`](docs/gantt_launcher_ui.md) |
| ランチャー | [`launcher/docs/spec.md`](launcher/docs/spec.md)、[`launcher/docs/architecture.md`](launcher/docs/architecture.md)、[`launcher_indexed_search_spec.md`](docs/launcher_indexed_search_spec.md)、[`launcher_single_instance.md`](docs/launcher_single_instance.md)、[`launcher/windows/README.md`](launcher/windows/README.md) |
| 配布・オフライン運用 | [`runtime_and_distribution.md`](docs/runtime_and_distribution.md)、[`offline_environment_and_models.md`](docs/offline_environment_and_models.md)、[`open_hub.md`](docs/open_hub.md) |
| 管理画面 | [`indexed_targets_page.md`](docs/indexed_targets_page.md) |

## 既知の課題

現時点で残っている課題は [`docs/architecture.md`](docs/architecture.md) の「既知の課題」にまとめている。着手前に確認すること。
