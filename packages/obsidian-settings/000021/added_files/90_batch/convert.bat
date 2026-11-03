@echo off
:: Set character code page to UTF-8 to prevent Japanese file path errors
chcp 65001 > nul

:: ==========================================
:: Pandoc executable path configuration
:: If pandoc is in your system PATH, leave it as "pandoc".
:: Otherwise, set the absolute path (e.g., set PANDOC_EXE="C:\Program Files\Pandoc\pandoc.exe")
:: ==========================================
set PANDOC_EXE=pandoc

:: Style template (reference.docx) path relative to this batch file
set "REFERENCE_DOCX=%~dp0..\01_data\reference.docx"

:: Check if input file is provided via drag-and-drop
if "%~1" == "" (
    echo [ERROR] Please drag and drop an HTML file onto this batch file to convert.
    echo.
    echo Usage:
    echo   convert.bat [input_html_file_path]
    echo.
    pause
    exit /b 1
)

set "INPUT_HTML=%~1"
set "OUTPUT_DOCX=%~dpn1.docx"

echo "Input HTML:  %INPUT_HTML%"
echo "Output Word: %OUTPUT_DOCX%"
echo Converting...

:: Run Pandoc conversion
%PANDOC_EXE% -s -f html -t docx "%INPUT_HTML%" -o "%OUTPUT_DOCX%" --reference-doc="%REFERENCE_DOCX%"

if %ERRORLEVEL% equ 0 (
    echo.
    echo [SUCCESS] Word document successfully generated!
) else (
    echo.
    echo [ERROR] Conversion failed. Please check Pandoc path and input file.
)

pause
