# CLAUDE.md - File Manager プロジェクト

## プロジェクト概要

React + FastAPIによる軽量ファイルマネージャー。
`/Users/username/projects/file_viewer`（Flask版）を参考に、モダンな技術スタックで再構築。

## 開発方針

### TDD（テスト駆動開発）

1. テストを先に書く
2. テスト失敗を確認
3. 実装してテストを通す
4. リファクタリング

### コード規約

- 各ファイル冒頭に日本語コメントで仕様を記述
- TypeScript: 厳密な型定義を使用
- Python: 型ヒントを使用

## プロジェクト構造

```
file_manager/
├── backend/           # FastAPI バックエンド
│   ├── app/
│   │   ├── main.py    # エントリーポイント
│   │   ├── config.py  # 設定（ポート8001）
│   │   └── routers/   # APIルーター (files.py, clipboard.py)
│   └── tests/         # pytest テスト
├── frontend/          # React フロントエンド
│   └── src/
│       ├── api/       # APIクライアント
│       ├── components/# UIコンポーネント
│       ├── hooks/     # カスタムフック
│       └── types/     # 型定義
├── docs/              # ドキュメント
└── CLAUDE.md          # このファイル
```

## 開発サーバー

| サービス | ポート | コマンド |
|----------|--------|----------|
| Backend | 8001 | `PYTHONPATH=. python -m uvicorn app.main:app --reload --port 8001` |
| Frontend | 5173 | `npm run dev` |

### 起動スクリプト
一括起動・ポート解放機能付きのスクリプトを使用できます：
- **本番モード（PWA配信）**: `./start.sh`
- **開発モード**: `./start_dev.sh`
- **Windows**: `start.bat` (開発), `start_windows_prod.bat` (本番)

詳細は `docs/startup_scripts.md` および `docs/server_setup.md` を参照。

### PWA配信モード

本番モード（`./start.sh`）では、バックエンドがフロントエンドのビルド済みファイル（`frontend/dist/`）を配信します。

- **単一ポート(8001)**でアプリ全体が動作
- PWAとしてインストール可能（ホーム画面に追加）
- フロントエンドのAPI URLは相対パス（`config.ts`の`API_BASE_URL = ""`）
- 開発時はViteのプロキシ設定で`/api`をバックエンドに転送

詳細は `docs/pwa_deployment.md` を参照。

## 環境変数設定

デフォルトのベースディレクトリは環境変数で設定します。これにより、異なる環境（自宅macOS / 会社Windows）でも`.env`ファイルを変更するだけで動作します。

### 設定方法

1. `backend/.env.example` を `backend/.env` にコピー
2. `FILE_MANAGER_BASE_DIR` を環境に合わせて設定

### 設定例

**macOS/Linux:**
```env
FILE_MANAGER_BASE_DIR=/Users/username/Documents
FILE_MANAGER_OBSIDIAN_BASE_DIR=/Users/mine/000_work/obsidian-dagnetz/01_data
```

**Windows:**
```env
FILE_MANAGER_BASE_DIR=C:\Users\username\Documents
```

**Windowsネットワークフォルダ:**
```env
FILE_MANAGER_BASE_DIR=\\server\share\folder
```

### 動作の仕組み

1. バックエンド起動時に `.env` から `FILE_MANAGER_BASE_DIR` を読み込み
2. フロントエンドは起動時に `/api/config` から設定を取得
3. フロントエンドはビルド済み（dist）でも動作（バックエンドから動的に取得するため）

## サーバーセットアップ

1. **バックエンドの依存関係インストール**
   ```powershell
   cd backend
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   ```
2. **フロントエンドの依存関係インストール**
   ```powershell
   cd frontend
   npm install
   ```
3. **開発サーバーの起動 (両方)**
   ```powershell
   .\start.bat
   ```

## URLパラメータ

フロントエンドは起動時にURLクエリパラメータからパスを読み取ります。

### 基本的な使用方法

```
http://localhost:5173/?path=/Users/username/Documents
```

### Windowsネットワークフォルダ（UNCパス）

```
http://localhost:5173/?path=\\server\share\folder
```

URLエンコードが必要な場合：
```
http://localhost:5173/?path=%5C%5Cserver%5Cshare%5Cfolder
```

### ファイルパスの自動処理

ファイルパスがURLで指定された場合、自動的に親フォルダにリダイレクトされます：

```
http://localhost:5173/?path=/Users/username/Documents/file.txt
↓ 自動リダイレクト
http://localhost:5173/?path=/Users/username/Documents
```

