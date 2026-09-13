@echo off
setlocal
rem ==============================================================================
rem Windows NVIDIA GPU (RTX A500 等) 専用セットアップスクリプト
rem 
rem このスクリプトを実行すると:
rem 1. backend\.venv を作成
rem 2. CUDA 12.4 対応の PyTorch および依存パッケージを一括インストール
rem 3. GPU (CUDA) の認識状態を確認・表示
rem ==============================================================================

set "APP_ROOT=%~dp0"
set "BACKEND_DIR=%APP_ROOT%backend"

echo [Setup CUDA] Initializing Python Virtual Environment for Windows GPU...
cd /d "%BACKEND_DIR%"

if not exist ".venv" (
    echo [Setup CUDA] Creating virtual environment (.venv)...
    python -m venv .venv
)

echo [Setup CUDA] Upgrading pip...
.venv\Scripts\python.exe -m pip install --upgrade pip

echo [Setup CUDA] Installing PyTorch with CUDA 12.4 support (NVIDIA RTX A500)...
.venv\Scripts\python.exe -m pip install -r requirements-cuda.txt

echo.
echo [Setup CUDA] Verifying GPU acceleration...
.venv\Scripts\python.exe -c "import torch; print('----------------------------------------'); print('PyTorch Version :', torch.__version__); print('CUDA Available  :', torch.cuda.is_available()); print('Device Name     :', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU (CUDA not detected)'); print('----------------------------------------')"

echo.
echo [Setup CUDA] Setup completed!
echo You can now start the application by running start_windows.bat
pause
