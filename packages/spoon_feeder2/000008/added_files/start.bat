@echo off
setlocal
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
set "PORT=%SPOONFEEDER_PORT%"
if not defined PORT set "PORT=8077"
set "HOST=%SPOONFEEDER_HOST%"
if not defined HOST set "HOST=127.0.0.1"

rem Close an existing listener before starting Spoonfeeder.
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  taskkill /PID %%P /F >nul 2>nul
)
if not exist frontend\dist\index.html (
  where npm >nul 2>nul
  if errorlevel 1 (
    echo frontend\dist がありません。Node.jsを導入してフロントエンドをビルドしてください。 1>&2
    exit /b 1
  )
  call npm install --prefix frontend
  if errorlevel 1 exit /b 1
  call npm run build --prefix frontend
  if errorlevel 1 exit /b 1
)
if not exist frontend\dist\index.html (
  echo フロントエンドのビルドに失敗しました。 1>&2
  exit /b 1
)
rem Python is always .venv (Python 3.14). When .venv is missing, create it with setup_windows.bat.
set "PYTHON=%~dp0.venv\Scripts\python.exe"
if not exist "%PYTHON%" call "%~dp0setup_windows.bat" /nopause
if not exist "%PYTHON%" (
  echo .venv could not be prepared. Run setup_windows.bat and check the messages. 1>&2
  exit /b 1
)
"%PYTHON%" -m uvicorn backend.main:app --host "%HOST%" --port "%PORT%"
endlocal
