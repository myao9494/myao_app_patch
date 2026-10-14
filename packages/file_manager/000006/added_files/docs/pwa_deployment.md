# PWA デプロイメントガイド

## 概要

File ManagerはPWA（Progressive Web App）として動作します。
バックエンド（FastAPI）がフロントエンドのビルド済みファイルを静的配信し、
単一ポート（8001）でアプリ全体が動作します。

注:
- macOS/Linux の `./start.sh` と Windows の `start_windows_prod.bat` の両方で、単一ポート (`8001`) 配信に対応しています
- macOS/Linux は仮想環境利用、Windows は仮想環境なし運用でも対応可能です

## 動作モード

### 開発モード（従来通り）

```bash
./start_dev.sh
```

- **バックエンド**: `http://localhost:8001`（API）
- **フロントエンド**: `http://localhost:5173`（Vite devサーバー）
- Viteのプロキシ設定により、フロントエンドからの`/api`リクエストはバックエンドに転送

### 本番モード（PWA配信）

```bash
./start.sh
```

- **アプリ全体**: `http://localhost:8001`
- バックエンドがフロントエンドのビルド済みファイル（`frontend/dist/`）を配信
- `frontend/dist/`が未ビルドの場合、自動でビルド実行

### Windows 配信モード

`start_windows_prod.bat` も、以下の構成で動作します。

- **アプリ全体**: `http://localhost:8001`
- バックエンドが `frontend/dist/` を静的配信
- API も同一オリジンの `/api` で提供
- 起動時は `backend/.venv_fix`、`backend/.venv`、システム `python` の順で利用可能な Python を選択
- 仮想環境がない Windows では、システム `python` に依存関係が入っていれば起動可能
- Windows の Server Terminal は既定で `cmd.exe` を利用

## フロントエンドのビルド

```bash
cd frontend
npm run build    # または pnpm run build
```

ビルド成果物は `frontend/dist/` に生成されます。

## PWA機能

### マニフェスト

`frontend/public/manifest.json` でPWAの設定を管理：
- アプリ名、アイコン、テーマカラー
- `display: standalone` でネイティブアプリ風の表示

### Service Worker

`frontend/public/sw.js` でキャッシュ戦略を管理：
- **ハッシュ付き静的アセット**（`/assets/名前-ハッシュ.js|css`）: Cache First（高速表示）
- **HTML・sw.js・manifest.json**: 毎回再検証（更新をすぐ反映）
- **APIリクエスト**: Network Only（常に最新データ）

バックエンドも同じ判定でキャッシュヘッダーを付けます（ハッシュ付きは1年 `immutable`、それ以外は1時間）。
Vite のハッシュは英数字に加えて `-` `_` を含むことがあるため、判定の正規表現はそれらも許可しています。

### チャンク分割

- 本体: React / TanStack Query を `react-vendor` / `query-vendor` チャンクに分離（`frontend/vite.config.ts`）。
  アプリを更新してもこれらのファイル名は変わらないため、キャッシュがそのまま使われます。
- Markdown / テキストエディタ、サーバーターミナル（xterm.js）、API テストページは開いたときに読み込みます。
- Quick アプリ: Mermaid は ```mermaid ブロックがあるときだけ読み込みます（初回バンドル約260kB）。

### インストール

ブラウザで `http://localhost:8001` にアクセスすると、アドレスバーにインストールボタンが表示されます。

## アーキテクチャ

```
[ブラウザ] → http://localhost:8001
                ├── /api/*  → FastAPI ルーター（APIレスポンス）
                └── /*      → frontend/dist/ 静的ファイル
                              └── SPA: 未知のパス → index.html
```

## API URLの設定

フロントエンドのAPI URLは `frontend/src/config.ts` の `API_BASE_URL` で管理。
PWA配信時は空文字列（`""`）を使用し、同一オリジンからの相対パスでAPIにアクセスします。

開発時は `vite.config.ts` のプロキシ設定により `/api` リクエストをバックエンドに転送。
