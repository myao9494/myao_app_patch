@echo off
rem ==============================================================================
rem Visual Diff Tool - Windows setup (setup_windows.bat)
rem Keep this file ASCII-only: cmd.exe may misparse multi-byte text under the
rem Japanese code page.
rem The company PC has no uv, so this uses only Python 3.14 and pip.
rem 1. Find Python 3.14 (py -3.14 first, then python). Stop if it is missing.
rem 2. Use .venv when it runs on Python 3.14 (else .venv_windows when that does).
rem    Otherwise recreate .venv with Python 3.14. When an old .venv cannot be
rem    removed (file locks or ownership), use .venv_windows instead.
rem 3. Install requirements-lock.txt (pinned versions) with pip.
rem start_windows.bat runs this with /nopause before every start, so pulled
rem dependency changes are installed automatically. Safe to run again.
rem If a proxy is required, configure pip (pip.ini or HTTPS_PROXY) first.
rem ==============================================================================
setlocal
cd /d "%~dp0"

set "NOPAUSE="
if /i "%~1"=="/nopause" set "NOPAUSE=1"
set "IS_314=import sys; sys.exit(0 if sys.version_info[:2] == (3, 14) else 1)"

rem --- Find Python 3.14 ---
set "PY_CMD="
py -3.14 -c "import sys" >nul 2>&1 && set "PY_CMD=py -3.14"
if not defined PY_CMD (
  python -c "%IS_314%" >nul 2>&1 && set "PY_CMD=python"
)
if not defined PY_CMD (
  echo [Setup] ERROR: Python 3.14 was not found. Install Python 3.14 and add it to PATH.
  goto :fail
)

rem --- Choose or create the virtual environment ---
set "VENV_DIR=.venv"
call :venv_ok ".venv"
if not errorlevel 1 goto :install
call :venv_ok ".venv_windows"
if not errorlevel 1 (
  set "VENV_DIR=.venv_windows"
  goto :install
)
if exist ".venv" (
  echo [Setup] Existing .venv does not run on Python 3.14; recreating it.
  rmdir /s /q ".venv" >nul 2>nul
)
if exist ".venv" (
  echo [Setup] Could not remove .venv; using .venv_windows instead.
  set "VENV_DIR=.venv_windows"
)
for /f "delims=" %%V in ('%PY_CMD% -V 2^>^&1') do echo [Setup] Creating %VENV_DIR% with %%V [%PY_CMD%]
%PY_CMD% -m venv --clear "%VENV_DIR%"
if errorlevel 1 goto :fail

:install
echo [Setup] Installing requirements-lock.txt into %VENV_DIR% ...
"%VENV_DIR%\Scripts\python.exe" -m pip install -r requirements-lock.txt
if errorlevel 1 goto :fail
echo [Setup] Done.
if not defined NOPAUSE pause
exit /b 0

:venv_ok
if not exist "%~1\Scripts\python.exe" exit /b 1
"%~1\Scripts\python.exe" -c "%IS_314%" >nul 2>nul
exit /b %errorlevel%

:fail
echo [Setup] Setup failed. See the messages above.
if not defined NOPAUSE pause
exit /b 1