この機能により、ファイルパスを直接URLに貼り付けても、そのファイルが入っているフォルダが表示されます。

### エラー処理

存在しないパスが指定された場合、以下の動作をします：

**URLパラメータで存在しないパスを指定した場合:**
- エラートースト通知を表示
- URLパラメータを削除
- デフォルトパス（`/Users/username/projects`）に移動

**パス入力フィールドで存在しないパスを入力した場合:**
- エラートースト通知を表示
- 入力フィールドを元のパスに戻す
- 現在のパスを維持

トースト通知は自動的に5秒後に消えますが、×ボタンで手動で閉じることもできます。

### 注意事項

- **クロスプラットフォーム**: バックエンドが動作しているOSのパス形式を使用してください
  - macOS/Linux: `/Users/name/folder`
  - Windows: `C:\Users\name\folder` または `\\server\share\folder`
- **パス形式**: 絶対パスのみ対応（相対パスはベースディレクトリからの相対パスとして扱われます）
- **セキュリティ**: パストラバーサル（`..`）は検出され拒否されます
- **ファイル指定**: ファイルパスを指定すると親フォルダに自動リダイレクトされます

## 参照プロジェクト

- **file_viewer**: `/Users/username/projects/file_viewer`
  - `app.py`: メインFlaskアプリ
  - `templates/base.html`: ツールバーアイコンの参照元

## 主要コンポーネント

### App.tsx

メインレイアウトおよびグローバル設定。以下の機能を管理：

- ヘッダーメニュー（ハンバーガーメニュー）
  - テーマ切り替え（Light/Dark）
  - Text Files オープン設定（Web App Editor / Visual Studio Code）
  - Markdown オープン設定（Web App Editor / Obsidian or Web App Editor / Obsidian or Visual Studio Code）
  - APIタイムアウト設定（設定値はバックエンド settings.json に保存、デフォルト10秒）
  - リンク置換設定（パスマッピング編集モーダル、入力フォーム/JSONハイブリッド、新サーバー接続確認テスト機能付き）
  - ストレージリセット（localStorage初期化）

### FileList.tsx

メインのファイル一覧コンポーネント。以下の機能を含む：

- ツールバー（base.html準拠のアイコン）
- 検索バー
- フィルタバー（ラベル簡略化、1行表示、ファイル・フォルダ切替対応）
- **Obsidian 今日のフォルダ**: 年月日（YYYY/MM/DD）のフォルダを自動作成して開く
- ファイル/フォルダテーブル（パスコピー用アイコン付き）
- ドラッグ&ドロップ
  - **Shift+ドラッグ**: テーブル行上でも範囲選択開始可能（ホバー効果を無視）
- **同一ペイン内移動の確認**:
  - 同一ペイン内でのファイル/フォルダ移動時のみ確認ポップアップを表示（誤操作防止）
  - 異なるペイン間移動は確認なし
- **ファイルダブルクリック処理**（バックエンドの`/api/open/smart`で判定）:
  - `.excalidraw*` → Excalidraw (localhost:3001)
  - `.ipynb` → JupyterLab (localhost:8888/lab/tree)
  - `.md`（obsidianあり） → Obsidian URI
  - `.md`（obsidianなし） → アプリ内Markdownエディタ
  - `.pdf` → **Mac**: ブラウザの別タブで開く / **Windows**: OSデフォルトアプリ
  - その他 → OSデフォルトアプリ（Preview、Excel等）
- 右クリックメニュー
- Markdownエディタモーダル（新規作成・編集）
- **戻る/進むボタン**: カーソル位置と選択状態も履歴と一緒に保存・復元
- **キーボードショートカット**: Ctrl+Left(戻る), Ctrl+Right(進む), Ctrl+Up(上の階層へ), a(フォルダ追加、左/中ペインのみ)

### FileSearch.tsx

ファイル検索コンポーネント（Everything風）。以下の機能を含む：

- **3つの検索モード**:
  - **Live**: リアルタイム検索（指定フォルダ以下を検索）
  - **Index**: インデックス検索（指定フォルダ以下を高速検索、階層指定対応）
  - **Index(ALL)**: 全インデックス検索（Everything風、全ての監視パスを検索）★デフォルト
