# 仕様書（AI エージェント向け）

ローカルファイルを直接読み書きする Excalidraw PWA。詳細仕様は `docs/` にあり、**コードが正**。
動作を変えたら、該当する `docs/` の文書とこのファイルも同じコミットで更新すること。

## 開発ルール

- 不具合修正・機能追加は **テストを先に書く（TDD）**。保存同期は `hooks/useFileSync.test.ts`、
  Obsidian 形式は `tests/test_api_integration.py`（実ノートの往復）にならう
- コミット前に `npm test`・`npm run typecheck`・`python -m pytest tests` がすべて通ること
- **`dist/` は git 管理する**（ビルドできない社内 PC で使うため）。フロントエンドを変えたら
  `npm run build` で作り直し、`dist/` も一緒にコミットする。`node_modules/` は管理しない
- コメント・ドキュメント・UI 文言は日本語

## 構成（詳細: docs/architecture.md）

- フロントエンド: React 19 + `@excalidraw/excalidraw` 0.18 + Vite 5。`components/App.tsx` が画面を組み立て、
  読み込み・保存・外部更新は `hooks/useFileSync.ts`、API 呼び出しは `utils/backendApi.ts`
- バックエンド: FastAPI（`backend/main.py` はルーティングのみ。`storage.py`・`obsidian_markdown.py`・
  `obsidian_files.py`・`system_open.py`・`models.py`）。Python 3.10 以上
- 本番: FastAPI（port 3001）が `dist/` と API を同一オリジンで配信。開発: Vite 3001 + FastAPI 8008（proxy）
- API は常に相対パス（`API_BASE_URL = ''`）

## 起動

- **本番**: `./start_servers.sh`（Windows: `start_servers.bat`）。npm と node_modules があればビルドし、
  なければ git 管理の `dist/` を使う。port 3001 の既存待受を終了してから FastAPI を起動し、HTTP 応答後に起動完了を表示
- **開発**: `./start_dev.sh`（Vite 3001 + FastAPI 8008。起動時に既存プロセスを終了してポートを解放）

## ファイルの読み込み（`GET /api/load-file`、詳細: docs/api.md）

- 対応: `.excalidraw`、`.excalidraw.md`、Front Matter に `excalidraw-plugin: parsed` を持つ `.md`
- 空ファイル（空白のみ含む）は要素なしの空の図面を返す
- エラー: ファイルなし 404 / JSON 不正 400（行・列・前後の行・検証詳細付き） / その他 500
- `modified`（更新日時）を必ず返す。外部更新検知の基準になる
- Obsidian 互換（詳細: docs/obsidian.md）
  - `.excalidraw.md` は `## Drawing` の JSON ブロック（LZString 圧縮）を取り出して返す
  - 埋め込み画像は `.obsidian/plugins/obsidian-sidebar-explorer/image_paths.json` → 同じフォルダ → 添付用サブフォルダ →
    Vault ルート → 1つ上のフォルダの順に探して `files` に含める。フォルダを Vault 外へ移動しても、
    同じフォルダ・サブフォルダの画像は URL デコード・拡張子補完・大文字小文字の違いを吸収して解決する
  - Vault 内（またはパスに `obsidian` を含む）`.excalidraw` は `shouldMigrateToMarkdown: true` を返し、
    フロントエンドが `.excalidraw.md` に変換して元ファイルを `backup/` へ移す

## 保存（`POST /api/save-file`）

- 一時ファイルに書いてから置換（原子的）。ロック時は 0.2 秒間隔で最大 10 回リトライ
- `.md` は Obsidian 形式（本文・Front Matter を維持して図面・Text Elements・Embedded Files だけ更新、画像は外部ファイル、
  バックアップなし）。それ以外は JSON（Vault 内の `.excalidraw` も JSON のまま）
- バックアップ: `backup/<名前>_backup_YYYYMMDD_HHMMSS.ext`。自動保存は 10 分間隔、手動保存は必ず作る。
  2 週間より古いものは削除、今日以外は各日の最新 1 件だけ残す

