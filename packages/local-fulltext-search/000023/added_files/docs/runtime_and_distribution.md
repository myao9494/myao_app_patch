<!--
配布先での起動方法と、開発環境との差分をまとめる。
会社PCなどで Node.js を入れられない前提でも迷わず起動できるようにする。
-->

# 配布・起動手順

## 目的

このドキュメントは、以下 2 つの起動方法の違いを整理するためのものです。

- 開発用に `start_dev.sh` で一括起動する方法
- 配布先で `backend/run.py` を直接起動する方法

## 結論

会社PCなどでフロントエンドのビルド環境がない場合は、`frontend/dist/` をリポジトリに含めた状態で配布し、`backend/run.py` を直接起動します。

この運用で必要なのは基本的に Python のみです（Mac・Win11 とも Python 3.14.9 にそろえている）。  
Node.js / npm は、フロントエンドを再ビルドするときだけ必要です。
`backend/requirements.txt` にはデスクトップランチャーの依存関係も含めています。

`launcher/requirements.txt` は、ランチャーだけを単体で動かす環境を最小構成で用意したい場合に使います。

Python 3.14 では `pydantic` 2.11 以前のビルド済みパッケージ（wheel）が無く、`pip install` が Rust でのビルドを試みて失敗します。そのため `requirements.txt` は `pydantic==2.12.5` に固定しています。

## Python 実行環境（backend/.venv）

- Python は 3.14（`backend/.python-version` = 3.14.9。Mac・会社の Windows とも同じ）。バックエンドは常に `backend/.venv` の Python で動かす（システムの `python` は使わない）。
- 依存は版を固定した `backend/requirements-lock.txt` を pip で入れる。会社の Windows には uv が無いので、どの端末でも pip だけで同じ版になるようにしている。`requirements.txt` を変えたら、uv のある Mac で書き出し直す（コマンドはファイル冒頭。`tests/test_python_env_contract.py` が固定漏れを確かめる）。
- 全パッケージに Python 3.14 用のビルド済み wheel がある（lzstring など 4 つは純 Python のソースで、pip がそのまま入れる）。会社PCでビルドが要るパッケージは無い。
- torch は 2.14.1 に固定する。PyPI（Mac・CPU の Windows）と CUDA 12.6 の索引の両方にある版。CUDA 12.4 の索引には Python 3.14 用の torch が無く、黙って CPU 版が入るため使わない。
- **Windows**: `setup_windows.bat` が Python 3.14 を `py -3.14` → `python` の順に探し、`backend\.venv` を作って（壊れている・3.14 でないときは作り直す）`requirements-lock.txt` を入れる。GPU 版は `setup_windows_cuda.bat`（= `setup_windows.bat /cuda`）で、`requirements-cuda.txt`（CUDA 12.6 の索引 + `torch==2.14.1+cu126` + `requirements-lock.txt`）を入れる。`start_windows.bat` は `backend\.venv` が無ければ `setup_windows.bat /nopause` を呼んでから起動する。
- **Mac**: `start_dev.sh` が `backend/.venv` を用意する。3.14 でない venv は作り直し、`requirements-lock.txt` が前回入れたときより新しければ入れ直す（`.venv/.requirements-lock.installed` で判定）。
- バッチファイルは CRLF 改行で保存する（`.gitattributes`）。

## 起動方法ごとの違い

### 1. `start_dev.sh`

用途:

- 開発環境での一括起動
- フロントエンドを再ビルドしてからバックエンドを起動したいとき

前提:

- Python
- Node.js
- npm

動作:

- `backend/.venv` がなければ作成する
- Python 依存をインストールする
- ランチャー自動起動に必要な Python 依存も `backend/.venv` にインストールする
- `frontend/node_modules` がなければ `npm install` する
- `frontend/dist/` を再ビルドする
- バックエンドを `127.0.0.1:8079` で起動する（他の端末から使う場合は `BACKEND_HOST=0.0.0.0` を指定）
- 外部Openハブの8001は起動・停止しない

### 2. `python run.py`

用途:

- 配布先での通常起動
- Node.js / npm がない端末での起動

前提:

- Python
- `frontend/dist/` がリポジトリに含まれていること
- デスクトップランチャーを使う場合は `backend/requirements.txt` の依存が入っていること
- Windows でデスクトップランチャーを使う場合は発行済み WPF 版（`launcher/windows/publish/`）が含まれていること

動作:

- `frontend/dist/` が存在すれば FastAPI からそのまま配信する
- 既定では `127.0.0.1:8079` で起動する
- primary openは別アプリが提供する既存8001へ送り、このプロセスからは管理しない
- 必要なら `SEARCH_APP_HOST` と `SEARCH_APP_PORT` で上書きできる
- `backend/run.py` は既定で `SEARCH_APP_LAUNCHER_AUTOSTART=1` を設定し、ランチャーを子プロセスとして起動する。Windowsでは発行済みWPF通常版、WPF single-file版の順に選び、どちらも無ければ起動せず理由を状態（`last_error`）とログへ残す。macOSでは Python の Cocoa 版を起動する
- WPF版EXEを標準の `launcher/windows/publish/` 以外へ置く場合は、`SEARCH_APP_WPF_LAUNCHER_PATH` に絶対パスを指定する

