# アーキテクチャ設計書

## 概要

React + FastAPIによる軽量ファイルマネージャー。個人利用・VPN内利用を前提とした用途特化UI。
3ペイン構成（左パネル + 中央パネル + 検索パネル、比率35:35:30）で、ドラッグ&ドロップによるファイル操作とEverything風の高速検索をサポート。

**注**: `Index(L)` / `Index(R)` と `全文(ALL)` は Local-fulltext-search、`Index(ALL)` は file_index_service を利用します。

## システム構成

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Frontend (React + Vite)                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                            App.tsx (3-pane)                              │ │
│  │  ┌────────────┐  ┌────────────┐  ┌───────────────────────────────────┐ │ │
│  │  │ Left Pane  │  │Center Pane │  │      Search Pane (30%)            │ │ │
│  │  │  (35%)     │  │  (35%)     │  │  ┌─────────────────────────────┐  │ │ │
│  │  │  FileList  │  │  FileList  │  │  │      FileSearch             │  │ │ │
│  │  │ - Toolbar  │  │ - Toolbar  │  │  │  - Type filters (全/F/D)    │  │ │ │
│  │  │ - Search   │  │ - Search   │  │  │  - Depth control (+/-)     │  │ │ │
│  │  │ - Filter   │  │ - Filter   │  │  │  │  - Regex toggle (.*ボタン)  │  │ │ │
│  │  │ - Table    │  │ - Table    │  │  │  - Real-time search        │  │ │ │
│  │  └────────────┘  └────────────┘  │  │  - Results table           │  │ │ │
│  │                                   │  └─────────────────────────────┘  │ │ │
│  │                                   └───────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                        │
│  ┌───────────────────────────────────▼──────────────────────────────────────┐│
│  │                          TanStack Query                                   ││
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ ││
│  │  │  useFiles    │  │ useDelete    │  │useCreateFolder│ │useSearchFiles│││
│  │  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘ ││
│  └──────────────────────────────────────────────────────────────────────────┘│
│                          │                              │                     │
│  ┌───────────────────────▼────────────────┐  ┌──────────▼──────────────────┐│
│  │   API Client (files.ts)                │  │ API Client (index/fulltext) ││
│  │   /api (同一オリジン)                  │  │ /api/index, /api/fulltext...││
│  └────────────────────────────────────────┘  └─────────────────────────────┘│
└───────────────────────┬──────────────────────────────────┬───────────────────┘
                        │ HTTP (同一オリジン)              │ HTTP
                        ▼                                  ▼
        ┌───────────────────────────────┐  ┌──────────────────────────────────┐
        │  Backend (FastAPI:8001)       │  │ file_index_service (FastAPI:8080)│
        │  ┌─────────────────────────┐  │  │  - Everything互換API             │
        │  │      main.py            │  │  │  - SQLite FTS5インデックス       │
        │  │  - Host/Origin検証      │  │  │  - ファイル監視（watchdog）      │
        │  │  - CORS / 静的配信      │  │  │  - 並列スキャナー                │
        │  └─────────────────────────┘  │  └──────────────────────────────────┘
        │              │                 │                  │
        │  ┌───────────▼──────────────┐ │                  │
        │  │   routers/ (API入口)     │ │                  │
        │  │  files / operations /    │ │                  │
        │  │  viewer / launcher / ... │ │                  │
        │  └───────────┬──────────────┘ │                  │
        │  ┌───────────▼──────────────┐ │                  │
        │  │   services/ (処理本体)   │ │                  │
        │  │  paths / trash /         │ │                  │
        │  │  deletion / transfer /   │ │                  │
        │  │  fileio / obsidian       │ │                  │
        │  └──────────────────────────┘ │                  │
        └───────────────┬────────────────┬───────────────────────────┘
                        │                │
                        ▼                ▼
            ┌──────────────────────┐   ┌─────────────────────────────┐
            │   File System        │   │ Local-fulltext-search:8079 │
            │   (BASE_DIR)         │   │ 全文検索API / 索引更新     │
            │ /Users/.../projects  │   └─────────────────────────────┘
            └──────────────────────┘
