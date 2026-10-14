@echo off
chcp 65001 > nul
setlocal EnableExtensions

REM サーバー一括起動スクリプト（Windows用）
REM バックエンドサーバー1つでAPI＋フロントエンド（PWA）を配信

echo === Excalidraw サーバーの起動を開始します ===

REM プロジェクトディレクトリに移動
cd /d %~dp0
set "ROOT_DIR=%CD%"

REM 変更の反映忘れを防ぐため、ビルド可能な環境では常にフロントエンドをビルドする。
REM npm または node_modules がない環境（ビルドできない社内PCなど）では、
REM git管理されているビルド済み dist\ をそのまま配信する。
set "CAN_BUILD="
where npm > nul 2>&1
if not errorlevel 1 if exist "%ROOT_DIR%\node_modules\" set "CAN_BUILD=1"

if defined CAN_BUILD (
  echo フロントエンドのビルドを実行しています...
  call npm run build
  if errorlevel 1 (
    echo ビルドに失敗しました。
    exit /b 1
  )
) else (
  if not exist "%ROOT_DIR%\dist\index.html" (
    echo エラー: ビルド環境がなく、ビルド済みの dist\index.html も見つかりません。
    exit /b 1
  )
  echo npm または node_modules が見つからないため、ビルド済みの dist\ を使用します。
)

REM ビルド成功後にport 3001の既存待受プロセスを終了する
for /f "tokens=5" %%P in ('netstat -aon ^| findstr ":3001 " ^| findstr "LISTENING"') do (
  echo Port 3001 の既存プロセスを停止します ^(PID: %%P^)...
  taskkill /PID %%P /T /F > nul 2>&1
)

REM taskkill直後の解放待ち（最大5秒）
for /L %%I in (1,1,5) do (
  set "PORT_STILL_USED="
  for /f "tokens=5" %%P in ('netstat -aon ^| findstr ":3001 " ^| findstr "LISTENING"') do set "PORT_STILL_USED=%%P"
  if not defined PORT_STILL_USED goto port_free
  timeout /t 1 /nobreak > nul
)
echo エラー: Port 3001 を解放できませんでした。
exit /b 1

:port_free

REM 利用する Python を決定
set "PYTHON_EXE="
if exist "%ROOT_DIR%\backend\.venv\Scripts\python.exe" set "PYTHON_EXE=%ROOT_DIR%\backend\.venv\Scripts\python.exe"
if not defined PYTHON_EXE if exist "%ROOT_DIR%\backend\venv\Scripts\python.exe" set "PYTHON_EXE=%ROOT_DIR%\backend\venv\Scripts\python.exe"
if not defined PYTHON_EXE if exist "%ROOT_DIR%\.venv\Scripts\python.exe" set "PYTHON_EXE=%ROOT_DIR%\.venv\Scripts\python.exe"
if not defined PYTHON_EXE if exist "%ROOT_DIR%\venv\Scripts\python.exe" set "PYTHON_EXE=%ROOT_DIR%\venv\Scripts\python.exe"
if not defined PYTHON_EXE set "PYTHON_EXE=python"

REM Pythonと必須モジュールを起動前に確認する
"%PYTHON_EXE%" -c "import fastapi, uvicorn, lzstring, multipart" > nul 2>&1
if errorlevel 1 (
  echo エラー: 利用可能なPythonまたは必須Pythonモジュールを確認できませんでした。
  echo 使用候補: "%PYTHON_EXE%"
  exit /b 1
)

echo サーバーを起動中... (port 3001)
REM /Dと引用符により、プロジェクトパスに空白があっても起動できる
start "Excalidraw Server" /D "%ROOT_DIR%\backend" "%PYTHON_EXE%" -m uvicorn main:app --host 0.0.0.0 --port 3001
if errorlevel 1 (
  echo エラー: サーバープロセスを開始できませんでした。
  exit /b 1
)

REM Windows標準PowerShellで、実際にHTTP応答するまで最大30秒待つ
for /L %%I in (1,1,30) do (
  powershell.exe -NoProfile -NonInteractive -Command "try { $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3001/' -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 }; exit 1 } catch { exit 1 }" > nul 2>&1
  if not errorlevel 1 goto server_ready
  timeout /t 1 /nobreak > nul
)
echo エラー: サーバーが30秒以内に応答しませんでした。
exit /b 1

:server_ready
echo.
echo === サーバー起動完了 ===
echo アプリケーション: http://localhost:3001
echo バックエンド API: http://localhost:3001/api/
echo.
echo ※ PWA対応: バックエンドからフロントエンドを配信
echo 停止するには起動したウィンドウを閉じてください
echo.
pause
