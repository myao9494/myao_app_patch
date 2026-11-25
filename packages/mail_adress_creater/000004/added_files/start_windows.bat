@echo off
setlocal
cd /d "%~dp0"

rem The backend always runs with .venv (Python 3.14). When .venv is missing,
rem create it with setup_windows.bat (pip only; the company PC has no uv).
set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"
if not exist "%PYTHON_EXE%" call "%~dp0setup_windows.bat" /nopause
if not exist "%PYTHON_EXE%" (
  echo .venv could not be prepared. Run setup_windows.bat and check the messages.
  goto error
)

if "%OUTLOOK_ADDRESS_HOST%"=="" set "OUTLOOK_ADDRESS_HOST=127.0.0.1"
if "%OUTLOOK_ADDRESS_PORT%"=="" set "OUTLOOK_ADDRESS_PORT=8765"
if "%OUTLOOK_ADDRESS_OPEN_BROWSER%"=="" set "OUTLOOK_ADDRESS_OPEN_BROWSER=1"

if not exist dist\index.html (
  echo dist\index.html was not found. Building frontend...
  call npm ci
  if errorlevel 1 goto error
  call npm run build
  if errorlevel 1 goto error
)

echo Checking port %OUTLOOK_ADDRESS_PORT%...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%OUTLOOK_ADDRESS_PORT% .*LISTENING"') do (
  echo Port %OUTLOOK_ADDRESS_PORT% is already in use by PID %%P. Stopping it...
  taskkill /PID %%P /T /F >nul 2>&1
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-Process -Id %%P -Force -ErrorAction SilentlyContinue" >nul 2>&1
)

for /l %%I in (1,1,30) do (
  netstat -ano | findstr /R /C:":%OUTLOOK_ADDRESS_PORT% .*LISTENING" >nul
  if errorlevel 1 goto port_ready
  ping -n 2 127.0.0.1 >nul
)

:port_ready
netstat -ano | findstr /R /C:":%OUTLOOK_ADDRESS_PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo Port %OUTLOOK_ADDRESS_PORT% is still in use.
  goto error
)

echo Starting Outlook address maker on http://%OUTLOOK_ADDRESS_HOST%:%OUTLOOK_ADDRESS_PORT% ...
rem Check that the backend can be imported first, so a broken install shows its error here.
"%PYTHON_EXE%" -c "import backend.server"
if errorlevel 1 (
  echo Backend import failed. See the error above. Run setup_windows.bat again if a module is missing.
  goto error
)

start "Outlook Address Maker Backend" /min "%PYTHON_EXE%" backend\server.py

powershell -NoProfile -ExecutionPolicy Bypass -Command "for ($i = 0; $i -lt 20; $i++) { try { $response = Invoke-WebRequest -UseBasicParsing 'http://%OUTLOOK_ADDRESS_HOST%:%OUTLOOK_ADDRESS_PORT%/api/health' -TimeoutSec 1; if ($response.StatusCode -eq 200) { exit 0 } } catch { Start-Sleep -Milliseconds 500 } }; exit 1"
if errorlevel 1 (
  echo Backend did not start on port %OUTLOOK_ADDRESS_PORT%.
  echo Running it in this window to show the error. Close this window to stop it.
  "%PYTHON_EXE%" backend\server.py
  goto error
)
echo Backend is ready.

if not "%OUTLOOK_ADDRESS_OPEN_BROWSER%"=="0" start "" "http://%OUTLOOK_ADDRESS_HOST%:%OUTLOOK_ADDRESS_PORT%"
goto end

:error
echo Failed to start.
pause

:end
endlocal