```

## ディレクトリ構造

```
file_manager/
├── backend/                          # FastAPI バックエンド (Port 8001)
│   ├── app/
│   │   ├── main.py                   # アプリ本体: ルーター登録・設定API・PWA静的配信
│   │   ├── config.py                 # 環境変数設定・UI設定ファイル（settings.local.json）の読み書き
│   │   ├── security.py               # Host / Origin 検証ミドルウェア（docs/security.md）
│   │   ├── schemas.py                # 共有スキーマ（FileItem, OpenRequest）
│   │   ├── task_manager.py           # 非同期タスク（進捗・キャンセル）の管理
│   │   ├── routers/                  # API の入口（入力の受け取りとレスポンス）
│   │   │   ├── files.py              # 一覧・検索・作成/編集・アップロード・解凍・Git状態
│   │   │   ├── operations.py         # 削除・移動・コピー・タスク進捗
│   │   │   ├── viewer.py             # ダウンロード・PDF/HTML/画像のインライン表示
│   │   │   ├── launcher.py           # 外部アプリ起動・/api/fullpath・/api/open-path
│   │   │   ├── everything.py         # インデックス検索（Everything / file_index_service 中継）
│   │   │   ├── fulltext.py           # 全文検索（Local-fulltext-search 中継）
│   │   │   ├── history.py            # フォルダ履歴
│   │   │   ├── clipboard.py          # Windows クリップボード連携
│   │   │   └── terminal.py           # サーバーターミナル（WebSocket + PTY）
│   │   └── services/                 # 処理本体（docs/file_safety.md）
│   │       ├── paths.py              # パス正規化・パス置換・I/Oスレッド実行
│   │       ├── trash.py              # ゴミ箱移動・ネットワークドライブ判定・ロック検出
│   │       ├── deletion.py           # 削除（ゴミ箱優先、完全削除へフォールバックしない）
│   │       ├── transfer.py           # 移動・コピー（衝突時は変更しない・検証後に移動元を削除）
│   │       ├── fileio.py             # アトミック書き込み・重複しない名前・名前検証
│   │       └── obsidian.py           # Vault 探索・ファイル名索引・Excalidraw プレビュー
│   ├── tests/                        # pytest（test_file_safety.py, test_security.py ほか）
│   ├── settings.json                 # 以前の設定ファイル（settings.local.json 作成前の初期値）
│   ├── pyproject.toml / uv.lock      # 依存関係（uv）・ruff / pytest 設定
│   └── requirements.txt              # 依存関係（pip）
│
├── frontend/                         # React フロントエンド（PC向け本体）
│   └── src/
│       ├── App.tsx                   # 3ペインレイアウト・ハンバーガーメニュー・グローバルショートカット
│       ├── config.ts                 # /api/config から設定を取得・保存
│       ├── api/                      # APIクライアント（files.ts, indexService.ts, fulltextIndexService.ts, clipboard.ts）
│       ├── components/               # UI（FileList, FileSearch, 各種モーダル, ServerTerminal など）
│       │   ├── FileList.tsx          # 1ペイン分のファイル一覧（状態・キーボード操作・フォルダ移動）
│       │   ├── FileList.ui.test.tsx  # FileList の画面操作テスト（jsdom・偽バックエンド）
│       │   └── fileList/             # FileList の部品とフック（下記「FileList の構成」）
│       ├── test/                     # 画面操作テスト用の偽バックエンド・描画ヘルパー
│       ├── contexts/                 # Toast / 操作履歴(Undo) / フォルダ履歴 / ズーム
│       ├── hooks/                    # TanStack Query フック（useFiles）・Undo/Redo
│       ├── types/file.ts             # 型定義（FileItem, BatchItemResult など）
│       └── utils/                    # 純粋関数（テスト付き）: batchResult, fetchTimeout, pathUtils など
│
├── frontend-quick/                   # スマホ向け Quick アプリ（/quick/ で配信）
├── docs/                             # ドキュメント
└── CLAUDE.md                         # 開発ガイドライン
```

## コンポーネント設計

### App.tsx - 3ペインレイアウト

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Header: File Manager [🍔] [☀/🌙]                                         │
├────────────────────┬────────────────────┬──────────────────────────────────┤
│   Left Pane (35%)  │  Center Pane (35%) │   Search Pane (30%)              │
│   (FileList)       │   (FileList)       │   (FileSearch)                   │
│                    │                    │                                  │
│ ┌────────────────┐ │ ┌────────────────┐ │ ┌──────────────────────────────┐ │
│ │ Toolbar        │ │ │ Toolbar        │ │ │ [OFF][Live][Index(Left)]...  │ │
│ ├────────────────┤ │ ├────────────────┤ │ ├──────────────────────────────┤ │
│ │ Current Path   │ │ │ Current Path   │ │ │ 🔍 キーワード検索            │ │
│ ├────────────────┤ │ ├────────────────┤ │ │ 📄 ファイル名フィルタ [.*]   │ │
│ │ Search Bar     │ │ │ Search Bar     │ │ ├──────────────────────────────┤ │
│ ├────────────────┤ │ ├────────────────┤ │ │ [全][F][D] [-][∞][+]         │ │
│ │ Filter Bar     │ │ │ Filter Bar     │ │ ├──────────────────────────────┤ │
│ ├────────────────┤ │ ├────────────────┤ │ ├──────────────────────────────┤ │
│ │                │ │ │                │ │ │ Results: 45 files            │ │
│ │  File Table    │ │ │  File Table    │ │ │ 📁 folder1    -    2024/12   │ │
│ │ (folders first)│ │ │ (folders first)│ │ │ 📁 folder2    -    2024/12   │ │
│ │                │ │ │                │ │ │ 📄 file1.txt  12KB 2024/12   │ │
│ └────────────────┘ │ └────────────────┘ │ └──────────────────────────────┘ │
└────────────────────┴────────────────────┴──────────────────────────────────┘
```

