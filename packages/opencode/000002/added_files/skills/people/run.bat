@echo off
rem Run people_cli.py. It needs only the standard library, so it works without the venv too.
rem This file must stay ASCII only (cmd.exe on Japanese Windows may misread other characters).
setlocal
set "PY=%~dp0..\..\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%~dp0scripts\people_cli.py" %*
exit /b %ERRORLEVEL%
