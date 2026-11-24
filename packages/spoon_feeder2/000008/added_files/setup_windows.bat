@echo off
rem ==============================================================================
rem Spoonfeeder2 Windows setup (setup_windows.bat)
rem Keep this file ASCII-only: cmd.exe may misparse multi-byte text under the
rem Japanese code page.
rem The company PC has no uv, so this uses only Python 3.14 and pip.
rem 1. Find Python 3.14 (py -3.14 first, then python). Stop if it is missing.
rem 2. Create .venv. Reuse it when it already runs on Python 3.14; otherwise
rem    (broken, or made with another Python version) recreate it. Only the
rem    contents of .venv are replaced. Never install into the system Python.
rem 3. Install backend\requirements-lock.txt (pinned versions) with pip.
rem Usage: double-click. Safe to run again.
rem   start.bat calls it with /nopause when .venv is missing.
rem   If a proxy is required, configure pip (pip.ini or HTTPS_PROXY) first.
rem ==============================================================================
setlocal
cd /d "%~dp0"

set "VENV_PY=%~dp0.venv\Scripts\python.exe"
set "NOPAUSE="
if /i "%~1"=="/nopause" set "NOPAUSE=1"

rem --- Find Python 3.14 ---
set "PY_CMD="
py -3.14 -c "import sys" >nul 2>&1 && set "PY_CMD=py -3.14"
if not defined PY_CMD (
  python -c "import sys; sys.exit(0 if sys.version_info[:2] == (3, 14) else 1)" >nul 2>&1 && set "PY_CMD=python"
)
if not defined PY_CMD (
  echo [Setup] ERROR: Python 3.14 was not found. Install Python 3.14 and add it to PATH.
  goto :fail
)
for /f "delims=" %%V in ('%PY_CMD% -V 2^>^&1') do echo [Setup] Using %%V [%PY_CMD%]

rem --- Prepare .venv ---
set "VENV_OK="
if exist "%VENV_PY%" (
  "%VENV_PY%" -c "import sys; sys.exit(0 if sys.version_info[:2] == (3, 14) else 1)" >nul 2>&1 && set "VENV_OK=1"
)
if defined VENV_OK (
  echo [Setup] Reusing .venv
) else (
  echo [Setup] Creating .venv ...
  %PY_CMD% -m venv --clear .venv
  if errorlevel 1 goto :fail
)
if not exist "%VENV_PY%" goto :fail

rem --- Install dependencies ---
echo [Setup] Upgrading pip ...
"%VENV_PY%" -m pip install --upgrade pip
echo [Setup] Installing backend\requirements-lock.txt ...
"%VENV_PY%" -m pip install -r backend\requirements-lock.txt
if errorlevel 1 goto :fail

"%VENV_PY%" -c "import fastapi, uvicorn, PIL, yaml, resvg_py, sys; print('[Setup] Python', sys.version.split()[0], '/ fastapi', fastapi.__version__)"
if errorlevel 1 goto :fail

echo [Setup] Done. Start the app with start.bat
if not defined NOPAUSE pause
exit /b 0

:fail
echo [Setup] Setup failed. See the messages above.
if not defined NOPAUSE pause
exit /b 1