**URLパラメータ対応:**

- `?path=/absolute/path` でフォルダを指定可能
- ファイルパスが指定された場合は親フォルダにリダイレクト
- URLデコード処理により、WindowsのUNCパス（`\\server\share`）も対応
- パラメータがない場合はバックエンド設定の開始ディレクトリを使用

**ハンバーガーメニュー:**

- Text Files / Markdown のオープン設定（Web App Editor / Visual Studio Code / Obsidian）
- Safe Move (Checksum): 移動・コピー時に SHA256 で検証する
- Debug Mode: バックエンドに詳細ログを出す
- API Timeout (sec): 読み取り系APIのタイムアウト（既定10秒）
- Folder Date Max Items: フォルダ最新日時（`D`キー）の走査上限（既定20,000）
- Default Text Extension: `T` キーで作るテキストファイルの既定拡張子
- リンク置換設定の編集（docs/path_mapping.md）
- テーマ切り替え（Light/Dark）、ストレージリセット（localStorage初期化）

設定値は `backend/settings.local.json` に保存されます（Safe Move / Debug Mode はブラウザの localStorage）。

**注**: インデックス再構築は外部サービス（file_index_service:8080）のUIで実行します。

### FileList の構成

`FileList.tsx` は状態（現在のフォルダ・選択・カーソル・絞り込み）とキーボード操作・フォルダ移動を持ち、
各機能は `components/fileList/` に分けています。

| ファイル | 役割 |
|----------|------|
| `FileListToolbar` / `FileListPathBar` / `FileListHistorySearch` / `FileListSearchBar` / `FileListTable` | 表示部品（ツールバー・パス・フォルダ履歴検索・名前検索・一覧テーブル） |
| `useBatchFileOperations` + `FileListOperationModals` | 削除・移動・コピー（削除確認・上書き確認・進捗モーダル・Undo 記録） |
| `useFileCreation` + `FileListCreateModals` | フォルダ・テキスト・Markdown・Excalidraw の新規作成 |
| `useFileOpener` | ファイルを開く（PDF・画像プレビュー・Markdown/テキストの設定・`/api/open/smart`） |
| `useFileListDragDrop` | アプリ内ドラッグでの移動（同一ペインは確認）・OS からのアップロード |
| `useDragSelect` + `FileListSelectionBox` | 範囲選択（ラバーバンド） |
| `useSectionFocus` | ツールバー → パス → フィルタ → 履歴検索 → 検索 → 一覧 のキーボード移動 |
| `useFolderInsights` | G キーの Git 状態・D キーのフォルダ最新更新日 |
| `useFileListEditors` + `FileListEditorModals` | 内蔵エディタ（Markdown・テキスト/コード） |
| `useExternalAppActions` | VS Code・Explorer・Obsidian などの外部アプリ連携 |
| `sharedState` | 左右ペインで共有するドラッグ中の項目とアプリ内クリップボード |

戻る/進む履歴（`utils/navigationHistory`）、絞り込み・並べ替え（`utils/fileListFilter`）、
ファイル名の組み立て（`utils/textFileName`）は純粋関数として単体テストしています。

### FileList.tsx - ツールバーアイコン

file_viewer/templates/base.htmlに準拠したアイコン配置：

