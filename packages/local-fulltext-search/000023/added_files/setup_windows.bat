@echo off
setlocal
rem ==============================================================================
rem Local Fulltext Search - Windows 用セットアップ（backend\.venv を作る）
rem
rem 会社PC等の一般環境向け（uv なし・pip だけで用意する）:
rem 1. Python 3.14 を探す（py -3.14 → python の順）。3.14 が無ければ止める
rem 2. backend\.venv を作る。既にあって Python 3.14 で動くならそのまま使い、
rem    壊れている・版が違う（3.12 で作った古い venv など）ときは作り直す（消すのは .venv の中身だけ）
rem 3. pip を更新し、版を固定した backend\requirements-lock.txt を入れる
rem    /cuda を付けると requirements-cuda.txt（CUDA 12.6 の torch + 同じ版固定）を入れる
rem 4. 主要なパッケージが import できるか確かめる
rem
rem 使い方: setup_windows.bat をダブルクリック。何度実行してもよい。
rem   GPU (CUDA) を使う PC は setup_windows_cuda.bat（= setup_windows.bat /cuda）を使う
rem   start_windows.bat から呼ぶときは /nopause を付ける（最後に止まらない）
rem   社内プロキシが必要な場合は、先に pip の設定（pip.ini や HTTPS_PROXY）を済ませておく
rem 完了後、start_windows.bat で起動できる
rem ==============================================================================

set "APP_ROOT=%~dp0"
set "BACKEND_DIR=%APP_ROOT%backend"
set "VENV_PY=%BACKEND_DIR%\.venv\Scripts\python.exe"
set "REQ_FILE=requirements-lock.txt"
set "NOPAUSE="
for %%A in (%*) do (
    if /i "%%~A"=="/nopause" set "NOPAUSE=1"
    if /i "%%~A"=="/cuda" set "REQ_FILE=requirements-cuda.txt"
)

cd /d "%BACKEND_DIR%" || goto :fail

rem --- Python 3.14 を探す ---
set "PY_CMD="
py -3.14 -c "import sys" >nul 2>&1 && set "PY_CMD=py -3.14"
if not defined PY_CMD (
    python -c "import sys; sys.exit(0 if sys.version_info[:2] == (3, 14) else 1)" >nul 2>&1 && set "PY_CMD=python"
)
if not defined PY_CMD (
    echo [Setup] ERROR: Python 3.14 was not found. Install Python 3.14 and add it to PATH.
    goto :fail
)
for /f "delims=" %%v in ('%PY_CMD% -V 2^>^&1') do echo [Setup] Using %%v [%PY_CMD%]

rem --- backend\.venv を用意する ---
set "VENV_OK="
if exist "%VENV_PY%" (
    "%VENV_PY%" -c "import sys; sys.exit(0 if sys.version_info[:2] == (3, 14) else 1)" >nul 2>&1 && set "VENV_OK=1"
)
if defined VENV_OK (
    echo [Setup] Reusing backend\.venv
) else (
    echo [Setup] Creating backend\.venv ...
    %PY_CMD% -m venv --clear .venv || goto :fail
)

rem --- 依存パッケージを入れる ---
echo [Setup] Upgrading pip ...
"%VENV_PY%" -m pip install --upgrade pip
echo [Setup] Installing backend\%REQ_FILE% ...
"%VENV_PY%" -m pip install -r "%REQ_FILE%" || goto :fail

echo [Setup] Verifying installation ...
"%VENV_PY%" -c "import fastapi, uvicorn, faiss, fugashi, sentence_transformers, torch, sys; print('[Setup] Python', sys.version.split()[0], '/ torch', torch.__version__)" || goto :fail

echo [Setup] Setup completed. Start the application with start_windows.bat
if not defined NOPAUSE pause
exit /b 0

:fail
echo [Setup] Setup failed. See the messages above.
if not defined NOPAUSE pause
exit /b 1
