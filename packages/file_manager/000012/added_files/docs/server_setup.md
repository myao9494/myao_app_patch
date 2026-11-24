# サーバーセットアップ手順

## 概要

`file_manager` は以下の 2 つの起動形態を持ちます。

- 開発モード: Vite (`5173`) + FastAPI (`8001`)
- PWA 配信モード: FastAPI (`8001`) が `frontend/dist/` を静的配信

通常利用は PWA 配信モードを前提とします。

## 前提

- Python 3.14（Mac・会社の Windows とも 3.14.9）
- macOS/Linux・Windows とも `backend/.venv` の Python で起動する
- フロントエンドの PWA 配信には `frontend/dist/` が必要

## バックエンドセットアップ

### macOS/Linux

```bash
./backend/ensure_venv.sh
```

`start.sh` / `start_dev.sh` からも自動で呼ばれます。uv があれば `uv.lock` どおりに揃え、無ければ `python3 -m venv` と pip で用意します。

### Windows

会社PCには uv が無いので、pip だけで用意する `setup_windows.bat` を使います。

```bat
setup_windows.bat
```

`backend\.venv` を Python 3.14 で作り、`backend\requirements-lock.txt`（`uv.lock` と同じ版に固定）を入れます。
`start.bat` / `start_windows_prod.bat` は `backend\.venv` が無ければこれを自動で実行します。詳細は `docs/startup_scripts.md`。

## フロントエンドセットアップ

```bash
cd frontend
npm install
npm run build
```

## 起動手順

### PWA 配信モード

#### macOS/Linux

```bash
./start.sh
```

#### Windows

```powershell
.\start_windows_prod.bat
```

起動後:

- アプリ本体: `http://localhost:8001`
- API: `http://localhost:8001/api`

### 開発モード

#### macOS/Linux

```bash
./start_dev.sh
```

#### Windows

```powershell
.\start.bat
```

起動後:

- フロントエンド: `http://localhost:5173`
- API: `http://localhost:8001/api`

## Windows の Python

Windows の起動スクリプトは `backend\.venv\Scripts\python.exe` だけを使います（システムの `python` や `backend\.venv_fix` は使いません）。
`backend\.venv` が無ければ `setup_windows.bat /nopause` で作ってから起動します。

## Server Terminal 補足

- Windows の既定シェルは `cmd.exe`
- 既定ではパイプ実装を使用
- Tab でパス補完可能
- PowerShell を使いたい場合は `FILE_MANAGER_WINDOWS_TERMINAL_SHELL=powershell`
- `pywinpty` を試したい場合は `FILE_MANAGER_WINDOWS_TERMINAL_BACKEND=winpty`

## 動作確認

1. `http://localhost:8001/api/config` で JSON が返る
2. PWA 配信モードでは `http://localhost:8001/` で画面が開く
3. 開発モードでは `http://localhost:5173/` で画面が開く