| アイコン | 機能 | 実装状況 |
|----------|------|----------|
| ArrowLeft / ArrowRight | 戻る / 進む | 実装済み |
| ChevronUp | 上の階層へ移動 | 実装済み |
| Home | ホームへ移動 | 実装済み |
| Network | ネットワークドライブへ移動 | 実装済み |
| ClipboardPaste | クリップボードから開く | 実装済み |
| Download | ダウンロード | 実装済み |
| Code | VSCodeで開く | 実装済み |
| Rocket | Antigravityで開く | 実装済み |
| Obsidian アイコン | Obsidian 今日のフォルダを開く | 実装済み |
| FolderOpen | Finder / Explorer で開く | 実装済み |
| Jupyter アイコン | Jupyterで開く | 実装済み |
| Excalidraw アイコン | Excalidrawで開く | 実装済み |
| Markdown アイコン | Markdownファイル作成 | 実装済み |
| Gem | Obsidianで開く | 実装済み |
| FolderPlus | フォルダ作成 | 実装済み |
| Trash2 | 削除 | 実装済み |
| RefreshCw | 更新 | 実装済み |
| FlaskConical | テストフォルダを開く | 実装済み |

## API設計

### 内部API（file_manager:8001）

パスは絶対パス（Windows の UNC パス `\\server\share` を含む）またはベースディレクトリからの相対パスで指定します。
入力パスにはリンク置換設定（`pathMappings`、docs/path_mapping.md）が適用されます。

#### 一覧・検索・編集（`routers/files.py`）

| メソッド | パス | 説明 |
|----------|------|------|
| GET | /api/files?path= | フォルダ内の一覧（ファイルを指定した場合は親フォルダ） |
| GET | /api/path-info?path= | パス種別 `file` / `directory` / `not_found` |
| GET | /api/search | ファイル名のライブ検索（`query`, `depth`(0=無制限), `ignore`, `max_results`, `file_type`） |
| POST | /api/folder-latest-modified | フォルダ配下の最新更新日時（走査上限・時間上限あり） |
| POST | /api/git-folder-statuses | 複数フォルダの Git 変更・ahead/behind を並列取得 |
| POST | /api/count-files | ファイル数カウント（指定階層まで） |
| GET | /api/obsidian/daily-path | Obsidian の今日のフォルダ（YYYY/MM/DD）を作成して返す |
| POST | /api/unzip | ZIP を同じ場所の新しいフォルダへ解凍 |
| POST | /api/create-folder | フォルダ作成（同名があれば 400） |
| POST | /api/create-file | ファイル作成（同名があれば 400） |
| POST | /api/update-file | ファイル内容の更新（アトミック書き込み） |
| POST | /api/upload?path= | アップロード（同名ファイルは別名で保存、`renamed` に記録） |
| POST | /api/rename | リネーム（同名があれば 400） |
| GET | /api/file-content?path= | テキストファイル内容の取得 |
| GET | /api/test-folder-path | テスト用フォルダのパス |

#### 削除・移動・コピー（`routers/operations.py`）

| メソッド | パス | 説明 |
|----------|------|------|
| DELETE | /api/delete | 1件削除（JSON ボディ `{path, async_mode, force_kill_pids}`）。ロック時は 409 + `locked_by` |
| POST | /api/delete/batch | 一括削除（`{paths, async_mode, force_kill_pids}`） |
| POST | /api/move | 1件移動（Undo/Redo 用。`dest_path` が既存フォルダならその中へ、それ以外はその名前で移動。同名があれば 409） |
| POST | /api/move/batch | 一括移動（`{src_paths, dest_path, overwrite=false, verify_checksum, async_mode}`） |
| POST | /api/copy/batch | 一括コピー（同上） |
| GET | /api/tasks/{id}/progress | 非同期タスクの進捗（完了時は `result` を含む） |
| POST | /api/tasks/{id}/cancel | 非同期タスクのキャンセル |

一括操作の結果（同期レスポンス・非同期タスクの `result` 共通）:

```json
{
  "status": "completed",
  "success_count": 1,
  "fail_count": 1,
  "results": [
    {"path": "/a/x.txt", "dest": "/b/x.txt", "status": "success", "message": "移動完了"},
    {"path": "/a/y.txt", "dest": "/b/y.txt", "status": "error", "message": "同名のファイルが存在します"}
  ]
}
```

`status` は `success` / `error` / `skipped`（移動元と移動先が同じ）。削除の結果には `dest` はなく、ロック時は `locked_by` が付きます。
削除・移動・コピーの安全ルールは [file_safety.md](file_safety.md) を参照してください。

