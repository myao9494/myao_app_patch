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
  - 画像などの埋め込みファイルも解決して `files` プロパティに含める。
  - フォルダをObsidian Vault外に移動させた場合でも、同一フォルダ直下やサブフォルダ内の画像を自動検出・解決し、リンク切れを防ぐ。

## PWA配信仕様

### バックエンドからのフロントエンド配信
- バックエンド(FastAPI, port 3001)が `dist/` ディレクトリの静的ファイルを配信
- APIルート（`/api/*`）が優先され、その他のリクエストは静的ファイルを返す
- ルート(`/`)は`dist/index.html`を返す（SPAフォールバック）

### PWA構成
- `manifest.json`: アプリ名、テーマカラー、表示モード等を定義
- `sw.js`: Service Worker（キャッシュファースト/ネットワークファースト戦略）
- `API_BASE_URL`: 常に相対パス。本番は同一オリジンのFastAPI、開発はVite proxy経由

### 起動方法
- **本番(デプロイ用)**: `./start_servers.sh` (起動時に毎回フロントエンドをビルド。ビルド成功後、port 3001の既存待受を終了してFastAPIを再起動し、HTTP応答後に起動完了を表示)
- **開発**: `./start_dev.sh` (Vite port 3001 + FastAPI port 8008。起動時に既存プロセスを自動終了してポート解放し、APIはViteがproxy)
