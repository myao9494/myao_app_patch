@echo off
setlocal
rem ==============================================================================
rem Windows NVIDIA GPU (RTX A500 等) 専用セットアップスクリプト
rem
rem setup_windows.bat /cuda を実行して backend\.venv を用意し（Python 3.14・uv 不要）、
rem requirements-cuda.txt（CUDA 12.6 の torch 2.14.1+cu126 + requirements-lock.txt と同じ版）を入れる。
rem そのあと GPU (CUDA) の認識状態を確認・表示する。
rem ==============================================================================

call "%~dp0setup_windows.bat" /cuda /nopause
if errorlevel 1 (
    echo [Setup CUDA] Setup failed. See the messages above.
    pause
    exit /b 1
)

echo.
echo [Setup CUDA] Verifying GPU acceleration...
"%~dp0backend\.venv\Scripts\python.exe" -c "import torch; print('----------------------------------------'); print('PyTorch Version :', torch.__version__); print('CUDA Available  :', torch.cuda.is_available()); print('Device Name     :', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU (CUDA not detected)'); print('----------------------------------------')"

echo.
echo [Setup CUDA] Setup completed!
echo You can now start the application by running start_windows.bat
pause
