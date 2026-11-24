@echo off
rem ==============================================================================
rem Visual Diff Tool - Windows launcher (start_windows.bat)
rem Keep this file ASCII-only: cmd.exe may misparse multi-byte text under the
rem Japanese code page.
rem 1. Run setup_windows.bat /nopause: prepares a Python 3.14 virtual environment
rem    (.venv, or .venv_windows when an old .venv cannot be removed) and installs
rem    requirements-lock.txt with pip.
rem 2. Start backend\run.py with that environment's Python (never the system python).
rem ==============================================================================
setlocal
cd /d "%~dp0"

call "%~dp0setup_windows.bat" /nopause
if errorlevel 1 (
  pause
  exit /b 1
)

rem Pick the environment in the same order as setup_windows.bat.
set "IS_314=import sys; sys.exit(0 if sys.version_info[:2] == (3, 14) else 1)"
set "VENV_DIR=.venv"
call :venv_ok ".venv"
if errorlevel 1 set "VENV_DIR=.venv_windows"

cd backend
"..\%VENV_DIR%\Scripts\python.exe" run.py

endlocal
exit /b 0

:venv_ok
if not exist "%~1\Scripts\python.exe" exit /b 1
"%~1\Scripts\python.exe" -c "%IS_314%" >nul 2>nul
exit /b %errorlevel%
