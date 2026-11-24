@echo off
setlocal

:: Define ports
set BACKEND_PORT=8000
set FRONTEND_PORT=5172

:: ---------------------------------------------------------
:: 0. Python: backend\.venv only (created by setup_windows.bat, no uv needed)
:: ---------------------------------------------------------
cd /d "%~dp0"
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

echo Starting Gantt Chart Application (Development Mode)...
echo.

:: ---------------------------------------------------------
:: 1. Cleanup existing processes on ports
:: ---------------------------------------------------------

:: Function-like block to kill process on a specific port
echo Checking port %BACKEND_PORT%...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :%BACKEND_PORT%') do (
    if not "%%a"=="0" (
        echo Killing process on port %BACKEND_PORT% ^(PID: %%a^)...
        taskkill /F /PID %%a >nul 2>&1
    )
)

echo Checking port %FRONTEND_PORT%...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :%FRONTEND_PORT%') do (
    if not "%%a"=="0" (
        echo Killing process on port %FRONTEND_PORT% ^(PID: %%a^)...
        taskkill /F /PID %%a >nul 2>&1
    )
)

echo.
echo cleanup complete.
echo.

:: ---------------------------------------------------------
:: 2. Start Backend
:: ---------------------------------------------------------
echo Starting Backend...
cd backend
start "Gantt Backend" cmd /k ""%PYTHON_EXE%" -m uvicorn main:app --reload --host 0.0.0.0 --port %BACKEND_PORT%"
cd ..

:: Wait a moment for backend to initialize
timeout /t 3 /nobreak >nul

:: ---------------------------------------------------------
:: 3. Start Frontend
:: ---------------------------------------------------------
echo Starting Frontend...
cd frontend
start "Gantt Frontend" cmd /k "echo Starting Frontend... & npm run dev"
cd ..

echo.
echo Application started!
echo Backend: http://localhost:%BACKEND_PORT%
echo Frontend: http://localhost:%FRONTEND_PORT%
echo.
pause
