# File Manager

React + FastAPI による軽量ファイルマネージャーです。3ペイン構成で、左右のファイル一覧と検索ペインを並べて操作できます。検索ペイン下部にはサーバーターミナルも埋め込めます。

## 概要

- フロントエンド: React + TypeScript + Vite
- バックエンド: FastAPI
- 検索:
  - `Live`: file_manager 内部 API によるディレクトリ走査
  - `Index(L)` / `Index(R)`: 外部の Local-fulltext-search (`http://localhost:8079`) を利用
  - `Index(ALL)`: 外部の file_index_service (`http://localhost:8080`) を利用
  - `全文(ALL)`: 外部の Local-fulltext-search (`http://localhost:8079`) を利用
- 配信モード:
  - 開発モード: Vite (`5173`) + FastAPI (`8001`)
  - PWA 配信モード: FastAPI (`8001`) が `frontend/dist/` を配信

## セットアップ

### バックエンド

macOS は仮想環境利用を推奨、Windows は仮想環境なしでも動作します。

```bash
cd backend

python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt

PYTHONPATH=. pytest tests/ -v
PYTHONPATH=. python -m uvicorn app.main:app --reload --port 8001
```

Windows 注:
- 仮想環境がなくても動作します。`python` に依存パッケージが入っていればそのまま起動できます
- Server Terminal を安定して使うには、仮想環境へ `pywinpty` が入っていることを推奨します
- `pywinpty` は管理者権限不要で、通常の `pip install -r requirements.txt` で導入できます
- Windows の既定は `cmd.exe` + パイプ実装です
- `cmd.exe /Q` で起動し、Windows のロケールに応じた文字コードで入出力します
- `pywinpty` を試す場合だけ `FILE_MANAGER_WINDOWS_TERMINAL_BACKEND=winpty` を設定します
- PowerShell を使いたい場合だけ `FILE_MANAGER_WINDOWS_TERMINAL_SHELL=powershell` を設定します

### フロントエンド

```bash
cd frontend

npm install
npm run dev
npm run build
```

## 起動方法

### 開発モード

```bash
./start_dev.sh
```

- フロントエンド: `http://localhost:5173`
- バックエンド API: `http://localhost:8001/api`

### PWA 配信モード

```bash
./start.sh
```

- アプリ本体: `http://localhost:8001`
- バックエンド API: `http://localhost:8001/api`
- 実行時に `frontend/dist/` を最新化するため、フロントエンドをビルドします

### Windows

- 開発モード: `start.bat`
- 本番相当の配信: `start_windows_prod.bat`

注:
- `start_windows_prod.bat` も `http://localhost:8001` の単一ポート配信です
- `frontend/dist/` が必要です
- Windows は `backend/.venv_fix` → `backend/.venv` → システム `python` の順で起動に使用します
- そのため、会社PCのように仮想環境なしでもシステム `python` に依存関係が入っていれば動作します

## 環境変数

`backend/.env.example` を `backend/.env` にコピーして使用します。

主な設定:

- `FILE_MANAGER_BASE_DIR`: デフォルトのベースディレクトリ
- `FILE_MANAGER_START_DIR`: 起動時に表示するディレクトリ（省略時はベースディレクトリ）
- `FILE_MANAGER_OBSIDIAN_BASE_DIR`: Obsidian デイリーフォルダのベースディレクトリ
- `FILE_MANAGER_FILE_IO_WORKERS`: ファイルI/O専用ワーカー数（既定16、4〜64に制限）

## URL パラメータ

起動時に特定のパスを開けます。

```text
http://localhost:5173/?path=/Users/username/Documents
```

UNC パスも指定可能です。

```text
http://localhost:5173/?path=\\server\share\folder
```

挙動:

- フォルダパス: そのフォルダを開く
- ファイルパス: 親フォルダへ移動
- 存在しないパス: エラー表示後、デフォルトパスへ戻る

## 主な機能