## 配布先での手順

### 初回セットアップ (GPU / CPU ごとの選択)

#### パターン A: Windows PC で NVIDIA GPU (RTX A500 等) を使って高速化する場合 (推奨)
ルートにあるワンクリックセットアップスクリプトを実行します（Python 3.14 が必要。uv は不要）。
```powershell
.\setup_windows_cuda.bat
```
※ `requirements-cuda.txt` で PyTorch 公式の CUDA 12.6 対応 wheel（`torch==2.14.1+cu126`）が入り、GPU 加速が有効になります。最後に GPU の認識状態を表示します。

#### パターン B: 通常の CPU 環境の場合
```powershell
.\setup_windows.bat
```
※ どちらも `backend\.venv` を作り（古い・壊れた venv は作り直す）、`backend\requirements-lock.txt` を pip で入れます。何度実行してもかまいません。
※ Mac は `./start_dev.sh` が `backend/.venv` を自動で用意します。Apple Silicon では自動的に GPU (Metal / MPS) が有効になります。

### 毎回の起動

Windows の場合は、ルートのバッチファイルをダブルクリックまたは実行します:
```powershell
.\start_windows.bat
```
※ `start_windows.bat` は `backend\.venv` の Python で起動し（無ければ先に `setup_windows.bat` を実行する）、起動時にコンソール上に現在の稼働デバイス（`⚡ NVIDIA GPU (RTX A500)` または `💻 CPU`）を表示します。

PowerShell から直接起動する場合:
```powershell
cd backend
.venv\Scripts\python.exe run.py
```

既定のアクセス先:

- Web/Search API: `http://127.0.0.1:8079/`
- 外部Openハブ（別アプリ）: `http://127.0.0.1:8001/`

ランチャーは`LAUNCHER_API_BASE_URL=http://127.0.0.1:8079`で検索し、`LAUNCHER_WEB_BASE_URL=http://127.0.0.1:8001`で外部Openハブへ結果を送る。8001は別アプリが事前に起動している前提であり、このリポジトリの起動スクリプトは8001を停止・起動しない。詳細は[`open_hub.md`](open_hub.md)を参照する。

## Windows ランチャーの完全オフライン起動

Windows のランチャーは発行済み WPF 版だけを使う（Python / Flet 版は廃止）。WPF 版は .NET ランタイムを同梱して発行するため、配布先に .NET SDK もランチャー用 Python 依存も要らない。`start_windows.bat` はバックエンドへランチャー起動を委ねるため、Web画面/APIからWPFプロセスの状態確認・停止・再起動ができる。WPF 版を変更したら `launcher/windows/publish.ps1` で `publish/` を更新してコミットする。

外部アプリから特定フォルダと検索語を渡して開く場合:

- `http://127.0.0.1:8079/?q=見積&full_path=%2FUsers%2Fmine%2FDocuments&index_depth=2`
- `q` と `full_path` の両方があると初回表示時に自動検索する
- `search_all=1` を付けると、`full_path` が空でも初回に全 DB 検索を実行できる
- `index_depth` を省略した場合は `1`
- `full_path` は絶対パス、または Windows の UNC パスを使う

### 別端末からアクセスさせたい場合

```powershell
cd backend
$env:SEARCH_APP_HOST="0.0.0.0"
$env:SEARCH_APP_PORT="8079"
.venv\Scripts\python.exe run.py
```

アクセス先:

- `http://<このPCのIPアドレス>:8079/`

## ポートと bind の既定値

`start_dev.sh` の既定値:

- Host: `127.0.0.1`（`BACKEND_HOST` で上書き可能）
- Port: `8079`

`backend/run.py` の既定値:

- Web/Search API: `127.0.0.1:8079`
- 外部Openハブ: `127.0.0.1:8001`（別アプリが管理。本リポジトリはポート操作しない）
- DB 保存先: 起動ディレクトリに依存せず `backend/data/search.db`

## 保存されるファイル

既定では `backend/data/` 配下に次のファイルを保存する。

- `search.db`
- `exclude_keywords.txt`
- `web_exclude_keywords.txt`
- `hidden_indexed_targets.txt`
- `synonym_groups.txt`
- `obsidian_sidebar_explorer_data_path.txt`
- `index_selected_extensions.txt`
- `custom_content_extensions.txt`
- `custom_filename_extensions.txt`
- `launcher.log` は `backend/` 直下に保存する

保存先ディレクトリは `SEARCH_APP_DATA_DIR` で、各ファイル名は `SEARCH_APP_*_NAME` 系の環境変数で上書きできる（例: `SEARCH_APP_EXCLUDE_KEYWORDS_NAME`。全項目は `backend/app/config.py`）。
配信するフロントエンドの場所は `SEARCH_APP_FRONTEND_DIST_DIR` で変更できる。
検索対象フォルダはテキストファイルではなく SQLite の `targets` テーブルに保存する。

## Git 管理方針

配布先でフロントエンドをビルドしないため、`frontend/dist/` は Git 管理対象にします。

引き続き Git 管理しないもの:

- `backend/.venv/`
- `frontend/node_modules/`
- `backend/data/`
- `data/`
- `launcher/.offline_cache/`
- `.run/`
- `*.log`