#### 表示（`routers/viewer.py`）

| メソッド | パス | 説明 |
|----------|------|------|
| GET | /api/download?path= | ダウンロード |
| GET | /api/view-pdf?path= | PDF のインライン表示 |
| GET | /api/view-html?path= | HTML のインラインプレビュー |
| GET | /api/view-image?path=&baseDir= | 画像表示（Obsidian Vault 内の画像名・Excalidraw プレビューを自動解決） |
| GET | /api/folder-images?path=&depth= | フォルダ内画像一覧（`.git` / `node_modules` を除外） |

#### 外部アプリ起動（`routers/launcher.py`）

| メソッド | パス | 説明 |
|----------|------|------|
| POST | /api/open/smart | 拡張子と設定から開き方を判定（`open_url` / `open_modal` / `opened`） |
| POST | /api/open/{vscode,editor,execute,explorer,default,antigravity,jupyter,excalidraw,obsidian} | 各アプリで開く |
| POST | /api/open/trash | ゴミ箱を開く |
| GET | /api/fullpath?path= | フルパスでファイルを開く（外部ツール・リンク連携用。docs/external_integration.md） |
| GET / POST | /api/open-path | パスを開く（フォルダは `/?path=` へリダイレクト） |
| POST | /api/open-folder | フォルダを開く（ファイルなら親フォルダ） |

#### 設定・検索サービス中継・その他

| メソッド | パス | 説明 |
|----------|------|------|
| GET | /api/config | 設定の取得（`defaultBasePath`, `isWindows`, エディタ設定, `apiTimeout`, `pathMappings` など） |
| POST | /api/config/preferences | 設定の保存（`backend/settings.local.json`） |
| POST | /api/config/test-connections | 新サーバー（パス/URL）の接続確認 |
| GET | /api/index, /api/index/status | インデックス検索（Windows: Everything、macOS: file_index_service） |
| GET | /api/fulltext-search, /api/fulltext-search/status | 全文検索（Local-fulltext-search:8079） |
| GET / POST | /api/history | フォルダ履歴（`backend/folder_history.json`） |
| POST | /api/clipboard/copy | ファイルを OS クリップボードへ（Windows のみ） |
| WS | /api/terminal/ws?cwd= | サーバーターミナル |

### 外部API（file_index_service:8080）

詳細は [file_index_service](../file_index_service/README.md) を参照。

#### GET /?search=...&json=1

Everything互換検索API

**主要パラメータ:**
- `search` (or `s`, `q`): 検索クエリ
- `json`: JSON形式（1=有効）
- `count` (or `c`): 最大結果数
- `offset` (or `o`): 結果オフセット
- `path`: 検索対象パス（拡張）
- `file_type`: ファイルタイプフィルタ（拡張）

#### GET /status

インデックスサービスの状態取得

#### GET /paths

監視パス一覧取得

#### POST /paths

監視パス追加

#### DELETE /paths?path=...

監視パス削除

#### POST /rebuild

インデックス再構築

## セキュリティ

詳細は [security.md](security.md) を参照してください。

- **Host / Origin 検証**: 外部サイトからの書き込み操作・ターミナル接続と DNS リバインディングを拒否
- **CORS**: `localhost` と `FILE_MANAGER_ALLOWED_ORIGINS` のみ
- **パス**: 相対パスはベースディレクトリ外を 403。静的配信・ZIP 解凍・アップロードは対象フォルダの外へ書き込まない

### ブロッキングI/Oの分離

- ファイルI/Oを伴う処理はすべてスレッドプールで実行し、NAS が応答しなくてもサーバー全体（ターミナル含む）が固まらないようにする。
- 読み取り系（一覧、パス判定、Live検索、件数集計など）は `apiTimeout` を超えると `504 Gateway Timeout` を返す。書き込み系（移動・コピー・削除・保存・解凍）はタイムアウトさせない（docs/api_timeout.md）。
- Server Terminalはこのプールを共有しない。POSIX PTYはFD監視、Windowsの読み取りは接続単位の専用ワーカーを使う。
- ターミナルの出力ストリームが異常終了した場合は待機し続けずシェルを終了し、WebSocketを閉じる。フロントエンドは予期しない切断に対して0.5〜5秒の指数バックオフで再接続する。
- WebSocketの入力メッセージと端末サイズは型・範囲を検証し、不正な値だけを無視してセッションを維持する。

## 技術スタック

### フロントエンド
- React 19+
- TypeScript
- Vite 7+
- TanStack Query (データフェッチング)
- Lucide React (アイコン)

