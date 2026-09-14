# 仕様書: 社内・制限環境（pip installのみ実行可能）での自己完結運用とモデル管理

## 1. 概要と背景
セキュリティ制限のある社内・会社PC環境では、インターネットからの自由なダウンロードやビルドツール（Node.js / npm、.NET SDK）のインストールが制限されており、実行可能な環境構築コマンドは `pip install` のみに限られます。

本システムでは、以下の完全自己完結設計により、会社PCで `git pull` して `setup_windows.bat`（`pip install`）を実行するだけで即座に全機能が利用できるように構成されています。

---

## 2. 核心仕様

### 2.1 モデル配置の柔軟な自動探索 (`models/` または `backend/models/`)
- **モデルの管理方針**:
  - ベクトルモデル（`ruri-v3-30m`, `ruri-v3-310m`, `ruri-v3-70m` 等）は合計数GBに及ぶため、Git リポジトリにはコミットせず `.gitignore` で除外します（リポジトリの容量肥大化・クローン遅延を防止）。
  - モデルファイルは会社PC側で別途ダウンロード・配置（USB・社内ファイルサーバー・共有ドライブ経由等）して運用します。
- **柔軟な探索ディレクトリの自動解決**:
  - モデルの配置場所として以下の両方を自動探索します：
    1. プロジェクトルートの `models/<モデル名>/`（例: `models/ruri-v3-30m`）
    2. バックエンド配下の `backend/models/<モデル名>/`（例: `backend/models/ruri-v3-30m`）
  - どちらにモデルフォルダを配置しても、バックエンド（`VectorState.resolve_model_path`）が自動検知してロードします。
  - Mac等で保存された絶対パスが `config.json` に残っている場合でも、フォルダ名（`ruri-v3-30m` 等）からローカルのディレクトリを自動解決します。
- **モデル未配置時の安全なフォールバック**:
  - モデルがまだダウンロード・配置されていない状態であっても、**バックエンドの起動はクラッシュせず正常に起動**します。
  - 通常の FTS5 キーワード検索は 100% 正常に利用可能であり、Web UI のベクトル管理画面で「モデルが未配置です」と親切に案内されます。

### 2.2 設定ファイル・専門用語辞書の Git 同期と端末固有キャッシュの分離
- 端末固有のデータベースファイル（`*.db`）やログファイルのみを `.gitignore` で除外します。
- 以下の共通設定ファイルは Git で確実に同期され、社内PCでもそのまま反映されます：
  - `backend/data/synonym_groups.txt`（専門用語辞書・類似語リスト）
  - `backend/data/exclude_keywords.txt`（除外キーワード）
  - `backend/data/index_selected_extensions.txt`（インデックス対象拡張子）
  - `backend/data/custom_content_extensions.txt`（本文抽出用追加拡張子）
  - `backend/data/custom_filename_extensions.txt`（ファイル名のみ追加拡張子）
  - `backend/data/config.json`（モデル選択設定）

### 2.3 フロントエンド & Windows WPF ランチャーのビルド済み同梱
- **Web UI (`frontend/dist/`)**:
  - ビルド済みの HTML/JS/CSS/アセットを `frontend/dist/` に同梱。
  - バックエンドの FastAPI が `/` で直接配信するため、社内PCでの Node.js / npm のインストールやビルド作業は一切不要。
- **Windows WPF ランチャー (`launcher/windows/publish/folder/` および `single-file/`)**:
  - .NET 8 ランタイムや全依存 DLL を内包した self-contained 発行成果物を Git に同梱。
  - 社内PCでの .NET SDK のインストールや C# ビルドは一切不要。

### 2.4 Windows ワンクリックセットアップスクリプト
- **`setup_windows.bat` (CPU標準)**:
  - 仮想環境（`.venv`）作成 ➔ `pip` 最新化 ➔ `pip install -r requirements.txt` を自動実行。
- **`setup_windows_cuda.bat` (NVIDIA GPU / RTX A500 等)**:
  - CUDA 12.4 対応 PyTorch を含む `requirements-cuda.txt` を自動インストール。
- **`start_windows.bat`**:
  - `.venv` または `venv` を自動認識し、ポートチェック・旧プロセス終了を行ってワンクリックで起動。