## 自動保存と外部更新（フロントエンド、詳細: docs/features.md）

- 要素が変わってから 10 秒後に、内容が保存済みと違えば保存（10 秒以内の変更はまとめる）。タブが非表示になったら即時保存
- `Cmd/Ctrl + S`・保存ボタンは内容が同じでもバックアップ付きで保存
- 編集中は最短 5 秒ごと・保存前は毎回 `GET /api/file-info` で更新日時を確認し、新しければ最新を読み込んで画面を置き換え、
  保存し直す（`.excalidraw`・`.excalidraw.md` 共通。確認ダイアログは出さない）
- 読み込めなかったファイルは、空の図面で上書きしないよう保存しない
- `filepath` がなければ localStorage に保存

## キーボードショートカット（入力欄にフォーカスがあるときは無効）

- `.`: ショートカット一覧ヘルプの表示 / 非表示（カテゴリ切り替え・キーワード検索付き）
- `,`: マーカーとアンダーラインの設定パネル（色・透明度・太さ。localStorage に保存）
- `M`: テキスト選択時はテキスト下半分にマーカー（矩形、既定 `#fef08a`・透明度 50%）を背面に生成してグループ化（再押下で解除）。
  未選択時はマーカー用スタイルで矩形ツールを起動し、描いた矩形が文字に重なれば文字の背面に置いてグループ化。描画後に元のスタイルへ戻す
- `U`: テキスト選択時は下端に下線（直線、既定 `#e03131`・2px）を生成してグループ化（再押下で解除）。
  未選択時は下線用スタイルで直線ツールを起動し、文字に近接すればグループ化。描画後に元のスタイルへ戻す
- `C`: 矢印なしの直線（矢印ツールで描いた矢印の矢じりを消す）
- `N`: マウス位置に基本付箋 / `W`: クリップボードのパス・URL からリンク付箋（`.py` は `cmd python`、`.sh`/`.bat` は `cmd`）
- `Tab`: 選択図形を 四角形 → ひし形 → 円
- `Cmd/Ctrl + S`: 手動保存 / `Cmd/Ctrl + M`: 最前面 / `Cmd/Ctrl + B`: 最背面
- `C`/`M`/`U` の後、描かずに別ツールへ切り替えたら後処理を取り消し、スタイルも戻す

## ヘッダー（右上）

`+` 新規作成（テンプレート `shoki.excalidraw` から） / マーカー・下線の設定 / ショートカット一覧 /
フォルダを開く / VS Code で開く / 手動保存 / SVG で保存

## 図形リンク

`cmd ...` はサーバーでコマンド実行（作業フォルダ = 図面のフォルダ） / `obsidian://` は OS で開く / http(s) は新しいタブ /
`.excalidraw(.md)` はこのアプリの新しいタブ / その他は port 8001 のリダイレクトサービス、なければ OS の既定アプリ。
相対パスは図面のフォルダ基準

## PWA

- `manifest.json`: アプリ名・テーマカラー・表示モード
- `sw.js`: `/api/*` とライブラリはネットワークのみ、ハッシュ付きアセットはキャッシュファースト、その他はネットワークファースト
- 共有ライブラリ `public/excalidraw_lib/my_lib.excalidrawlib` は FastAPI が public/ から直接配信・保存する

## セキュリティ

API に認証はなく、任意パスの読み書き・コマンド実行ができる。信頼できる localhost / LAN / VPN 内だけで使う。

## 主要な依存ライブラリ

- フロントエンド: `@excalidraw/excalidraw` 0.18.1、`react`/`react-dom` ^19.2.7、`vite` ^5.4.14、`vitest` ^1.6.1
- バックエンド: `fastapi` >=0.115.0、`uvicorn` >=0.30.0、`pydantic` >=2.8.0、`lzstring`、`python-multipart`
