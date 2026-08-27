# 仕様書

## バックエンド API 仕様

### ファイル読み込み (`GET /api/load-file`)
- **対応フォーマット**: `.excalidraw`, `.excalidraw.md`
- **挙動**:
  - 指定されたパスのファイルを読み込み、JSONデータを返す。
  - **空ファイル対応**: ファイルが空（サイズ0または空白のみ）の場合、デフォルトの初期状態（要素なしのExcalidrawデータ）を返す。これにより新規作成時のエラーを防ぐ。
  - **エラーハンドリング**:
    - ファイルが存在しない場合: 404 Not Found
    - JSONが無効な場合: 400 Bad Request
    - その他のエラー: 500 Internal Server Error
- **Obsidian互換性**:
  - `.excalidraw.md` ファイルの場合、Markdown内のJSONブロックを抽出して返す。
  - 画像などの埋め込みファイルは、インデックス辞書 `.obsidian/plugins/obsidian-sidebar-explorer/image_paths.json` を用いて解決し、`files` プロパティに含める。
  - **Obsidian外移動対応**: フォルダをVault外に移動させた場合でも、同一フォルダ直下やサブフォルダ（`attachments`, `assets`, `images` 等）に画像があれば自動検出し、URLデコード・拡張子補完・大文字小文字の違いを吸収して正しく画像を表示する。

## PWA配信仕様

### バックエンドからのフロントエンド配信
- バックエンド(FastAPI, port 3001)が `dist/` ディレクトリの静的ファイルを配信
- APIルート（`/api/*`）が優先され、その他のリクエストは静的ファイルを返す
- ルート(`/`)は`dist/index.html`を返す（SPAフォールバック）

### PWA構成
- `manifest.json`: アプリ名、テーマカラー、表示モード等を定義
- `sw.js`: Service Worker（キャッシュファースト/ネットワークファースト戦略）
- `API_BASE_URL`: 常に相対パス。本番は同一オリジン、開発はVite proxyを使用

### 起動方法
- **本番(デプロイ用)**: `./start_servers.sh` (毎回フロントエンドをビルドし、成功後にport 3001の既存待受を終了してFastAPIを再起動し、HTTP応答後に起動完了を表示)
- **開発**: `./start_dev.sh` (Vite port 3001 + FastAPI port 8008。起動時に既存プロセスを自動終了してポート解放し、APIはViteがproxy)

## 主要な依存ライブラリのバージョン
- **フロントエンド**
  - `@excalidraw/excalidraw`: `0.18.1`
  - `react`/`react-dom`: `^19.2.7`
  - `vite`: `^5.4.14`
  - `vitest`: `^1.6.1`
- **バックエンド**
  - `fastapi`: `>=0.115.0`
  - `uvicorn`: `>=0.30.0`
  - `pydantic`: `>=2.8.0`