### バックエンド
- Python 3.12+
- FastAPI
- uvicorn
- Pydantic (設定管理)
- pathlib / shutil (ファイル操作)

### 外部サービス（file_index_service）
- Python 3.10+
- FastAPI
- SQLite FTS5 (全文検索インデックス)
- watchdog (ファイル監視)

## ポート設定

| サービス | ポート | 備考 |
|----------|--------|------|
| Backend / PWA | 8001 | FastAPI + Static Files (frontend) |
| Frontend (Vite) | 5173 | 開発用サーバー |
| file_index_service | 8080 | 外部インデックスサービス |

## テスト

```bash
# バックエンド（pytest・ruff）
cd backend
source .venv/bin/activate
pytest -q
ruff check app tests        # ruff は任意（pip install ruff）

# フロントエンド（vitest・型チェック・ESLint）
cd frontend
npm test
npx tsc -b
npm run lint

# Quick アプリ
cd frontend-quick
npm test
```

主なテスト:

- `backend/tests/test_file_safety.py`: ファイルが勝手に消えないこと（衝突・同一場所・失敗/キャンセル時に移動元を残す・ゴミ箱優先・上書き退避・アトミック保存・名前検証）
- `backend/tests/test_security.py`: Origin / Host 検証、CORS、静的配信のパストラバーサル
- `backend/tests/test_files_api.py` ほか: 各APIの機能
- `frontend/src/**/*.test.ts`: 純粋関数（結果の分類・Undo履歴・タイムアウト除外・パス処理・Markdown など）
- `frontend/src/components/FileList.ui.test.tsx`: FileList の画面操作テスト。jsdom 上に実際の FileList を描画し、
  偽バックエンド（`src/test/fakeBackend.ts`）に対してキー操作・クリック・ドラッグ&ドロップを行う
  （選択・カーソル移動・セクション移動・戻る/進む・絞り込み・削除・コピー/移動と上書き確認・アップロード・
  範囲選択・作成・リネーム・ファイルを開く・フォルダ履歴・Git 状態 など）

## ファイル検索（Everything風）

### 実装済み機能

- **3つの検索モード**:
  - **Live**: リアルタイム検索（指定フォルダ以下を検索）
  - **Index**: インデックス検索（指定フォルダ以下を高速検索、階層指定対応）
  - **Index(ALL)**: 全インデックス検索（Everything風、全ての監視パスを検索）★デフォルト
- **リアルタイム検索**: デバウンス800msで快適な検索体験、IME入力対応
- **タイプフィルタ**: ボタンで全/ファイル/フォルダを切り替え
- **階層制御**: +/-ボタンで検索深度を調整（0=無制限）
- **除外パターン**: カンマ区切りで複数パターン指定（例: node_modules,.git,*.pyc）
- **監視パス管理**: 追加/削除、スキャン状態表示
- **結果表示**: フォルダ→ファイルの順で表示、パスコピー用アイコンボタン
- **コンパクトUI**: ウィンドウ幅の30%を使用、最小限のスペースで最大の機能
- **日本語部分一致**: 日本語ファイル名の部分一致検索に対応（例: 「申告」→「確定申告.pdf」）

## 起動モード補足

- macOS/Linux の `./start.sh` は FastAPI が `frontend/dist/` を配信する単一ポート構成 (`8001`)
- `./start_dev.sh` は Vite (`5173`) + FastAPI (`8001`)
- Windows の `start_windows_prod.bat` も FastAPI が `frontend/dist/` を配信する単一ポート構成 (`8001`)

### 検索インデックス

外部サービス（file_index_service）がSQLite FTS5を使用した高速検索システムを提供：

| クエリ長 | インデックス | 速度 | 説明 |
|---------|-------------|------|------|
| 3文字以上 | FTS5 trigram | ~0.03秒 | 日本語含む部分一致 |
| 2文字 | bigramテーブル | ~0.06秒 | 2文字ペア完全一致 |
| 1文字 | LIKE検索 | 遅い | フォールバック |

360,000+ファイルでの高速検索を実現。

### 実装済み

- **アプリ内ドラッグ&ドロップ**: フォルダ間でのファイル移動（move/batch API使用）
- **Explorerからのドラッグ&ドロップ**: ブラウザへのファイルアップロード（upload API使用）
- ドラッグ中のビジュアルフィードバック
- フォルダへのドロップハイライト
- 同一ペイン内移動の誤操作防止アラート
