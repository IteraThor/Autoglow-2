@echo off
setlocal
cd /d "%~dp0"
title AutoGlow Setup
echo =============================================
echo       AutoGlow Setup for Windows            
echo =============================================
echo.

:: Check if Python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed or not in PATH.
    echo Please install Python 3.10+ from https://www.python.org/ and check "Add Python to PATH".
    pause
    exit /b 1
)
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"
if %errorlevel% neq 0 (
    echo [ERROR] AutoGlow needs Python 3.10 or newer. Found:
    python --version
    echo Please install a current Python from https://www.python.org/ and run setup.bat again.
    pause
    exit /b 1
)

:: Create virtual environment
if not exist "venv\Scripts\activate.bat" (
    echo --> Creating Python virtual environment...
    python -m venv venv
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to create virtual environment.
        pause
        exit /b 1
    )
) else (
    echo --> Virtual environment already exists.
)

:: Activate venv and install requirements
echo --> Activating environment and installing requirements...
call "%~dp0venv\Scripts\activate.bat"
"%~dp0venv\Scripts\python.exe" -m pip install --upgrade pip setuptools wheel
"%~dp0venv\Scripts\python.exe" -m pip install -r "%~dp0requirements.txt"
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to install dependencies from requirements.txt.
    pause
    exit /b 1
)

echo.
echo =============================================
echo       Setup Completed Successfully!          
echo =============================================
echo.
echo To start AutoGlow:
echo   1. Double-click "run_autoglow.bat" to start the application.
echo   2. Open http://localhost:8080 in your browser to configure.
echo.
echo Autodarts game events come from the AutoGlow Bridge Chrome extension:
echo   1. In Chrome open chrome://extensions and switch on "Developer mode".
echo   2. Click "Load unpacked" and select this folder:
echo      %~dp0chrome_extension
echo   3. Play on https://play.autodarts.com - the extension icon shows ON when linked.
echo.
set /p choice="Would you like to start AutoGlow now? (Y/N): "
if /i "%choice%"=="Y" (
    echo --> Starting AutoGlow...
    python "%~dp0server.py"
)
