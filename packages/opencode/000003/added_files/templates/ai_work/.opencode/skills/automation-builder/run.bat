@echo off
rem Run new_automation.py (scaffold and list the automations in AI_work). Standard library only.
rem Uses the AI_work .venv when it exists, otherwise python.
rem This file must stay ASCII only (cmd.exe on Japanese Windows may misread other characters).
setlocal
set "PY=%~dp0..\..\..\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%~dp0scripts\new_automation.py" %*
exit /b %ERRORLEVEL%
