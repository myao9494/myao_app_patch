# 外部連携

このアプリケーション (`file_manager`) は、現在は `file_viewer` の常時起動を前提にせず、FastAPI バックエンド自身が外部連携用 API を提供します。

## 連携の概要

- `file_manager` のフロントエンドは、基本的に同一オリジンの `/api/...` を利用します
- ブラウザや他ツールから直接呼べる互換エンドポイントも、`backend/app/routers/files.py` に実装されています
- 検索系だけは外部サービスと連携します
  - `Index(ALL)`: `file_index_service` (`http://localhost:8080`)
  - `Index(L)` / `Index(R)` / `全文(ALL)`: `Local-fulltext-search` (`http://127.0.0.1:8079`)

## 互換 API

### フルパスで開く

- Endpoint: `GET /api/fullpath`
- Query Param: `path`
- 用途: ファイル種別に応じて、PDF ビューア、Obsidian、Jupyter、Excalidraw、OS 既定アプリなどへ振り分けます

例:

```text
http://localhost:8001/api/fullpath?path=/path/to/file.pdf
```

`path` のパーセントエンコード（`_` を `%5F` と書くなど）は1回だけデコードされます。`%` を含む実在のパスは `%25` と書いてください（二重エンコードは不要）。
フロントエンドの `/?path=...` も同じ扱いです。

### パスを開く

- Endpoint: `GET /api/open-path`
- Query Param: `path`
- 用途:
  - フォルダなら `/?path=...` へリダイレクト
  - ファイルなら種別に応じたアプリ連携、または OS 既定アプリでオープン
  - 存在しないパス（接続できないサーバーでタイムアウトした場合も含む）なら、タブを黙って閉じずに、
    URLデコード済み（日本語が読める）のパスを表示するポップアップ風ページ（HTTP 404）を返す。
    「コピー」ボタンでパスをクリップボードへコピーでき、「OK」を押すとタブを閉じる
    （閉じられないタブではトップ画面へ戻る）

### フォルダを開く

- Endpoint: `POST /api/open-folder`
- Body: `{ "path": "..." }`
- 用途: Finder / Explorer を開きます。ファイルパスが渡された場合は親フォルダを開きます

### Antigravityで開く (macOS)

- Endpoint: `POST /api/open/antigravity`
- Body: `{ "path": "..." }`
- 用途: 指定されたパスを macOS 上の Antigravity アプリで開きます。`Antigravity.app` / `Antigravity IDE.app` の両インストールパスを自動検出し、存在するほうを優先して起動します。

## 前提条件

- `file_manager` バックエンドが起動していること
- 外部検索モードを使う場合のみ、対応サービスが起動していること
  - `file_index_service`: `http://localhost:8080`
  - `Local-fulltext-search`: `http://127.0.0.1:8079`
