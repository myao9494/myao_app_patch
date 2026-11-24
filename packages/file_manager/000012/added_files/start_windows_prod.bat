@echo off
setlocal

REM Windows本番環境用一括起動スクリプト
REM backend/app/main.py が frontend/dist を配信する単一ポート構成で起動します。

set BACKEND_PORT=8001
REM バックエンドは backend\.venv の Python で起動する。無ければ setup_windows.bat で作る
set "PYTHON_EXE=%~dp0backend\.venv\Scripts\python.exe"
if not exist "%PYTHON_EXE%" (
    echo backend\.venv was not found. Running setup_windows.bat ...
    call "%~dp0setup_windows.bat" /nopause
)
if not exist "%PYTHON_EXE%" (
    echo Failed to prepare backend\.venv. Run setup_windows.bat and check the messages.
    pause
    exit /b 1
)

echo Stopping existing servers...

REM バックエンドのポート確認と停止
echo Checking port %BACKEND_PORT%...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :%BACKEND_PORT% ^| findstr LISTENING') do (
    echo Port %BACKEND_PORT% is in use by PID %%a. Killing process...
    taskkill /F /PID %%a
)

REM distフォルダのチェック
if not exist "frontend\dist" (
    echo Error: frontend/dist folder not found. Please run 'npm run build' in frontend directory first.
    pause
    exit /b 1
)

echo Starting Backend server (Port %BACKEND_PORT%)...
start "File Manager Backend" cmd /c "cd /d %~dp0backend && "%PYTHON_EXE%" -m uvicorn --app-dir %~dp0backend app.main:app --host 0.0.0.0 --port %BACKEND_PORT% --workers 1 --log-level info"

echo Server is starting up.
echo App:         http://localhost:%BACKEND_PORT%
echo Backend API: http://localhost:%BACKEND_PORT%/api
echo.
echo Please access http://localhost:%BACKEND_PORT%
echo.

pause
