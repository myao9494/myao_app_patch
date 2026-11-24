@echo off
chcp 65001 > nul
setlocal EnableExtensions

REM ==============================================================================
REM Excalidraw - Windows 用セットアップ（backend\.venv を作る）
REM
REM 会社PC向け（uv なし・pip だけで用意する）:
REM 1. Python 3.14 を探す（py -3.14 → python の順）。3.14 が無ければ止める
REM 2. backend\.venv を作る。既にあって Python 3.14 で動くならそのまま使い、
REM    壊れている・版が違う（Mac で作った venv など）ときは作り直す（消すのは .venv の中身だけ）
REM 3. pip を更新し、backend\requirements-lock.txt（版固定）を入れる
REM 4. fastapi / uvicorn / lzstring / multipart が import できるか確かめる
REM
REM 使い方: setup_windows.bat をダブルクリック。何度実行してもよい。
REM   start_servers.bat から呼ぶときは /nopause を付ける（最後に止まらない）
REM   社内プロキシが必要な場合は、先に pip の設定（pip.ini や HTTPS_PROXY）を済ませておく
REM ==============================================================================

set "BACKEND_DIR=%~dp0backend"
set "VENV_PY=%BACKEND_DIR%\.venv\Scripts\python.exe"
set "NOPAUSE="
if /i "%~1"=="/nopause" set "NOPAUSE=1"

cd /d "%BACKEND_DIR%" || goto :fail

REM --- Python 3.14 を探す ---
set "PY_CMD="
py -3.14 -c "import sys" > nul 2>&1 && set "PY_CMD=py -3.14"
if not defined PY_CMD (
  python -c "import sys; sys.exit(0 if sys.version_info[:2] == (3, 14) else 1)" > nul 2>&1 && set "PY_CMD=python"
)
if not defined PY_CMD (
  echo エラー: Python 3.14 が見つかりません。Python 3.14 を入れて PATH に追加してください。
  goto :fail
)
for /f "delims=" %%V in ('%PY_CMD% -V 2^>^&1') do echo 使用する Python: %%V [%PY_CMD%]

REM --- backend\.venv を用意する ---
set "VENV_OK="
if exist "%VENV_PY%" (
  "%VENV_PY%" -c "import sys; sys.exit(0 if sys.version_info[:2] == (3, 14) else 1)" > nul 2>&1 && set "VENV_OK=1"
)
if defined VENV_OK (
  echo 既存の backend\.venv を使います。
) else (
  echo backend\.venv を作成しています...
  %PY_CMD% -m venv --clear .venv || goto :fail
)

REM --- 依存パッケージを入れる ---
echo pip を更新しています...
"%VENV_PY%" -m pip install --upgrade pip
echo backend\requirements-lock.txt を入れています...
"%VENV_PY%" -m pip install -r requirements-lock.txt || goto :fail

"%VENV_PY%" -c "import fastapi, uvicorn, lzstring, multipart, sys; print('Python', sys.version.split()[0], '/ fastapi', fastapi.__version__)" || goto :fail

echo セットアップが完了しました。start_servers.bat で起動できます。
if not defined NOPAUSE pause
exit /b 0

:fail
echo エラー: セットアップに失敗しました。上のメッセージを確認してください。
if not defined NOPAUSE pause
exit /b 1