- 3ペインレイアウト（左 / 中央 / 検索）
- ファイル一覧表示
  - 左・中央ペインでは、フォルダ行を選択（またはカーソルを合わせて）`d` を押すと、配下を含む最新更新日時を Date 列に表示
  - 共有フォルダへの負荷を抑えるため、通常の一覧取得では再帰走査せず、集計はハンバーガーメニューの「Folder Date Max Items」（初期値20,000項目）とAPIタイムアウト内に制限
  - 左・中央ペインでは、`G` を押すとペイン内の全フォルダを並列にGit確認。Git列は作業ツリー変更を`G`、未Pushを`Push`、未Pullを`Pull`、両方を`C`、Git管理外または差分なしを`-`で表示し、ホバーで件数・変更ファイルを確認可能。`G` はVS Codeを開き、`Push`・`Pull`・`C` は対象フォルダへのcdを含むGitコマンドをクリップボードへコピー
  - 左・中央ペインでは、`O` を押すと現在のフォルダをFinder／Explorerで開く
  - `T` のテキストファイル作成ではファイル名と拡張子を個別に指定可能。既定拡張子はハンバーガーメニューの「Default Text Extension」で保存・変更できる
  - `R` はアクティブカーソル行をリネームし、ファイル名と拡張子を個別に指定可能
- 戻る / 進む / 上の階層へ移動
- ドラッグ&ドロップ
- 一括コピー / 一括移動 / 一括削除
- Safe Move（コピー → 検証 → 削除）
- Markdown エディタモーダル
  - Obsidianライクなプレビュー表示と `Cmd/Ctrl+L` によるチェックリスト切り替え
- テキスト / コード用ファイルエディタモーダル
  - 最上部1行集約ヘッダー、コード編集領域の最大化
  - VS Code Dark+ 準拠の配色（Pythonの `def`, `class`, 組み込み型/関数, docstring, デコレータ等）、行番号表示、シンタックスハイライト付きで `.py` / `.ts` / `.json` / `.txt` などを編集
  - エディタ内全文検索（`Cmd/Ctrl+F`、`Enter`/`Shift+Enter`、循環、構文ハイライト共存）
- Obsidian / VSCode / Jupyter / Excalidraw / Finder or Explorer 連携
- Obsidian 今日のフォルダを開く機能
- 検索ペイン
  - `Live`
  - `Index(L)` / `Index(R)`
  - `Index(ALL)`
  - `全文(ALL)`
  - タイプフィルタ
  - 深さ指定
  - ファイル名フィルタ
  - 正規表現モード
- サーバーターミナル
  - 右ペイン下部に常駐
  - WebSocket + PTY 経由でローカルシェルに接続
  - 予期しない切断時は0.5〜5秒のバックオフで自動再接続
  - Windows では `cmd.exe` を既定シェルとして使用
  - Windows では既定でパイプ実装を使い、必要時のみ `pywinpty` を明示有効化
  - Windows の `cmd.exe` では入力はフロント側で行バッファ管理し、Enter 時にまとめて実行
  - Tab で現在行のパス補完が可能
  - `Open Left` / `Open Center` は同じパスでも明示的に再接続可能

## API の現状

主なエンドポイント:

- `GET /api/files`
- `GET /api/path-info`
- `GET /api/search`
- `POST /api/create-folder`
- `POST /api/create-file`
- `POST /api/update-file`
- `POST /api/rename`
- `POST /api/move`
- `POST /api/move/batch`
- `POST /api/copy/batch`
- `DELETE /api/delete`（JSONボディで対象パスを指定）
- `POST /api/upload`
- `GET /api/obsidian/daily-path`
- `GET /api/config`
- `POST /api/config/preferences`
- `WS /api/terminal/ws`

詳細は [docs/architecture.md](docs/architecture.md) を参照してください。

## ドキュメント

- [アーキテクチャ設計書](docs/architecture.md)
- [開発仕様書 (claude.md)](docs/claude.md)
- [テキスト / コードエディタ仕様書](docs/code_editor.md)
- [Markdownビューワ / エディタ仕様書](docs/markdown_viewer.md)
- [PWA デプロイメントガイド](docs/pwa_deployment.md)
- [起動スクリプト仕様書](docs/startup_scripts.md)
- [Obsidian 今日のフォルダ連携](docs/obsidian_daily.md)
- [Everything 連携マニュアル](docs/everything_manual.md)
