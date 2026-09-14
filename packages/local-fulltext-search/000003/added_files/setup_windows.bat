@echo off
setlocal
rem ==============================================================================
rem Windows 標準環境 (CPU) 専用セットアップスクリプト
rem 
rem 会社PC等の一般環境向け（pip install のみ許可されている環境に対応）:
rem 1. backend\.venv を作成
rem 2. pip を最新化
rem 3. requirements.txt から依存パッケージを一括インストール
rem 4. 完了後、start_windows.bat で即座に起動可能
rem
rem ※ NVIDIA GPU (CUDA) を搭載しているPCの場合は、
rem    setup_windows_cuda.bat をご利用ください。
rem ==============================================================================

set "APP_ROOT=%~dp0"
set "BACKEND_DIR=%APP_ROOT%backend"

echo [Setup] Initializing Python Virtual Environment for Windows...
cd /d "%BACKEND_DIR%"

if not exist ".venv" (
    echo [Setup] Creating virtual environment (.venv)...
    python -m venv .venv
)

echo [Setup] Upgrading pip...
.venv\Scripts\python.exe -m pip install --upgrade pip

echo [Setup] Installing dependencies from requirements.txt...
.venv\Scripts\python.exe -m pip install -r requirements.txt

echo.
echo [Setup] Verifying installation...
.venv\Scripts\python.exe -c "import fastapi, uvicorn, sentence_transformers; print('----------------------------------------'); print('Dependencies installed successfully!'); print('----------------------------------------')"

echo.
echo [Setup] Setup completed!
echo You can now start the application by running start_windows.bat
pause
