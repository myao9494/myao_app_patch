# サーバー起動スクリプト仕様書

## 概要
file_managerのサーバー（バックエンドおよびフロントエンド）を効率的に起動するためのスクリプトです。
既にポートが使用されている場合、そのプロセスを自動的に終了させてから再起動します。macOS/Linux版はスクリプト自身の場所を基準に動くため、任意のカレントディレクトリから実行できます。

**注**: インデックス検索機能は外部サービス（file_index_service）に分離されています。
外部サービスも同時に起動する場合は、file_index_serviceディレクトリの起動スクリプトを別途実行してください。

## 対象ポート
- **file_manager Backend**: 8001
- **file_manager Frontend**: 5173

## スクリプト一覧

### 1. start.sh (macOS/Linux用)
- **場所**: プロジェクトルート
- **機能**:
    - `lsof` を使用してポート 8001 を使用中のプロセスを特定し、まず正常終了、5秒後も残る場合だけ強制終了します。
    - `frontend/` で `npm run build` を実行し、最新の `dist/` を生成します。
    - `backend/ensure_venv.sh` で `backend/.venv` を用意し、その Python（`backend/.venv/bin/python`）でバックエンドを起動します（下の「macOS/Linux の Python 実行環境」）。
    - バックエンドのみを起動し、FastAPI が `frontend/dist/` を静的配信します。
    - `/api/config` が応答するまで待ってから起動完了を表示します。
    - `Ctrl+C` や起動失敗時にバックエンドプロセスを停止します。
- **実行方法**:
    ```bash
    ./start.sh
    ```

### 2. start_dev.sh (macOS/Linux用)
- **場所**: プロジェクトルート
- **機能**:
    - `lsof` を使用してポート 8001, 5173 を使用中のプロセスを特定し、まず正常終了、5秒後も残る場合だけ強制終了します。
    - `backend/ensure_venv.sh` で `backend/.venv` を用意し、その Python でバックエンドを起動します。
    - バックエンドと Vite 開発サーバーを両方起動します。
    - `/api/config` が応答してから Vite を起動します。
    - `Ctrl+C`、起動失敗、またはいずれかのサーバー終了時に両方のプロセスを停止します。
- **実行方法**:
    ```bash
    ./start_dev.sh
    ```

### 3. setup_windows.bat (Windows用, 環境の用意)
- **場所**: プロジェクトルート
- **機能**: `backend\.venv` を作り、依存パッケージを入れます。会社PCには uv が無いので pip だけで用意します。
    - Python 3.14 を `py -3.14` → `python` の順に探します。3.14 が無ければエラーで止まります。
    - `backend\.venv` が既にあり Python 3.14 で動けばそのまま使い、壊れている・版が違う（Mac で作った venv など）ときは `python -m venv --clear` で作り直します。
    - pip を更新し、`backend\requirements-lock.txt` を入れます。このファイルは `uv.lock` と同じ版に固定してあり、全パッケージに Python 3.14 / win_amd64 のビルド済み wheel があります（ビルド環境の無い会社PCでも入る）。`requirements.txt` は下限だけで新しすぎる版が入るため使いません。
    - 最後に `fastapi` / `uvicorn` / `pydantic` が import できるか確かめます。
    - 何度実行してもかまいません。`/nopause` を付けると最後に止まりません（起動スクリプトから呼ぶとき）。
    - 社内プロキシが必要な場合は、先に pip の設定（`pip.ini` や `HTTPS_PROXY`）を済ませておきます。
- **実行方法**:
    - `setup_windows.bat` をダブルクリック、またはコマンドプロンプトから実行。
- **`requirements-lock.txt` の更新**: `uv.lock` を変えたら、uv のある端末（Mac）で書き出し直します（コマンドはファイル冒頭のコメント）。`backend/tests/test_requirements_lock.py` が `uv.lock` との一致を確かめます。

### 4. start.bat (Windows用, 開発モード)
- **場所**: プロジェクトルート
- **機能**:
    - バックエンドは `backend\.venv\Scripts\python.exe` で起動します。`backend\.venv` が無ければ先に `setup_windows.bat /nopause` を実行します。
    - `netstat` でポート 8001, 5173 を使用中のPIDを取得し、`taskkill` で終了します。
    - バックエンドとフロントエンド開発サーバーをそれぞれ別ウィンドウで起動します。
    - 実装上、起動前に `frontend/` で `npm run build` も実行します。
- **実行方法**:
    - `start.bat` をダブルクリック、またはコマンドプロンプトから実行。

### 5. start_windows_prod.bat (Windows用, 配信モード)
- **場所**: プロジェクトルート
- **機能**:
    - ポート 8001 を使用中のプロセスを停止します。
    - バックエンドは `backend\.venv\Scripts\python.exe` で起動します。`backend\.venv` が無ければ先に `setup_windows.bat /nopause` を実行します（システムの `python` や `backend\.venv_fix` は使いません）。
    - バックエンドを `8001` で起動します。
    - `frontend/dist` が存在する場合、FastAPI がそのまま静的配信します。
- **実行方法**:
    - `start_windows_prod.bat` をダブルクリック、またはコマンドプロンプトから実行。

## macOS/Linux の Python 実行環境

`start.sh` / `start_dev.sh` は `uv run` やシステムの `python` ではなく、必ず `backend/.venv/bin/python` でバックエンドを起動します。
起動前に `backend/ensure_venv.sh` が venv を用意します（単独でも `./backend/ensure_venv.sh` で実行できます）。

- Python のバージョンは `backend/.python-version`（3.14.9。会社の Windows 端末と同じ）で決める。
- uv がある場合: 毎回 `uv sync --frozen --inexact` で `uv.lock` どおりに揃える。venv が無い・壊れている・バージョンが違う場合は uv が作り直す。`--inexact` なので手で追加したパッケージは消さない。
- uv がない場合: venv の Python が動かなければ `python3 -m venv --clear` で作り直し、`fastapi` / `uvicorn` が import できなければ `requirements.txt` を pip で入れる。
- 依存は `uv.lock` の版を正とする。`requirements.txt` は下限だけなので、pip で最新を入れると `pydantic` 2.14 以降で `tests/conftest.py` の `monkeypatch.setattr(settings, "_preferences_file_override", ...)` が失敗する（`uv.lock` は 2.12.5）。

## モードごとのURL

### macOS/Linux

- `./start_dev.sh`
  - Frontend: `http://localhost:5173`
  - Backend API: `http://localhost:8001/api`
- `./start.sh`
  - App: `http://localhost:8001`
  - Backend API: `http://localhost:8001/api`

### Windows

- `start.bat`
  - Frontend: `http://localhost:5173`
  - Backend API: `http://localhost:8001/api`
- `start_windows_prod.bat`
  - App: `http://localhost:8001`
  - Backend API: `http://localhost:8001/api`

## 注意事項
- macOS/Linux版は任意のディレクトリから実行できます。Windows版はプロジェクトルートから実行してください。
- 実行には以下の環境が必要です：
    - Python (バックエンド用)
    - Node.js 20.19以上 / npm (フロントエンド用)
    - ポート 8001, 5173 へのアクセス権限
- Windows の配信モードも単一ポート (`8001`) 構成です。
- Windows も `backend\.venv` で起動します。初回は `setup_windows.bat` を実行してください（起動スクリプトからも自動で呼ばれます）。
- バッチファイルは CRLF 改行で保存します（`.gitattributes`）。LF だと cmd が行を読み違えます。
- macOS/Linux は `backend/.venv` で起動します（上の「macOS/Linux の Python 実行環境」）。