- リアルタイム検索（デバウンス800ms、IME入力中は保留・確定時に即時実行）
- タイプフィルタボタン（全、F、D）でファイル/フォルダを絞り込み
- 検索階層の指定（+/-ボタンで調整、初期値1、0=無制限）
- 除外パターンの設定（node_modules, .git等、カンマ区切り）
- 各結果のパスコピー用アイコンボタンを追加
- **リンクボタン**: 各検索結果にリンクコピーボタン（🔗アイコン）を追加
- **右クリックメニュー**: 「リンクを開く」オプションでパスをブラウザで開く
- フォルダ/ファイルの分離表示
- コンパクトなUI設計（検索ペインはウィンドウ幅の30%）
- 監視パス管理（追加/削除、スキャン状態表示）
- **日本語部分一致検索対応**（例: 「申告」→「確定申告.pdf」）

### 検索インデックス（外部サービス連携）

Index/Index(ALL)モードは外部の**File Index Service**に接続します。

**外部サービスリポジトリ**: `/Users/username/projects/file_index_service`

| 検索モード | 接続先 | 説明 |
|-----------|--------|------|
| Live | file_manager内部API | リアルタイムファイル検索 |
| Index | 外部サービス (port 8080) | 指定パス以下のインデックス検索 |
| Index(ALL) | 外部サービス (port 8080) | 全監視パスの検索（デフォルト） |

**接続設定:**
- サービスURL: `http://localhost:8080`（デフォルト）
- 設定場所: 検索ペインの設定ボタン（⚙️）→「インデックスサービスURL」
- 設定はlocalStorageに保存されます

**ステータス表示:**
- ● 準備完了 (ファイル数): サービス接続済み、インデックス準備完了
- ○ 準備中...: サービス接続済み、インデックス構築中
- ✕ 接続エラー: サービスに接続できない

**Windows環境での使用:**
- Windows版Everythingを使用する場合は、EverythingのHTTPサーバーを有効化
- ポート8080で起動し、このfile_managerから接続可能

**インデックス技術仕様:**
SQLite FTS5を使用した高速検索システム。クエリ長に応じて最適なインデックスを自動選択：

| クエリ長 | インデックス | 速度 | 説明 |
|---------|-------------|------|------|
| 3文字以上 | FTS5 trigram | ~0.03秒 | 日本語含む部分一致 |
| 2文字 | bigramテーブル | ~0.06秒 | 2文字ペア完全一致 |
| 1文字 | LIKE検索 | 遅い | フォールバック |

**関連ファイル（フロントエンド）:**
- `frontend/src/api/indexService.ts`: 外部サービスAPIクライアント
- `frontend/src/hooks/useFiles.ts`: 外部サービス用フック（useExternalIndexSearch等）
- `frontend/src/components/FileSearch.tsx`: 検索コンポーネント（モード切替対応）

### API エンドポイント

#### ファイル操作

| メソッド | パス | 説明 | 実装 |
|----------|------|------|------|
| GET | /api/files | ファイル一覧取得 | 済 |
| GET | /api/path-info | パス種別判定（ファイル/ディレクトリ） | 済 |
| GET | /api/search | ファイル検索 | 済 |
| DELETE | /api/delete/{path} | ゴミ箱に移動 | 済 |
| POST | /api/create-folder | フォルダ作成 | 済 |
| POST | /api/create-file | ファイル作成 | 済 |
| POST | /api/update-file | ファイル更新 | 済 |
| POST | /api/rename | リネーム | 済 |
| POST | /api/move | 移動 | 済 |
| POST | /api/copy | コピー | 済 |
| POST | /api/clipboard/copy | クリップボードにコピー (Windows) | 済 |
| POST | /api/upload | ファイルアップロード | 済 |
| GET | /api/obsidian/daily-path | Obsidian今日のフォルダ取得・作成 | 済 |
| GET | /api/config | 設定の取得（apiTimeout含む） | 済 |
| POST | /api/config/preferences | 設定の保存（apiTimeout含む） | 済 |

#### インデックス管理（外部サービス）

インデックス管理APIは外部サービス（file_index_service）に移行しました。

| メソッド | パス | 説明 |
|----------|------|------|
| GET | http://localhost:8080/status | インデックス状態取得 |
| POST | http://localhost:8080/rebuild | インデックス再構築 |
| GET | http://localhost:8080/paths | 監視パス一覧 |
| POST | http://localhost:8080/paths | 監視パス追加 |
| DELETE | http://localhost:8080/paths?path=... | 監視パス削除 |

詳細は `/Users/username/projects/file_index_service/README.md` を参照。

## テスト実行

```bash
# バックエンド
cd backend
source .venv/bin/activate
PYTHONPATH=. pytest tests/ -v

# フロントエンド（未実装）
cd frontend
npm test
```

## セキュリティ考慮事項

