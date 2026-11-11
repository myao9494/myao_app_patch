@echo off
rem Run scripts\main.py (check AI_work and print today's date) with the AI_work .venv, or python.
rem This file must stay ASCII only (cmd.exe on Japanese Windows may misread other characters).
setlocal
set "PY=%~dp0..\..\..\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%~dp0scripts\main.py" %*
exit /b %ERRORLEVEL%