- パストラバーサル対策: `normalize_path()`関数で実装
- CORS: 全オリジン許可（個人利用前提）
- 本番環境では適切なオリジン制限が必要

## 実装済み機能（更新）
 
 1. バックエンドAPI: 
    - ファイル操作: get, delete, create-folder, create-file, update-file, rename
    - **安全な移動 (Safe Move)**: コピー → 検証 → 削除 のプロセスによりデータ消失を防ぐ。並列コピー対応。
    - **一括操作**: move/batch, copy/batch (並列処理)
 2. ドラッグ&ドロップのバックエンド連携 (ドラッグによる移動)
 3. タイルビュー表示（未実装）
 4. **ファイルアップロード/ダウンロード**:
    - ダウンロード: ネイティブ実装、ブラウザ経由
    - アップロード: **Explorerからのドラッグ&ドロップ対応** (OSからのファイルドロップ)
 5. **OS連携 (Windows/macOS)**:
    - **クリップボード連携**: アプリ内のコピー (Ctrl+C) をOSクリップボード (Explorer) に同期。
    - **外部アプリ**: VSCode, Explorer, Antigravity（macOSにおいて `Antigravity.app` / `Antigravity IDE.app` の両インストールパスを自動検出し、存在するほうを優先的に起動するように拡張）, Jupyter, Excalidraw, Obsidian, ゴミ箱, Test Folder
    - **ファイル削除**: Windows API (SHFileOperationW) を使用し、Explorerと同一の挙動 (確実なゴミ箱への移動、システムロックの対応) を実現。
    - **削除失敗時の自動回復機能**: ファイルが他のプロセス（Excelなど）によりロックされて削除できない場合、`Rstrtmgr.dll` (Restart Manager API) を使用してロックしているプロセス(PIDおよびプロセス名)を自動検知します。ユーザーの同意ダイアログをフロントエンドで表示し、承認を得たうえでプロセスを強制終了 (TerminateProcess / SIGTERM) させてから削除をリトライする機能を有しています。
 6. **フォルダ履歴検索**:
    - `Ctrl + R` で起動し、過去に移動したフォルダ履歴をインクリメンタル検索可能なモーダルを追加。
    - 独立したUIコンポーネント (`FolderHistoryModal`) を使用し、フルテキスト検索と類似のUXを実現。
 7. **フィルタ機能の拡張**:
    - ファイル一覧の「常用」拡張子フィルタ（デフォルト設定含む）に `.bat` および `.sh` を追加。
 8. **APIリクエスト タイムアウト制御とフリーズ防止**:
    - ネットワークドライブ遅延対策として、APIリクエストにデフォルト10秒のタイムアウトを適用。
    - バックエンドの `normalize_path` のファイルシステムアクセス（I/O）を排除し、文字列正規化に変更することでパス解決時のハングを防止。
    - 主要API（一覧取得、種別判定、スマートオープン等）のI/O処理をスレッドプールに逃がし、設定した `apiTimeout` の秒数で `asyncio.wait_for` によるタイムアウト制限を適用。
    - ハンバーガーメニューから設定変更でき、値はバックエンドの `settings.json` に保存される。
    - `/api/upload` などの大容量アップロードリクエストは自動的にタイムアウト適用を除外。
 9. **リンク置換（URL・パスマッピング）によるリンク切れ防止**:
    - DNSがない社内ネットワークでのサーバーIP・ホスト名変更（5年周期など）に対応するため、古いリンク（UNCパスやWeb URLなど）を自動で最新の有効なリンクに変換する機能を実装。
    - 設定は `{ "新サーバーのベースアドレス": "旧サーバーアドレス1,旧サーバーアドレス2" }` 形式で保持し、バックエンドで自動展開して適用。
    - ハンバーガーメニュー内の「リンク置換設定の編集...」ボタンから、入力フォーム（簡易UI）とバリデーション機能付きのJSON直接編集（詳細UI）のハイブリッド形式で編集可能。右上の「新サーバーの接続確認」ボタンから、入力された新サーバーの接続テスト（ローディング、成功✅、失敗⚠️とツールチップによるエラー詳細表示）を実行できる。
    - ファイルオープン時（`open_smart`等）にURLに変換された場合は、パス正規化をバイパスして即座にブラウザや外部アプリで直接開く処理へ移行。

## ドキュメント更新

変更時は以下を更新すること：

- `docs/architecture.md`: アーキテクチャ変更時
- `README.md`: 機能追加・セットアップ変更時
- `CLAUDE.md`: 開発方針変更時
- `docs/startup_scripts.md`: 起動スクリプトの仕様変更時
